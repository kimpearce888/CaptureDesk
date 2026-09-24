// CaptureDesk engine — Windows capture implementation.
//
// - Screen/window frames via Windows.Graphics.Capture (C++/WinRT)
// - Mic + system audio via WASAPI shared-mode (capture / render-loopback)
// - Camera PiP via a Media Foundation source reader
// - Global click ripples via a low-level mouse hook
// - Source enumeration with GDI/WIC thumbnails for the dashboard picker
//
// The composed RGBA stream (capture + cursor ring + ripples + camera card)
// is fed to the FFmpeg encoder at capture rate.

#include "capture_internal.h"
#include "encoder.h"

#include <Windows.h>
#include <audioclient.h>
#include <d3d11.h>
#include <dwmapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mmdeviceapi.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.UI.h>

#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

namespace cde {

namespace {

using namespace winrt;
namespace wf = winrt::Windows::Foundation;
namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd = winrt::Windows::Graphics::DirectX;
namespace wgd11 = winrt::Windows::Graphics::DirectX::Direct3D11;

// ---------------------------------------------------------------------------
// base64 (thumbnails)
// ---------------------------------------------------------------------------

std::string b64_encode(const uint8_t* data, size_t len) {
    static const char* table =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((len + 2) / 3 * 4);
    for (size_t i = 0; i < len; i += 3) {
        const uint32_t n = static_cast<uint32_t>((data[i] << 16) |
                                                 (i + 1 < len ? data[i + 1] << 8 : 0) |
                                                 (i + 2 < len ? data[i + 2] : 0));
        out += table[(n >> 18) & 63];
        out += table[(n >> 12) & 63];
        out += i + 1 < len ? table[(n >> 6) & 63] : '=';
        out += i + 2 < len ? table[n & 63] : '=';
    }
    return out;
}

// ---------------------------------------------------------------------------
// D3D11 device + WGC frame pump
// ---------------------------------------------------------------------------

struct DxPack {
    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* context = nullptr;
    wf::IInspectable winrt_device{nullptr};

    bool init() {
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        D3D_FEATURE_LEVEL fl{};
        if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
                                     nullptr, 0, D3D11_SDK_VERSION, &device, &fl,
                                     &context))) {
            return false;
        }
        Microsoft::WRL::ComPtr<IDXGIDevice> dxgi;
        if (FAILED(device->QueryInterface(IID_PPV_ARGS(dxgi.GetAddressOf())))) return false;
        Microsoft::WRL::ComPtr<IUnknown> unk;
        if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), unk.GetAddressOf()))) {
            return false;
        }
        winrt_device = unk.Get();
        return winrt_device != nullptr;
    }
};

/// Continuously pumps WGC frames of one monitor/window into an RGBA buffer.
class ScreenWGC {
public:
    using FrameFn = std::function<void(const uint8_t* rgba, int w, int h)>;

    ~ScreenWGC() { stop(); }

