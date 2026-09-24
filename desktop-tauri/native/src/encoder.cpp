// CaptureDesk engine — FFmpeg encoder implementation.
//
// Containers/codecs by output extension:
//   .webm → Matroska, libvpx-vp9 (fallback libvpx VP8) + libopus
//   .mp4  → MP4,     libx264 + AAC
//   .gif  → GIF (video only)
//
// Video input is RGBA8888 (converted via swscale); audio input is
// interleaved float32 (resampled to 48 kHz stereo via swresample).

#include "encoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <mutex>
#include <vector>

namespace cde {

namespace {

const AVCodec* pick_video_codec(AVFormatContext* fmt, const AVCodec** forced) {
    const char* cname = "libvpx-vp9";
    if (fmt->oformat && fmt->oformat->video_codec == AV_CODEC_ID_GIF) {
        cname = "gif";
    } else if (av_guess_format("mp4", nullptr, nullptr) == fmt->oformat) {
        cname = "libx264";
    }
    const AVCodec* c = avcodec_find_encoder_by_name(cname);
    if (!c && std::string(cname) == "libvpx-vp9") c = avcodec_find_encoder(AV_CODEC_ID_VP8);
    if (!c) c = avcodec_find_encoder(fmt->oformat->video_codec);
    *forced = c;
    return c;
}

void fit_even(int& w, int& h, const std::string& quality) {
    if (w < 2 || h < 2) {
        w = 1280;
        h = 720;
    }
    if (quality == "1080p" || quality == "720p") {
        const int target = quality == "1080p" ? 1080 : 720;
        if (h > target) {
            w = (w * target + h / 2) / h;
            h = target;
        } else if (w > target * 2) {
            h = (h * target * 2 + w - 1) / (target * 2) / 1;
        }
    }
    if (w % 2) w -= 1;
    if (h % 2) h -= 1;
    if (w < 2) w = 2;
    if (h < 2) h = 2;
}

} // namespace

struct Encoder::Impl {
    std::mutex mux;
    AVFormatContext* fmt = nullptr;
    AVStream* vs = nullptr;
    AVStream* as = nullptr;
    AVCodecContext* venc = nullptr;
    AVCodecContext* aenc = nullptr;
    SwsContext* sws = nullptr;
    SwrContext* swr = nullptr;
    AVFrame* vframe = nullptr;
    AVFrame* aframe = nullptr;
    AVAudioFifo* fifo = nullptr;
    AVPacket* pkt = nullptr;
    int src_channels = 2;
    int in_rate = 48000;
    bool swr_initialized = false;
    int64_t vpts = 0;
    int64_t apts = 0;
    int64_t vpts_us_base = 0;
    int w = 0;
    int h = 0;
    int fps = 30;
    int src_w = 0;
    int src_h = 0;
    bool is_gif = false;
    bool opened = false;

    bool send_receive_video(AVFrame* frame) {
        avcodec_send_frame(venc, frame);
        while (avcodec_receive_packet(venc, pkt) >= 0) {
            av_packet_rescale_ts(pkt, venc->time_base, vs->time_base);
            pkt->stream_index = vs->index;
            av_interleaved_write_frame(fmt, pkt);
        }
        return true;
    }

