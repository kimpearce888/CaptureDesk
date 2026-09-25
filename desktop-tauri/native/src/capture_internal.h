#pragma once
// CaptureDesk engine — internal interfaces shared between session.cpp,
// the platform capture implementation and the export pipeline.
#include "capturedesk/protocol.h"

#include <atomic>
#include <chrono>
#include <functional>
#include <string>
#include <vector>

namespace cde {

/// Enumerate capturable sources (platform impl).
json list_sources_impl(const json& kinds);

/// Delete a file given as a UTF-8 path (ANSI-safe on Windows).
void delete_file_utf8(const std::string& path);

/// Export pipeline: trim, burn overlays, encode (cross-platform, libav).
bool run_transcode(const json& spec, const std::atomic<bool>& cancel,
                   const std::string& out, std::string& error);

#ifdef _WIN32

/// Full capture → composite → encode session (Windows).
/// Reports state transitions; writes the recording to p.out.
bool run_capture_session(
    const StartParams& p,
    const std::atomic<bool>& stop,
    const std::atomic<bool>& pause,
    const std::atomic<bool>& cancel,
    std::chrono::steady_clock::time_point t0,
    uint64_t& paused_total_ms,
    const std::function<void(const std::string&, uint64_t)>& on_state,
    const std::function<void(uint64_t)>& on_tick);

/// CPU compositor helpers (compositor.cpp) — operate on RGBA8888 buffers.
namespace compose {

struct Ripple {
    int x = 0;
    int y = 0;
    std::chrono::steady_clock::time_point t0;
};

/// Cursor highlight ring (CaptureDesk teal by default).
void draw_cursor_ring(uint8_t* buf, int w, int h, int cx, int cy,
                      int radius, const uint8_t color[4]);

/// Expanding, fading click ripples (amber). Expired ripples are removed.
void draw_ripples(uint8_t* buf, int w, int h, std::vector<Ripple>& ripples);

/// Camera PiP: bottom-right rounded-ish card with a light border.
void draw_camera_pip(uint8_t* dst, int w, int h,
                     const uint8_t* cam_rgba, int cw, int ch);

/// Crop an RGBA buffer in place to {x,y,width,height}. Returns false when
/// the rect does not intersect the frame.
bool crop_to_region(const uint8_t*& src, int& w, int& h, const json& rect,
                    std::vector<uint8_t>& scratch, int& stride);

} // namespace compose

#endif // _WIN32

} // namespace cde