    bool start(const std::string& mode, const std::string& source_id,
               LONG& origin_x, LONG& origin_y, FrameFn on_frame) {
        if (!dx_.init()) return false;

        wgc::GraphicsCaptureItem item{nullptr};
        if (mode == "window") {
            const uint64_t hwnd_val = std::strtoull(source_id.c_str(), nullptr, 0);
            RECT wr{};
            if (!hwnd_val || !GetWindowRect(reinterpret_cast<HWND>(hwnd_val), &wr)) return false;
            origin_x = wr.left;
            origin_y = wr.top;
            try {
                const winrt::Windows::UI::WindowId wid{hwnd_val};
                item = wgc::GraphicsCaptureItem::TryCreateFromWindowId(wid);
            } catch (...) {
                return false; // requires Windows 11 or newer builds
            }
        } else {
            HMONITOR hmon = pick_monitor(source_id);
            if (!hmon) return false;
            MONITORINFO mi{sizeof(MONITORINFO)};
            GetMonitorInfoW(hmon, &mi);
            origin_x = mi.rcMonitor.left;
            origin_y = mi.rcMonitor.top;
            auto factory = get_activation_factory<
                wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
            const GUID iid = guid_of<wgc::GraphicsCaptureItem>();
            const HRESULT hr = factory->CreateForMonitor(hmon, iid, put_abi(item));
            if (FAILED(hr) || !item) return false;
        }
        if (!item) return false;

        item_ = item;
        const auto size = item_.Size();
        on_frame_ = std::move(on_frame);

        pool_ = wgc::Direct3D11CaptureFramePool::Create(
            dx_.winrt_device.as<wgd11::IDirect3DDevice>(),
            wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
        session_ = pool_.CreateCaptureSession(item_);
        try {
            session_.IsCursorCaptureEnabled(false); // we draw our own ring
        } catch (...) {
            // Older builds always capture the cursor; acceptable.
        }
        token_ = pool_.FrameArrived([this](auto&&, auto&&) { on_frame_arrived(); });
        session_.StartCapture();
        return true;
    }

    void stop() {
        if (pool_) {
            pool_.FrameArrived(token_);
            pool_ = nullptr;
        }
        if (session_) {
            try { session_.Close(); } catch (...) {}
            session_ = nullptr;
        }
        item_ = nullptr;
        if (staging_) {
            staging_->Release();
            staging_ = nullptr;
        }
    }

private:
    void on_frame_arrived() {
        wgc::Direct3D11CaptureFrame frame = pool_.TryGetNextFrame();
        if (!frame) return;
        auto access = frame.Surface().as<
            wgd11::IDirect3DDxgiInterfaceAccess>();
        Microsoft::WRL::ComPtr<ID3D11Texture2D> tex;
        if (FAILED(access->GetInterface(IID_PPV_ARGS(tex.GetAddressOf())))) return;

        D3D11_TEXTURE2D_DESC desc{};
        tex->GetDesc(&desc);
        if (!staging_ || staging_desc_.Width != desc.Width ||
            staging_desc_.Height != desc.Height) {
            D3D11_TEXTURE2D_DESC sd = desc;
            sd.Usage = D3D11_USAGE_STAGING;
            sd.BindFlags = 0;
            sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            sd.MiscFlags = 0;
            if (staging_) staging_->Release();
            if (FAILED(dx_.device->CreateTexture2D(&sd, nullptr, &staging_))) return;
            staging_desc_ = sd;
            cpu_.resize(static_cast<size_t>(sd.Width) * sd.Height * 4);
        }
        dx_.context->CopyResource(staging_, tex.Get());
        D3D11_MAPPED_SUBRESOURCE mapped{};
        if (FAILED(dx_.context->Map(staging_, 0, D3D11_MAP_READ, 0, &mapped))) return;
        const int w = static_cast<int>(desc.Width);
        const int h = static_cast<int>(desc.Height);
        for (int y = 0; y < h; ++y) {
            const uint8_t* row =
                reinterpret_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch;
            uint8_t* dst = cpu_.data() + static_cast<size_t>(y) * w * 4;
            for (int x = 0; x < w; ++x) { // BGRA → RGBA
                dst[x * 4 + 0] = row[x * 4 + 2];
                dst[x * 4 + 1] = row[x * 4 + 1];
                dst[x * 4 + 2] = row[x * 4 + 0];
                dst[x * 4 + 3] = 255;
            }
        }
        dx_.context->Unmap(staging_, 0);
        if (on_frame_) on_frame_(cpu_.data(), w, h);
    }

    static HMONITOR pick_monitor(const std::string& id) {
        struct Ctx {
            int index = 0;
            int want = 0;
            HMONITOR hmon = nullptr;
        } ctx;
        if (id.rfind("screen:", 0) == 0) ctx.want = std::atoi(id.c_str() + 7);
        EnumDisplayMonitors(
            nullptr, nullptr,
            [](HMONITOR hmon, HDC, LPRECT, LPARAM lp) -> BOOL {
                auto* c = reinterpret_cast<Ctx*>(lp);
                if (c->index++ == c->want) c->hmon = hmon;
                return TRUE;
            },
            reinterpret_cast<LPARAM>(&ctx));
        return ctx.hmon;
    }

    DxPack dx_;
    wgc::GraphicsCaptureItem item_{nullptr};
    wgc::Direct3D11CaptureFramePool pool_{nullptr};
    wgc::GraphicsCaptureSession session_{nullptr};
    winrt::event_token token_{};
    ID3D11Texture2D* staging_ = nullptr;
    D3D11_TEXTURE2D_DESC staging_desc_{};
    std::vector<uint8_t> cpu_;
    FrameFn on_frame_;
};

/// WASAPI shared-mode capture (microphone or render-loopback).
class WasapiCapture {
public:
    using AudioFn = std::function<void(const float*, int, int, int)>;

