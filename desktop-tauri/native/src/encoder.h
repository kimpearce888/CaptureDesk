#pragma once
// CaptureDesk engine — FFmpeg muxer/encoder (WebM VP9/VP8+Opus, MP4 H.264+
// AAC, animated GIF). Input: RGBA frames + interleaved float32 audio.
#include <cstdint>
#include <memory>
#include <string>

namespace cde {

class Encoder {
public:
    /// Create an encoder for `path` (extension decides container/codec).
    /// `quality`: "source" keeps w/h; "1080p"/"720p" fit-scale (even dims).
    static std::unique_ptr<Encoder> open(const std::string& path, int w, int h,
                                         int fps, bool with_audio,
                                         const std::string& quality);
    ~Encoder();

    bool valid() const { return impl_ != nullptr; }

    /// Push one RGBA8888 frame of size w×h (input may differ from the
    /// output size — swscale fits it). `stride` is in bytes (>= w*4).
    /// `pts_us` is the presentation timestamp in microseconds.
    bool write_video_rgba(const uint8_t* rgba, int w, int h, int stride,
                          int64_t pts_us);

    /// Push interleaved float32 audio (any channel count; mixed to stereo).
    bool write_audio_f32(const float* interleaved, int frames, int channels,
                         int sample_rate);

    /// Flush encoders and finalize the container.
    bool finish();

private:
    Encoder() = default;
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace cde
