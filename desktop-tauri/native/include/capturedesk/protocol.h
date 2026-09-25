#pragma once
// CaptureDesk engine — shared protocol types and small utilities.
#include <nlohmann/json.hpp>
#include <atomic>
#include <cstdint>
#include <string>

namespace cde {

using json = nlohmann::json;

inline constexpr const char* kEngineVersion = "2.0.0";

// ---- cross-TU engine plumbing (defined in main.cpp / transcode.cpp) ----
/// Emit an async event line on stdout (defined in main.cpp).
void emit_event(const json& ev);
/// Emit a log event line (defined in main.cpp).
void log_line(const std::string& line);
/// Run a transcode/export job (defined in transcode.cpp); polls `cancel`.
bool run_transcode(const json& spec, const std::atomic<bool>& cancel,
                   const std::string& out, std::string& error);

/// Parameters for the "start" command (mirrors the v1 renderer options).
struct StartParams {
    std::string mode = "screen";    // screen | window | region
    std::string sourceId;           // "screen:N" or "window:0x..." (hex HWND)
    json rect;                      // region mode: {x,y,width,height} (physical px)
    int fps = 30;
    std::string quality = "source"; // source | 1080p | 720p
    bool mic = true;
    bool systemAudio = true;
    bool camera = false;            // cameraBubble in the UI contract
    bool cursorHighlight = true;
    bool clickHighlight = true;
    int countdown = 0;
    std::string ringColor = "#5EEAD4";
    int ringSize = 26;
    std::string out;                // absolute output path (.webm)
};

inline StartParams parse_start_params(const json& j) {
    StartParams p;
    p.mode = j.value("mode", p.mode);
    p.sourceId = j.value("sourceId", p.sourceId);
    p.rect = j.value("rect", json());
    p.fps = j.value("fps", p.fps);
    p.quality = j.value("quality", p.quality);
    p.mic = j.value("mic", p.mic);
    p.systemAudio = j.value("systemAudio", p.systemAudio);
    p.camera = j.value("cameraBubble", j.value("camera", p.camera));
    p.cursorHighlight = j.value("cursorHighlight", p.cursorHighlight);
    p.clickHighlight = j.value("clickHighlight", p.clickHighlight);
    p.countdown = j.value("countdown", p.countdown);
    p.out = j.value("out", p.out);
    if (j.contains("highlight")) {
        const json& h = j.at("highlight");
        p.ringColor = h.value("color", p.ringColor);
        p.ringSize = h.value("size", p.ringSize);
    }
    if (p.fps < 5) p.fps = 5;
    if (p.fps > 60) p.fps = 60;
    if (p.countdown < 0) p.countdown = 0;
    if (p.countdown > 10) p.countdown = 10;
    return p;
}

/// "#RRGGBB" or "#RRGGBBAA" → components (alpha defaults to 255).
inline void hex_to_rgba(const std::string& hex, uint8_t out[4]) {
    out[0] = 0x5E; out[1] = 0xEA; out[2] = 0xD4; out[3] = 0xFF; // CaptureDesk teal default
    std::string h = hex;
    if (!h.empty() && h[0] == '#') h = h.substr(1);
    if (h.size() < 6) return;
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return 0;
    };
    out[0] = static_cast<uint8_t>((nib(h[0]) << 4) | nib(h[1]));
    out[1] = static_cast<uint8_t>((nib(h[2]) << 4) | nib(h[3]));
    out[2] = static_cast<uint8_t>((nib(h[4]) << 4) | nib(h[5]));
    out[3] = h.size() >= 8 ? static_cast<uint8_t>((nib(h[6]) << 4) | nib(h[7])) : 255;
}

} // namespace cde
