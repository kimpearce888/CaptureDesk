// CaptureDesk engine — CPU compositor for RGBA frames:
// cursor highlight ring, click ripples and the camera PiP card.
//
// All drawing is alpha-blended into the capture buffer before encoding, so
// highlights are baked into the recording exactly like the v1 renderer
// compositor — but natively, at capture rate.

#include "capture_internal.h"

#include <algorithm>
#include <cmath>

namespace cde {
namespace compose {

namespace {

inline void blend_pixel(uint8_t* px, const uint8_t color[4]) {
    const uint8_t a = color[3];
    if (a == 255) {
        // Frame buffer and color are both RGBA8888 (R,G,B,A in memory).
        px[0] = color[0];
        px[1] = color[1];
        px[2] = color[2];
        px[3] = 255;
        return;
    }
    if (a == 0) return;
    px[0] = static_cast<uint8_t>((color[0] * a + px[0] * (255 - a)) / 255);
    px[1] = static_cast<uint8_t>((color[1] * a + px[1] * (255 - a)) / 255);
    px[2] = static_cast<uint8_t>((color[2] * a + px[2] * (255 - a)) / 255);
    px[3] = 255;
}

inline void blend_disc(uint8_t* buf, int w, int h, int cx, int cy, int r,
                       const uint8_t color[4]) {
    const int r2 = r * r;
    for (int y = std::max(0, cy - r); y <= std::min(h - 1, cy + r); ++y) {
        for (int x = std::max(0, cx - r); x <= std::min(w - 1, cx + r); ++x) {
            const int dx = x - cx;
            const int dy = y - cy;
            const int d2 = dx * dx + dy * dy;
            if (d2 <= r2) {
                blend_pixel(buf + (static_cast<size_t>(y) * w + x) * 4, color);
            }
        }
    }
}

inline uint8_t ring_alpha(float dist, float radius) {
    // Soft ring: full alpha at the stroke, feathered inside/outside.
    const float width = 2.5f;
    const float feather = 2.0f;
    const float inner = radius - width / 2.0f;
    const float outer = radius + width / 2.0f + feather;
    if (dist > outer) return 0;
    if (dist < inner - feather) return 0;
    if (dist >= inner && dist <= outer) return 255;
    const float t = dist < inner ? (inner - dist) / feather : (outer - dist) / feather;
    return static_cast<uint8_t>(std::clamp(t, 0.0f, 1.0f) * 255);
}

} // namespace

void draw_cursor_ring(uint8_t* buf, int w, int h, int cx, int cy, int radius,
                      const uint8_t color[4]) {
    if (!buf || w <= 0 || h <= 0) return;
    const int reach = radius + 8;
    for (int y = std::max(0, cy - reach); y <= std::min(h - 1, cy + reach); ++y) {
        for (int x = std::max(0, cx - reach); x <= std::min(w - 1, cx + reach); ++x) {
            const float dx = static_cast<float>(x - cx);
            const float dy = static_cast<float>(y - cy);
            const float dist = std::sqrt(dx * dx + dy * dy);
            const uint8_t a = ring_alpha(dist, static_cast<float>(radius));
            if (a > 0) {
                const uint8_t rgba[4] = {color[0], color[1], color[2], a};
                blend_pixel(buf + (static_cast<size_t>(y) * w + x) * 4, rgba);
            }
        }
    }
}

void draw_ripples(uint8_t* buf, int w, int h, std::vector<Ripple>& ripples) {
    const uint8_t amber[4] = {0xF5, 0x9E, 0x0B, 0xFF}; // CaptureDesk amber
    const auto now = std::chrono::steady_clock::now();
    ripples.erase(std::remove_if(ripples.begin(), ripples.end(),
                                 [&](const Ripple& r) {
                                     return std::chrono::duration_cast<std::chrono::milliseconds>(
                                                now - r.t0)
                                            .count() > 900;
                                 }),
                  ripples.end());
    for (const Ripple& rp : ripples) {
        const float age = std::chrono::duration_cast<std::chrono::duration<float>>(
                              now - rp.t0)
                              .count();
        const float radius = 8.0f + age / 0.9f * 30.0f;
        const uint8_t a = static_cast<uint8_t>(std::clamp(1.0f - age / 0.9f, 0.0f, 1.0f) * 220);
        if (a == 0) continue;
        const uint8_t rgba[4] = {amber[0], amber[1], amber[2], a};
        const int reach = static_cast<int>(radius) + 4;
        for (int y = std::max(0, rp.y - reach); y <= std::min(h - 1, rp.y + reach); ++y) {
            for (int x = std::max(0, rp.x - reach); x <= std::min(w - 1, rp.x + reach); ++x) {
                const float dx = static_cast<float>(x - rp.x);
                const float dy = static_cast<float>(y - rp.y);
                const float dist = std::sqrt(dx * dx + dy * dy);
                const uint8_t pa = ring_alpha(dist, radius);
                if (pa > 0) {
                    const uint8_t out[4] = {rgba[0], rgba[1], rgba[2],
                                            static_cast<uint8_t>(pa * a / 255)};
                    blend_pixel(buf + (static_cast<size_t>(y) * w + x) * 4, out);
                }
            }
        }
    }
}

void draw_camera_pip(uint8_t* dst, int w, int h, const uint8_t* cam, int cw, int ch) {
    if (!dst || !cam || cw <= 0 || ch <= 0) return;
    const int pw = std::min(320, w / 4) & ~1;
    const int ph = (pw * ch / cw) & ~1;
    if (pw < 32 || ph < 32) return;
    const int margin = 16;
    const int x0 = w - pw - margin;
    const int y0 = h - ph - margin;
    const uint8_t border[4] = {0xF8, 0xFA, 0xFC, 0xFF}; // CaptureDesk cloud

    for (int y = -3; y < ph + 3; ++y) {
        for (int x = -3; x < pw + 3; ++x) {
            const int fx = x0 + x;
            const int fy = y0 + y;
            if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
            const bool frame = (x < 0 || y < 0 || x >= pw || y >= ph);
            if (frame) {
                blend_pixel(dst + (static_cast<size_t>(fy) * w + fx) * 4, border);
            } else {
                const int sx = x * cw / pw;
                const int sy = y * ch / ph;
                const uint8_t* sp = cam + (static_cast<size_t>(sy) * cw + sx) * 4;
                uint8_t* dp = dst + (static_cast<size_t>(fy) * w + fx) * 4;
                dp[0] = sp[0];
                dp[1] = sp[1];
                dp[2] = sp[2];
                dp[3] = 255;
            }
        }
    }
}

bool crop_to_region(const uint8_t*& src, int& w, int& h, const json& rect,
                    std::vector<uint8_t>& scratch, int& stride) {
    if (!rect.is_object()) return true; // no crop requested
    const int rx = rect.value("x", 0);
    const int ry = rect.value("y", 0);
    const int rw = rect.value("width", w);
    const int rh = rect.value("height", h);
    if (rw <= 0 || rh <= 0) return false;
    if (rx <= 0 && ry <= 0 && rw >= w && rh >= h) return true; // full frame
    const int cx0 = std::clamp(rx, 0, w - 2);
    const int cy0 = std::clamp(ry, 0, h - 2);
    const int cw = std::min(rw, w - cx0);
    const int ch = std::min(rh, h - cy0);
    if (cw <= 0 || ch <= 0) return false;
    scratch.resize(static_cast<size_t>(cw) * ch * 4);
    for (int y = 0; y < ch; ++y) {
        std::memcpy(scratch.data() + static_cast<size_t>(y) * cw * 4,
                    src + (static_cast<size_t>(y + cy0) * w + cx0) * 4,
                    static_cast<size_t>(cw) * 4);
    }
    src = scratch.data();
    stride = cw * 4;
    w = cw;
    h = ch;
    return true;
}

} // namespace compose
} // namespace cde