    ~WasapiCapture() { stop(); }

    bool start(bool loopback, AudioFn on_audio) {
        Microsoft::WRL::ComPtr<IMMDeviceEnumerator> en;
        if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                    IID_PPV_ARGS(en.GetAddressOf())))) {
            return false;
        }
        Microsoft::WRL::ComPtr<IMMDevice> dev;
        if (FAILED(en->GetDefaultAudioEndpoint(loopback ? eRender : eCapture, eConsole,
                                               dev.GetAddressOf()))) {
            return false;
        }
        Microsoft::WRL::ComPtr<IAudioClient> client;
        if (FAILED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                 reinterpret_cast<void**>(client.GetAddressOf())))) {
            return false;
        }
        WAVEFORMATEX* wfx = nullptr;
        if (FAILED(client->GetMixFormat(&wfx))) return false;
        const DWORD flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                            (loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0);
        HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, wfx, nullptr);
        if (FAILED(hr)) {
            CoTaskMemFree(wfx);
            return false;
        }
        Microsoft::WRL::ComPtr<IAudioCaptureClient> cap;
        if (FAILED(client->GetService(IID_PPV_ARGS(cap.GetAddressOf())))) {
            CoTaskMemFree(wfx);
            return false;
        }
        channels_ = wfx->nChannels;
        rate_ = wfx->nSamplesPerSec;
        CoTaskMemFree(wfx);
        if (FAILED(client->Start())) return false;

        client_ = client;
        capture_ = cap;
        running_ = true;
        worker_ = std::thread([this, on_audio] {
            const bool com_here = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
            while (running_.load()) {
                Sleep(4);
                UINT32 packet = 0;
                while (capture_->GetNextPacketSize(&packet) == S_OK && packet > 0) {
                    BYTE* data = nullptr;
                    UINT32 frames = 0;
                    DWORD flags = 0;
                    if (capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr) != S_OK) break;
                    if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data && frames > 0) {
                        on_audio(reinterpret_cast<const float*>(data),
                                 static_cast<int>(frames), channels_, rate_);
                    }
                    capture_->ReleaseBuffer(frames);
                }
            }
            if (com_here) CoUninitialize();
        });
        return true;
    }

    void stop() {
        running_ = false;
        if (worker_.joinable()) worker_.join();
        if (client_) {
            client_->Stop();
            client_ = nullptr;
        }
        capture_ = nullptr;
    }

private:
    Microsoft::WRL::ComPtr<IAudioClient> client_;
    Microsoft::WRL::ComPtr<IAudioCaptureClient> capture_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    int channels_ = 2;
    int rate_ = 48000;
};

/// Media Foundation camera reader (RGB32 → RGBA).
class CameraCapture {
public:
    using FrameFn = std::function<void(const uint8_t*, int, int)>;

    ~CameraCapture() { stop(); }

    bool start(FrameFn on_frame) {
        const HRESULT hr = MFStartup(MF_VERSION);
        if (FAILED(hr) && hr != MF_E_ALREADY_INITIALIZED) return false;
        Microsoft::WRL::ComPtr<IMFAttributes> attrs;
        if (FAILED(MFCreateAttributes(attrs.GetAddressOf(), 1))) return false;
        if (FAILED(attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                                  MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID))) {
            return false;
        }
        IMFActivate** acts = nullptr;
        UINT32 count = 0;
        if (FAILED(MFEnumDeviceSources(attrs.Get(), &acts, &count)) || count == 0) {
            return false;
        }
        Microsoft::WRL::ComPtr<IMFMediaSource> src;
        const HRESULT ahr = acts[0]->ActivateObject(IID_PPV_ARGS(src.GetAddressOf()));
        CoTaskMemFree(acts);
        if (FAILED(ahr)) return false;

