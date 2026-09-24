// CaptureDesk engine — Export pipeline (cross-platform, libav).
//
// trim window + optional burned-in PNG overlays (annotation strokes
// rasterized by the editor UI) → WebM (VP9/VP8+Opus), MP4 (H.264+AAC)
// or animated GIF, with progress events.
//
// This path is fully portable: Linux builds of the engine are
// export-capable even though capture is Windows-only in the v2 alpha.

#include "capture_internal.h"
#include "encoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
#include <Windows.h>
#endif

namespace cde {

// Small portability shim so the cancel path can clean up partial outputs.
void DeleteFile_portable(const std::string& path) {
#ifdef _WIN32
    DeleteFileA(path.c_str());
#else
    std::remove(path.c_str());
#endif
}

namespace {

struct OverlayImage {
    std::vector<uint8_t> rgba;
    int w = 0;
    int h = 0;
    double from = 0.0;
    double to = 0.0;
};

/// Decode a PNG file to RGBA using the image2 demuxer + png decoder.
bool load_png_rgba(const std::string& path, OverlayImage& img) {
    AVFormatContext* fmt = nullptr;
    if (avformat_open_input(&fmt, path.c_str(), nullptr, nullptr) < 0) return false;
    if (avformat_find_stream_info(fmt, nullptr) < 0) {
        avformat_close_input(&fmt);
        return false;
    }
    const int stream = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (stream < 0) {
        avformat_close_input(&fmt);
        return false;
    }
    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    bool ok = false;
    if (av_read_frame(fmt, pkt) >= 0) {
        const AVCodec* dec = avcodec_find_decoder(fmt->streams[stream]->codecpar->codec_id);
        AVCodecContext* ctx = avcodec_alloc_context3(dec);
        if (ctx && avcodec_open2(ctx, dec, nullptr) >= 0 &&
            avcodec_send_packet(ctx, pkt) >= 0 && avcodec_receive_frame(ctx, frame) >= 0) {
            SwsContext* sws = sws_getContext(
                frame->width, frame->height,
                static_cast<AVPixelFormat>(frame->format), frame->width, frame->height,
                AV_PIX_FMT_RGBA, SWS_BILINEAR, nullptr, nullptr, nullptr);
            if (sws) {
                img.w = frame->width;
                img.h = frame->height;
                img.rgba.resize(static_cast<size_t>(img.w) * img.h * 4);
                uint8_t* dst[4] = {img.rgba.data(), nullptr, nullptr, nullptr};
                int dst_stride[4] = {img.w * 4, 0, 0, 0};
                sws_scale(sws, frame->data, frame->linesize, 0, frame->height, dst, dst_stride);
                sws_freeContext(sws);
                ok = true;
            }
        }
        avcodec_free_context(&ctx);
    }
    av_frame_free(&frame);
    av_packet_free(&pkt);
    avformat_close_input(&fmt);
    return ok;
}

/// Alpha-blend an overlay scaled to the full frame.
void blend_overlay(std::vector<uint8_t>& frame_rgba, int w, int h,
                   const OverlayImage& ov) {
    if (ov.rgba.empty() || ov.w <= 0 || ov.h <= 0) return;
    for (int y = 0; y < h; ++y) {
        const int sy = y * ov.h / h;
        uint8_t* dst = frame_rgba.data() + static_cast<size_t>(y) * w * 4;
        const uint8_t* src = ov.rgba.data() + static_cast<size_t>(sy) * ov.w * 4;
        for (int x = 0; x < w; ++x) {
            const uint8_t* sp = src + static_cast<size_t>(x * ov.w / w) * 4;
            uint8_t* dp = dst + static_cast<size_t>(x) * 4;
            const uint8_t a = sp[3];
            if (a == 0) continue;
            if (a == 255) {
                dp[0] = sp[0];
                dp[1] = sp[1];
                dp[2] = sp[2];
                dp[3] = 255;
            } else {
                dp[0] = static_cast<uint8_t>((sp[0] * a + dp[0] * (255 - a)) / 255);
                dp[1] = static_cast<uint8_t>((sp[1] * a + dp[1] * (255 - a)) / 255);
                dp[2] = static_cast<uint8_t>((sp[2] * a + dp[2] * (255 - a)) / 255);
                dp[3] = 255;
            }
        }
    }
}

} // namespace

bool run_transcode(const json& spec, const std::atomic<bool>& cancel,
                   const std::string& out, std::string& error) {
    const std::string input = spec.value("input", std::string());
    const std::string format = spec.value("format", std::string("webm"));
    const json trim = spec.value("trim", json::object());
    const double in_s = trim.value("inS", 0.0);
    const double out_s = trim.value("outS", -1.0); // -1 → until the end
    const json overlays_spec = spec.value("overlays", json::array());

    // ---- open input ----
    AVFormatContext* ictx = nullptr;
    if (avformat_open_input(&ictx, input.c_str(), nullptr, nullptr) < 0) {
        error = "CaptureDesk could not open the recording.";
        return false;
    }
    if (avformat_find_stream_info(ictx, nullptr) < 0) {
        avformat_close_input(&ictx);
        error = "CaptureDesk could not read the recording.";
        return false;
    }
    const int vs = av_find_best_stream(ictx, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    const int as = av_find_best_stream(ictx, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (vs < 0) {
        avformat_close_input(&ictx);
        error = "The recording has no video stream.";
        return false;
    }
    AVStream* vstream = ictx->streams[vs];
    AVCodecContext* vdec = avcodec_alloc_context3(
        avcodec_find_decoder(vstream->codecpar->codec_id));
    avcodec_parameters_to_context(vdec, vstream->codecpar);
    if (avcodec_open2(vdec, avcodec_find_decoder(vdec->codec_id), nullptr) < 0) {
        avcodec_free_context(&vdec);
        avformat_close_input(&ictx);
        error = "CaptureDesk could not decode the recording.";
        return false;
    }
    AVCodecContext* adec = nullptr;
    if (as >= 0) {
        AVStream* astream = ictx->streams[as];
        adec = avcodec_alloc_context3(avcodec_find_decoder(astream->codecpar->codec_id));
        avcodec_parameters_to_context(adec, astream->codecpar);
        avcodec_open2(adec, avcodec_find_decoder(adec->codec_id), nullptr);
    }

    const double duration = ictx->duration > 0
                                ? ictx->duration / static_cast<double>(AV_TIME_BASE)
                                : vstream->duration * av_q2d(vstream->time_base);
    const double end_s = out_s < 0 ? duration : std::min(out_s, duration);
    if (end_s <= in_s) {
        avcodec_free_context(&vdec);
        avcodec_free_context(&adec);
        avformat_close_input(&ictx);
        error = "The trim window is empty.";
        return false;
    }

    // ---- overlays ----
    std::vector<OverlayImage> overlays;
    for (const auto& o : overlays_spec) {
        OverlayImage img;
        img.from = o.value("from", 0.0);
        img.to = o.value("to", 1e9);
        if (load_png_rgba(o.value("png", std::string()), img)) {
            overlays.push_back(std::move(img));
        }
    }

    // ---- output encoder ----
    const int ow = vdec->width & ~1;
    const int oh = vdec->height & ~1;
    const AVRational vfr = vstream->avg_frame_rate.num > 0
                               ? vstream->avg_frame_rate
                               : AVRational{30, 1};
    int fps = static_cast<int>(av_q2d(vfr) + 0.5);
    fps = std::clamp(fps, 5, 60);
    auto enc = Encoder::open(out, ow, oh, fps, adec != nullptr, spec.value("quality", std::string("source")));
    if (!enc || !enc->valid()) {
        avcodec_free_context(&vdec);
        avcodec_free_context(&adec);
        avformat_close_input(&ictx);
        error = "CaptureDesk could not prepare the encoder for ." + format;
        return false;
    }

    // ---- decode / blend / encode loop ----
    SwsContext* sws = sws_getContext(vdec->width, vdec->height,
                                     static_cast<AVPixelFormat>(vdec->pix_fmt),
                                     ow, oh, AV_PIX_FMT_RGBA, SWS_BILINEAR,
                                     nullptr, nullptr, nullptr);
    std::vector<uint8_t> rgba(static_cast<size_t>(ow) * oh * 4);
    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    bool ok = true;
    auto last_progress = std::chrono::steady_clock::now();

    if (in_s > 0) {
        const int64_t seek_ts = static_cast<int64_t>(in_s / av_q2d(vstream->time_base));
        av_seek_frame(ictx, vs, seek_ts, AVSEEK_FLAG_BACKWARD);
    }

    while (ok && !cancel.load() && av_read_frame(ictx, pkt) >= 0) {
        if (pkt->stream_index == vs) {
            if (avcodec_send_packet(vdec, pkt) >= 0) {
                while (avcodec_receive_frame(vdec, frame) >= 0) {
                    const double t = frame->best_effort_timestamp *
                                     av_q2d(vstream->time_base);
                    if (t < in_s) continue;
                    if (t > end_s) {
                        av_frame_unref(frame);
                        goto done;
                    }
                    const uint8_t* src[4] = {frame->data[0], frame->data[1], frame->data[2], nullptr};
                    int src_stride[4] = {frame->linesize[0], frame->linesize[1], frame->linesize[2], 0};
                    uint8_t* dst[4] = {rgba.data(), nullptr, nullptr, nullptr};
                    int dst_stride[4] = {ow * 4, 0, 0, 0};
                    sws_scale(sws, src, src_stride, 0, frame->height, dst, dst_stride);
                    for (const auto& ov : overlays) {
                        if (t >= ov.from && t <= ov.to) {
                            blend_overlay(rgba, ow, oh, ov);
                        }
                    }
                    ok = enc->write_video_rgba(rgba.data(), ow, oh, ow * 4,
                                               static_cast<int64_t>((t - in_s) * 1e6));
                    const double ratio = (t - in_s) / (end_s - in_s);
                    const auto now = std::chrono::steady_clock::now();
                    if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_progress)
                            .count() > 400) {
                        last_progress = now;
                        emit_event(json({{"ev", "progress"},
                                         {"ratio", std::clamp(ratio, 0.0, 1.0)},
                                         {"message", "Encoding…"}}));
                    }
                    av_frame_unref(frame);
                }
            }
        } else if (pkt->stream_index == as && adec) {
            if (avcodec_send_packet(adec, pkt) >= 0) {
                AVFrame* af = av_frame_alloc();
                while (avcodec_receive_frame(adec, af) >= 0) {
                    const double t = af->best_effort_timestamp *
                                     av_q2d(ictx->streams[as]->time_base);
                    if (t >= in_s && t <= end_s) {
                        // Convert to interleaved f32 at source rate.
                        SwrContext* swr = nullptr;
                        AVChannelLayout in_layout = af->ch_layout;
                        AVChannelLayout out_layout;
                        av_channel_layout_default(&out_layout, 2);
                        swr_alloc_set_opts2(&swr, &out_layout, AV_SAMPLE_FMT_FLT,
                                            af->sample_rate, &in_layout,
                                            static_cast<AVSampleFormat>(af->format),
                                            af->sample_rate, 0, nullptr);
                        if (swr && swr_init(swr) >= 0) {
                            std::vector<float> interleaved(
                                static_cast<size_t>(af->nb_samples) * 2 + 64);
                            uint8_t* dst_data[1] = {
                                reinterpret_cast<uint8_t*>(interleaved.data())};
                            const int got = swr_convert(swr, dst_data, af->nb_samples,
                                                        const_cast<const uint8_t**>(af->data),
                                                        af->nb_samples);
                            if (got > 0) {
                                enc->write_audio_f32(interleaved.data(), got, 2,
                                                     af->sample_rate);
                            }
                        }
                        if (swr) swr_free(&swr);
                    }
                    av_frame_unref(af);
                }
                av_frame_free(&af);
            }
        }
        av_packet_unref(pkt);
        continue;
    done:
        av_packet_unref(pkt);
        break;
    }

    if (cancel.load()) {
        enc.reset(); // close without trailer semantics
        av_packet_free(&pkt);
        av_frame_free(&frame);
        sws_freeContext(sws);
        avcodec_free_context(&vdec);
        avcodec_free_context(&adec);
        avformat_close_input(&ictx);
        DeleteFile_portable(out);
        error = "cancelled";
        return false;
    }

    enc->finish();

    av_packet_free(&pkt);
    av_frame_free(&frame);
    sws_freeContext(sws);
    avcodec_free_context(&vdec);
    avcodec_free_context(&adec);
    avformat_close_input(&ictx);
    return ok;
}

} // namespace cde
