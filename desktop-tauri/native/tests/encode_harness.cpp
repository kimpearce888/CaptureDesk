// Local CI-style harness: drives cde::Encoder to produce a test clip.
// Usage: engine-harness <out.(webm|mp4|gif)>
#include "encoder.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    if (argc < 2) return 1;
    const char* path = argv[1];
    const int w = 320, h = 240, fps = 30, n = 60; // 2s @30fps
    auto enc = cde::Encoder::open(path, w, h, fps, true, "source");
    if (!enc || !enc->valid()) {
        std::fprintf(stderr, "encoder open failed for %s\n", path);
        return 2;
    }
    std::vector<uint8_t> rgba(size_t(w) * h * 4);
    for (int i = 0; i < n; ++i) {
        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                uint8_t* p = &rgba[(size_t(y) * w + x) * 4];
                p[0] = uint8_t((x * 255 / w) ^ (i * 7));
                p[1] = uint8_t((y * 255 / h) + i * 4);
                p[2] = uint8_t(128 + 100 * std::sin((x + i * 4) / 40.0));
                p[3] = 255;
            }
        }
        enc->write_video_rgba(rgba.data(), w, h, w * 4,
                              int64_t(i) * 1000000 / fps);
        // 0.5s of 48 kHz stereo float32 audio per frame batch.
        std::vector<float> audio(24000 * 2);
        for (int s = 0; s < 24000; ++s) {
            float t = float(s + i * 24000) / 48000.0f;
            audio[2 * size_t(s)] = 0.2f * std::sin(2 * 3.14159f * 440 * t);
            audio[2 * size_t(s) + 1] = 0.2f * std::sin(2 * 3.14159f * 660 * t);
        }
        enc->write_audio_f32(audio.data(), 24000, 2, 48000);
    }
    const bool ok = enc->finish();
    std::printf("%s %s\n", ok ? "ENCODE OK" : "ENCODE FAIL", path);
    return ok ? 0 : 3;
}