    bool send_receive_audio() {
        while (av_audio_fifo_size(fifo) >= aenc->frame_size) {
            av_frame_make_writable(aframe);
            av_audio_fifo_read(fifo, reinterpret_cast<void**>(aframe->data), aenc->frame_size);
            aframe->pts = apts;
            apts += aenc->frame_size;
            avcodec_send_frame(aenc, aframe);
            while (avcodec_receive_packet(aenc, pkt) >= 0) {
                av_packet_rescale_ts(pkt, aenc->time_base, as->time_base);
                pkt->stream_index = as->index;
                av_interleaved_write_frame(fmt, pkt);
            }
        }
        return true;
    }
};

Encoder::~Encoder() {
    if (impl_) {
        finish();
    }
    // impl_ (unique_ptr) is destroyed automatically.
}

std::unique_ptr<Encoder> Encoder::open(const std::string& path, int w, int h, int fps,
                                       bool with_audio, const std::string& quality) {
    auto enc = std::unique_ptr<Encoder>(new Encoder());
    enc->impl_ = std::make_unique<Impl>();
    Impl& s = *enc->impl_;

    const std::string lower = [&] {
        std::string l = path;
        for (auto& ch : l) ch = static_cast<char>(::tolower(static_cast<unsigned char>(ch)));
        return l;
    }();
    auto ends_with = [](const std::string& s, const std::string& suf) {
        return s.size() >= suf.size() &&
               s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
    };
    const char* muxer = ends_with(lower, ".mp4") ? "mp4"
                        : ends_with(lower, ".gif") ? "gif"
                                                  : "webm";
    s.is_gif = std::string(muxer) == "gif";

    if (avformat_alloc_output_context2(&s.fmt, nullptr, muxer, path.c_str()) < 0) {
        return enc;
    }
    fit_even(w, h, quality);
    s.w = w;
    s.h = h;
    s.fps = fps;

    // ---- video encoder ----
    const AVCodec* vc = nullptr;
    pick_video_codec(s.fmt, &vc);
    if (!vc) return enc;
    s.vs = avformat_new_stream(s.fmt, nullptr);
    s.venc = avcodec_alloc_context3(vc);
    s.venc->width = w;
    s.venc->height = h;
    s.venc->time_base = AVRational{1, fps};
    s.venc->framerate = AVRational{fps, 1};
    s.venc->pix_fmt = s.is_gif ? AV_PIX_FMT_PAL8 : AV_PIX_FMT_YUV420P;
    if (s.is_gif) {
        s.venc->pix_fmt = AV_PIX_FMT_RGB8; // gif encoder palletizes internally
    }
    if (s.venc->codec_id == AV_CODEC_ID_VP9 || s.venc->codec_id == AV_CODEC_ID_VP8) {
        s.venc->bit_rate = quality == "source" ? 6'000'000 : 4'000'000;
        s.venc->rc_buffer_size = static_cast<int>(s.venc->bit_rate);
        s.venc->thread_count = 0;
    } else if (s.venc->codec_id == AV_CODEC_ID_H264) {
        s.venc->bit_rate = 8'000'000;
        s.venc->max_b_frames = 2;
        s.venc->gop_size = fps * 2;
    } else if (s.venc->codec_id == AV_CODEC_ID_GIF) {
        s.venc->gop_size = 1;
    }
    if (s.fmt->oformat->flags & AVFMT_GLOBALHEADER) {
        s.venc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    }
    if (avcodec_open2(s.venc, vc, nullptr) < 0) return enc;
    avcodec_parameters_from_context(s.vs->codecpar, s.venc);
    s.vs->time_base = s.venc->time_base;

    // ---- audio encoder (webm/mp4) ----
    // Open the audio codec BEFORE adding the stream: a failed open can then
    // never leave a codec-less orphan stream behind (which would make
    // avformat_write_header reject the whole file).
    //   MP4 → AAC (fltp)   WebM → libopus / native opus (flt)
    if (with_audio && !s.is_gif) {
        const bool is_mp4 = av_guess_format("mp4", nullptr, nullptr) == s.fmt->oformat;
        const AVCodec* candidates[2] = {nullptr, nullptr};
        int ncand = 0;
        if (is_mp4) {
            candidates[ncand++] = avcodec_find_encoder(AV_CODEC_ID_AAC);
        } else {
            candidates[ncand++] = avcodec_find_encoder_by_name("libopus");
            candidates[ncand++] = avcodec_find_encoder(AV_CODEC_ID_OPUS);
        }
        for (int i = 0; i < ncand && !s.aenc; ++i) {
            const AVCodec* c = candidates[i];
            if (!c) continue;
            // libopus accepts s16/flt only; AAC accepts fltp.
            const AVSampleFormat want = c->id == AV_CODEC_ID_OPUS
                                            ? AV_SAMPLE_FMT_FLT
                                            : AV_SAMPLE_FMT_FLTP;
            AVCodecContext* test = avcodec_alloc_context3(c);
            test->sample_rate = 48000;
            test->sample_fmt = want;
            AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
            av_channel_layout_copy(&test->ch_layout, &stereo);
            test->time_base = AVRational{1, 48000};
            test->bit_rate = 128'000;
            if (s.fmt->oformat->flags & AVFMT_GLOBALHEADER) {
                test->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
            }
            if (avcodec_open2(test, c, nullptr) >= 0) {
                s.aenc = test;
                s.as = avformat_new_stream(s.fmt, nullptr);
                avcodec_parameters_from_context(s.as->codecpar, s.aenc);
                s.as->time_base = s.aenc->time_base;
                s.fifo = av_audio_fifo_alloc(s.aenc->sample_fmt,
                                             s.aenc->ch_layout.nb_channels,
                                             s.aenc->frame_size * 8);
                s.aframe = av_frame_alloc();
                s.aframe->format = s.aenc->sample_fmt;
                s.aframe->sample_rate = s.aenc->sample_rate;
                av_channel_layout_copy(&s.aframe->ch_layout, &s.aenc->ch_layout);
                s.aframe->nb_samples = s.aenc->frame_size;
                av_frame_get_buffer(s.aframe, 0);
            } else {
                avcodec_free_context(&test);
            }
        }
    }

    s.vframe = av_frame_alloc();
    s.vframe->format = s.venc->pix_fmt;
    s.vframe->width = w;
    s.vframe->height = h;
    av_frame_get_buffer(s.vframe, 32);
    s.pkt = av_packet_alloc();

    s.sws = sws_getContext(w, h, AV_PIX_FMT_RGBA, w, h, s.venc->pix_fmt,
                           SWS_BILINEAR, nullptr, nullptr, nullptr);
    if (avio_open(&s.fmt->pb, path.c_str(), AVIO_FLAG_WRITE) < 0) return enc;
    if (avformat_write_header(s.fmt, nullptr) < 0) return enc;
    s.opened = true;
    return enc;
}

bool Encoder::write_video_rgba(const uint8_t* rgba, int w, int h, int stride,
                               int64_t pts_us) {
    if (!impl_ || !impl_->opened || !rgba || w < 2 || h < 2) return false;
    Impl& s = *impl_;
    std::lock_guard<std::mutex> lock(s.mux);
    // (Re)create the scaler when the input geometry changes (e.g. region
    // crops or quality scaling).
    if (!s.sws || s.src_w != w || s.src_h != h) {
        if (s.sws) sws_freeContext(s.sws);
        s.sws = sws_getContext(w, h, AV_PIX_FMT_RGBA, s.w, s.h, s.venc->pix_fmt,
                               SWS_BILINEAR, nullptr, nullptr, nullptr);
        s.src_w = w;
        s.src_h = h;
        if (!s.sws) return false;
    }
    if (av_frame_make_writable(s.vframe) < 0) return false;
    const uint8_t* src[4] = {rgba, nullptr, nullptr, nullptr};
    int src_stride[4] = {stride, 0, 0, 0};
    sws_scale(s.sws, src, src_stride, 0, h, s.vframe->data, s.vframe->linesize);
    // Presentation timestamps: video ticks + audio stream in same time base.
    const AVRational us_tb = AVRational{1, 1'000'000};
    int64_t tick = av_rescale_q(pts_us, us_tb, s.vs->time_base);
    if (tick <= s.vpts && s.vpts > 0) tick = s.vpts + 1;
    s.vpts = tick;
    s.vframe->pts = tick;
    s.send_receive_video(s.vframe);
    return true;
}

bool Encoder::write_audio_f32(const float* interleaved, int frames, int channels,
                              int sample_rate) {
    if (!impl_ || !impl_->opened || !impl_->as) return false;
    Impl& s = *impl_;
    std::lock_guard<std::mutex> lock(s.mux);
    if (!s.swr || s.in_rate != sample_rate || s.src_channels != channels) {
        if (s.swr) swr_free(&s.swr);
        AVChannelLayout in_layout;
        av_channel_layout_default(&in_layout, channels);
        AVChannelLayout out_layout;
        av_channel_layout_default(&out_layout, 2);
        swr_alloc_set_opts2(&s.swr, &out_layout, s.aenc->sample_fmt, 48000, &in_layout,
                            AV_SAMPLE_FMT_FLT, sample_rate, 0, nullptr);
        if (swr_init(s.swr) < 0) {
            s.swr = nullptr;
            return false;
        }
        s.in_rate = sample_rate;
        s.src_channels = channels;
    }
    const int out_frames = swr_get_out_samples(s.swr, frames);
    // Planar float32 scratch: left plane then right plane, each out_frames + 64.
    std::vector<uint8_t> planar(2 * (out_frames + 64) * sizeof(float));
    float* left = reinterpret_cast<float*>(planar.data());
    float* right = left + out_frames + 64;
    uint8_t* dst_data[2] = {reinterpret_cast<uint8_t*>(left), reinterpret_cast<uint8_t*>(right)};
    const uint8_t* in_ptr = reinterpret_cast<const uint8_t*>(interleaved);
    const int converted = swr_convert(s.swr, dst_data, out_frames,
                                      &in_ptr, frames);
    if (converted <= 0) return true;
    av_audio_fifo_write(s.fifo, reinterpret_cast<void**>(dst_data), converted);
    s.send_receive_audio();
    return true;
}

bool Encoder::finish() {
    if (!impl_) return false;
    Impl& s = *impl_;
    std::lock_guard<std::mutex> lock(s.mux);
    if (!s.opened) return false;
    // Drain audio FIFO tail.
    if (s.fifo && s.aenc) {
        while (av_audio_fifo_size(s.fifo) > 0) {
            const int n = std::min(av_audio_fifo_size(s.fifo), s.aenc->frame_size);
            av_frame_make_writable(s.aframe);
            av_audio_fifo_read(s.fifo, reinterpret_cast<void**>(s.aframe->data), n);
            s.aframe->pts = s.apts;
            s.apts += n;
            avcodec_send_frame(s.aenc, s.aframe);
            while (avcodec_receive_packet(s.aenc, s.pkt) >= 0) {
                av_packet_rescale_ts(s.pkt, s.aenc->time_base, s.as->time_base);
                s.pkt->stream_index = s.as->index;
                av_interleaved_write_frame(s.fmt, s.pkt);
            }
            if (n < s.aenc->frame_size) break;
        }
    }
    avcodec_send_frame(s.venc, nullptr);
    while (avcodec_receive_packet(s.venc, s.pkt) >= 0) {
        av_packet_rescale_ts(s.pkt, s.venc->time_base, s.vs->time_base);
        s.pkt->stream_index = s.vs->index;
        av_interleaved_write_frame(s.fmt, s.pkt);
    }
    if (s.aenc) {
        avcodec_send_frame(s.aenc, nullptr);
        while (avcodec_receive_packet(s.aenc, s.pkt) >= 0) {
            av_packet_rescale_ts(s.pkt, s.aenc->time_base, s.as->time_base);
            s.pkt->stream_index = s.as->index;
            av_interleaved_write_frame(s.fmt, s.pkt);
        }
    }
    av_write_trailer(s.fmt);
    if (s.fmt->pb) avio_closep(&s.fmt->pb);
    s.opened = false;
    return true;
}

} // namespace cde