        Microsoft::WRL::ComPtr<IMFSourceReader> reader;
        if (FAILED(MFCreateSourceReaderFromMediaSource(src.Get(), nullptr, reader.GetAddressOf()))) {
            return false;
        }
        Microsoft::WRL::ComPtr<IMFMediaType> type;
        if (FAILED(MFCreateMediaType(type.GetAddressOf()))) return false;
        type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
        reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, type.Get());

        Microsoft::WRL::ComPtr<IMFMediaType> cur;
        if (SUCCEEDED(reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                                                  cur.GetAddressOf()))) {
            UINT32 w = 0, h = 0;
            if (SUCCEEDED(MFGetAttributeSize(cur.Get(), MF_MT_FRAME_SIZE, &w, &h)) && w && h) {
                cam_w_ = static_cast<int>(w);
                cam_h_ = static_cast<int>(h);
                cpu_.resize(static_cast<size_t>(cam_w_) * cam_h_ * 4);
            }
        }
        if (!cam_w_) return false;

        reader_ = reader;
        running_ = true;
        worker_ = std::thread([this, on_frame] {
            while (running_.load()) {
                DWORD stream = 0, flags = 0;
                Microsoft::WRL::ComPtr<IMFSample> sample;
                if (reader_->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &stream,
                                        &flags, nullptr, sample.GetAddressOf()) != S_OK) {
                    Sleep(10);
                    continue;
                }
                if (!sample) {
                    Sleep(5);
                    continue;
                }
                Microsoft::WRL::ComPtr<IMFMediaBuffer> buf;
                if (FAILED(sample->ConvertToContiguousBuffer(buf.GetAddressOf()))) continue;
                BYTE* data = nullptr;
                DWORD max_len = 0, cur_len = 0;
                if (FAILED(buf->Lock(&data, &max_len, &cur_len))) continue;
                if (cur_len >= static_cast<DWORD>(cam_w_ * cam_h_ * 4)) {
                    // RGB32 is bottom-up BGRA → flip and convert to RGBA.
                    for (int y = 0; y < cam_h_; ++y) {
                        const uint8_t* row =
                            data + static_cast<size_t>(cam_h_ - 1 - y) * cam_w_ * 4;
                        uint8_t* out = cpu_.data() + static_cast<size_t>(y) * cam_w_ * 4;
                        for (int x = 0; x < cam_w_; ++x) {
                            out[x * 4 + 0] = row[x * 4 + 2];
                            out[x * 4 + 1] = row[x * 4 + 1];
                            out[x * 4 + 2] = row[x * 4 + 0];
                            out[x * 4 + 3] = 255;
                        }
                    }
                    on_frame(cpu_.data(), cam_w_, cam_h_);
                }
                buf->Unlock();
            }
        });
        return true;
    }

    void stop() {
        running_ = false;
        if (worker_.joinable()) worker_.join();
        reader_ = nullptr;
        MFShutdown();
    }

private:
    Microsoft::WRL::ComPtr<IMFSourceReader> reader_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    int cam_w_ = 0;
    int cam_h_ = 0;
    std::vector<uint8_t> cpu_;
};

// ---------------------------------------------------------------------------
// Global click hook → ripples
// ---------------------------------------------------------------------------

struct ClickHub {
    std::mutex m;
    std::vector<compose::Ripple> ripples;
    std::atomic<bool> running{false};
    HHOOK hook = nullptr;
    std::thread pump;

    static ClickHub& get() {
        static ClickHub hub;
        return hub;
    }

    static LRESULT CALLBACK low_level(int code, WPARAM wp, LPARAM lp) {
        if (code == HC_ACTION && (wp == WM_LBUTTONDOWN || wp == WM_RBUTTONDOWN)) {
            auto* info = reinterpret_cast<MSLLHOOKSTRUCT*>(lp);
            auto& hub = get();
            std::lock_guard<std::mutex> lk(hub.m);
            hub.ripples.push_back({static_cast<int>(info->pt.x), static_cast<int>(info->pt.y),
                                   std::chrono::steady_clock::now()});
        }
        return CallNextHookEx(nullptr, code, wp, lp);
    }

    void start() {
        if (running_.exchange(true)) return;
        pump = std::thread([this] {
            const bool com_here = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
            hook = SetWindowsHookExW(WH_MOUSE_LL, low_level, GetModuleHandleW(nullptr), 0);
            MSG msg;
            while (running_.load() && GetMessageW(&msg, nullptr, 0, 0) > 0) {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if (hook) UnhookWindowsHookEx(hook);
            hook = nullptr;
            if (com_here) CoUninitialize();
        });
    }

    void stop() {
        running_ = false;
        if (pump.joinable()) {
            PostThreadMessageW(GetThreadId(pump.native_handle()), WM_QUIT, 0, 0);
            pump.join();
        }
    }

private:
    std::atomic<bool> running_{false};
};

// ---------------------------------------------------------------------------
// PNG thumbnail (GDI/PrintWindow snapshot → WIC PNG → base64 data URL)
// ---------------------------------------------------------------------------

std::string thumbnail_png_b64(RECT rc, HWND hwnd = nullptr) {
    const int w = rc.right - rc.left;
    const int h = rc.bottom - rc.top;
    if (w <= 0 || h <= 0) return "";
    HDC screen = GetDC(nullptr);
    HDC mem = CreateCompatibleDC(screen);
    HBITMAP bmp = CreateCompatibleBitmap(screen, w, h);
    HGDIOBJ old = SelectObject(mem, bmp);
    if (hwnd) {
        PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT);
    } else {
        BitBlt(mem, 0, 0, w, h, screen, rc.left, rc.top, SRCCOPY);
    }
    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 4);
    GetDIBits(mem, bmp, 0, h, pixels.data(), &bi, DIB_RGB_COLORS);
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);

    const int tw = std::min(352, w);
    const int th = std::max(1, h * tw / w);
    std::vector<uint8_t> thumb(static_cast<size_t>(tw) * th * 4);
    for (int y = 0; y < th; ++y) {
        for (int x = 0; x < tw; ++x) {
            std::memcpy(thumb.data() + (static_cast<size_t>(y) * tw + x) * 4,
                        pixels.data() + (static_cast<size_t>(y * h / th) * w + x * w / tw) * 4, 4);
        }
    }

    Microsoft::WRL::ComPtr<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(factory.GetAddressOf())))) {
        return "";
    }
    Microsoft::WRL::ComPtr<IStream> stream;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, stream.GetAddressOf()))) return "";
    Microsoft::WRL::ComPtr<IWICBitmapEncoder> enc;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, enc.GetAddressOf()))) {
        return "";
    }
    if (FAILED(enc->Initialize(stream.Get(), WICBitmapEncoderNoCache))) return "";
    Microsoft::WRL::ComPtr<IWICBitmapFrameEncode> frame;
    Microsoft::WRL::ComPtr<IPropertyBag2> props;
    if (FAILED(enc->CreateNewFrame(frame.GetAddressOf(), props.GetAddressOf()))) return "";
    if (FAILED(frame->Initialize(props.Get()))) return "";
    if (FAILED(frame->SetSize(tw, th))) return "";
    WICPixelFormatGUID fmt = GUID_WICPixelFormat32bppRGBA;
    if (FAILED(frame->SetPixelFormat(&fmt))) return "";
    if (FAILED(frame->WritePixels(th, tw * 4, static_cast<UINT>(thumb.size()), thumb.data()))) {
        return "";
    }
    if (FAILED(frame->Commit()) || FAILED(enc->Commit())) return "";

    HGLOBAL hg = nullptr;
    if (FAILED(GetHGlobalFromStream(stream.Get(), &hg))) return "";
    const SIZE_T size = GlobalSize(hg);
    const uint8_t* bytes = static_cast<const uint8_t*>(GlobalLock(hg));
    std::string b64 = b64_encode(bytes, size);
    GlobalUnlock(hg);
    return "data:image/png;base64," + b64;
}

std::string window_title(HWND hwnd) {
    const int len = GetWindowTextLengthW(hwnd);
    if (len <= 0) return "";
    std::wstring w(static_cast<size_t>(len) + 1, L'\0');
    GetWindowTextW(hwnd, w.data(), len + 1);
    const int need = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string out(need > 0 ? need - 1 : 0, '\0');
    if (need > 0) {
        WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, out.data(), need, nullptr, nullptr);
    }
    return out;
}

bool is_cloaked(HWND hwnd) {
    DWORD cloaked = 0;
    return SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) &&
           cloaked != 0;
}

} // namespace

// ---------------------------------------------------------------------------
// list-sources
// ---------------------------------------------------------------------------

json list_sources_impl(const json& kinds) {
    const bool com_here = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    json sources = json::array();

    if (kinds.value("screens", true)) {
        struct Ctx {
            json* out;
            int index = 0;
        } ctx{&sources};
        EnumDisplayMonitors(
            nullptr, nullptr,
            [](HMONITOR, HDC, LPRECT rc, LPARAM lp) -> BOOL {
                auto* c = reinterpret_cast<Ctx*>(lp);
                json src = {
                    {"id", "screen:" + std::to_string(c->index)},
                    {"name", "Screen " + std::to_string(c->index + 1) + " (" +
                                 std::to_string(rc->right - rc->left) + "x" +
                                 std::to_string(rc->bottom - rc->top) + ")"},
                    {"kind", "screen"},
                    {"thumb", thumbnail_png_b64(*rc)},
                };
                c->out->push_back(src);
                c->index++;
                return TRUE;
            },
            reinterpret_cast<LPARAM>(&ctx));
    }

    if (kinds.value("windows", true)) {
        struct WCtx {
            json* out;
        } wctx{&sources};
        EnumWindows(
            [](HWND hwnd, LPARAM lp) -> BOOL {
                auto* c = reinterpret_cast<WCtx*>(lp);
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return TRUE;
                if (is_cloaked(hwnd)) return TRUE;
                if (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE;
                const std::string title = window_title(hwnd);
                if (title.empty()) return TRUE;
                RECT rc{};
                if (!GetWindowRect(hwnd, &rc) || rc.right - rc.left < 120 ||
                    rc.bottom - rc.top < 80) {
                    return TRUE;
                }
                std::ostringstream id;
                id << "window:0x" << std::hex << reinterpret_cast<uintptr_t>(hwnd);
                json src = {
                    {"id", id.str()},
                    {"name", title},
                    {"kind", "window"},
                    {"thumb", thumbnail_png_b64(rc, hwnd)},
                };
                c->out->push_back(src);
                return TRUE;
            },
            reinterpret_cast<LPARAM>(&wctx));
    }

    if (com_here) CoUninitialize();
    return json({{"ok", true}, {"sources", sources}});
}

// ---------------------------------------------------------------------------
// run_capture_session
// ---------------------------------------------------------------------------

bool run_capture_session(
    const StartParams& p,
    const std::atomic<bool>& stop,
    const std::atomic<bool>& pause,
    const std::atomic<bool>& cancel,
    std::chrono::steady_clock::time_point t0,
    uint64_t& paused_total_ms,
    const std::function<void(const std::string&, uint64_t)>& on_state,
    const std::function<void(uint64_t)>& on_tick) {
    (void)on_tick;
    const bool com_here = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));

    ScreenWGC screen;
    WasapiCapture loopback;
    WasapiCapture mic;
    CameraCapture camera;
    ClickHub& clicks = ClickHub::get();

    // Latest capture state (guarded by latest_m).
    std::vector<uint8_t> latest;
    std::vector<uint8_t> cam_frame;
    std::mutex latest_m;
    int frame_w = 0, frame_h = 0;
    int cam_w = 0, cam_h = 0;
    LONG cap_origin_x = 0, cap_origin_y = 0;

    screen.start(p.mode, p.sourceId, cap_origin_x, cap_origin_y,
                 [&](const uint8_t* rgba, int w, int h) {
                     std::lock_guard<std::mutex> lk(latest_m);
                     latest.resize(static_cast<size_t>(w) * h * 4);
                     std::memcpy(latest.data(), rgba, latest.size());
                     frame_w = w;
                     frame_h = h;
                 });

    // Wait briefly for the first frame so the encoder gets real dimensions.
    for (int i = 0; i < 75 && frame_w == 0 && !stop.load(); ++i) {
        Sleep(20);
    }
    bool ok = frame_w > 0;
    int src_w = frame_w;
    int src_h = frame_h;
    if (ok && p.mode == "region" && p.rect.is_object()) {
        src_w = p.rect.value("width", src_w);
        src_h = p.rect.value("height", src_h);
    }
    src_w = std::max(2, src_w & ~1);
    src_h = std::max(2, src_h & ~1);

    std::unique_ptr<Encoder> enc;
    if (ok) {
        enc = Encoder::open(p.out, src_w, src_h, p.fps, p.mic || p.systemAudio, p.quality);
        ok = enc && enc->valid();
    }

    if (ok && p.systemAudio) {
        loopback.start(true, [&enc](const float* a, int f, int c, int r) {
            enc->write_audio_f32(a, f, c, r);
        });
    }
    if (ok && p.mic) {
        mic.start(false, [&enc](const float* a, int f, int c, int r) {
            enc->write_audio_f32(a, f, c, r);
        });
    }
    if (ok && p.camera) {
        camera.start([&](const uint8_t* rgba, int w, int h) {
            std::lock_guard<std::mutex> lk(latest_m);
            cam_frame.assign(rgba, rgba + static_cast<size_t>(w) * h * 4);
            cam_w = w;
            cam_h = h;
        });
    }
    if (ok && p.clickHighlight) clicks.start();

    uint8_t ring[4];
    hex_to_rgba(p.ringColor, ring);

    auto frame_clock = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point pause_started{};
    bool paused_now = false;
    uint64_t last_state_ms = 0;
    const auto frame_dt = std::chrono::microseconds(1'000'000 / std::max(5, p.fps));

    while (ok && !stop.load()) {
        frame_clock += frame_dt;
        std::this_thread::sleep_until(frame_clock);
        if (pause.load()) {
            if (!paused_now) {
                paused_now = true;
                pause_started = std::chrono::steady_clock::now();
                on_state("paused", last_state_ms);
            }
            continue;
        }
        if (paused_now) {
            paused_now = false;
            paused_total_ms += static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - pause_started)
                    .count());
            on_state("recording", last_state_ms);
        }

        // Snapshot the latest frame under lock; compose outside the lock.
        std::vector<uint8_t> composed;
        int w = 0, h = 0;
        {
            std::lock_guard<std::mutex> lk(latest_m);
            if (latest.empty()) continue;
            composed = latest;
            w = frame_w;
            h = frame_h;
        }

        // Region crop first; overlays then land on the active buffer.
        const uint8_t* src_view = composed.data();
        std::vector<uint8_t> scratch;
        int stride = w * 4;
        if (!compose::crop_to_region(src_view, w, h, p.rect, scratch, stride)) continue;
        uint8_t* out_buf = scratch.empty() ? composed.data() : scratch.data();

        const auto now = std::chrono::steady_clock::now();
        const uint64_t rec_ms = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(now - t0).count());
        const uint64_t active_ms = rec_ms - paused_total_ms;

        POINT cur{};
        if (p.cursorHighlight && GetCursorPos(&cur)) {
            const int cx = cur.x - cap_origin_x;
            const int cy = cur.y - cap_origin_y;
            if (cx >= 0 && cy >= 0 && cx < w && cy < h) {
                compose::draw_cursor_ring(out_buf, w, h, cx, cy, p.ringSize, ring);
            }
        }
        if (p.clickHighlight) {
            std::vector<compose::Ripple> mine;
            {
                std::lock_guard<std::mutex> lk(clicks.m);
                mine.reserve(clicks.ripples.size());
                for (const auto& r : clicks.ripples) {
                    mine.push_back({r.x - cap_origin_x, r.y - cap_origin_y, r.t0});
                }
            }
            compose::draw_ripples(out_buf, w, h, mine);
        }
        if (p.camera) {
            std::lock_guard<std::mutex> lk(latest_m);
            if (cam_w > 0) {
                compose::draw_camera_pip(out_buf, w, h, cam_frame.data(), cam_w, cam_h);
            }
        }

        enc->write_video_rgba(out_buf, w, h, stride, static_cast<int64_t>(active_ms) * 1000);

        if (active_ms / 1000 != last_state_ms / 1000) {
            last_state_ms = active_ms;
            on_state("recording", active_ms);
        }
    }

    // Teardown.
    clicks.stop();
    loopback.stop();
    mic.stop();
    camera.stop();
    screen.stop();
    if (enc && enc->valid()) ok = enc->finish();
    if (cancel.load()) {
        DeleteFileA(p.out.c_str());
    }

    if (com_here) CoUninitialize();
    return ok;
}

} // namespace cde
