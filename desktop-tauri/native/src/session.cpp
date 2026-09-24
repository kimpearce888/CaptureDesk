// CaptureDesk engine — session FSM implementation.
//
// The capture loop (Windows) drives: WGC screen/window frames, WASAPI mic +
// system audio, optional Media Foundation camera PiP, cursor ring and click
// ripples, then feeds RGBA frames into the FFmpeg encoder. Pause skips frame
// writes while preserving monotonic wall-clock timestamps.

#include "session.h"

#ifdef _WIN32
#include "capture_internal.h"
#endif

#include <chrono>
#include <memory>
#include <utility>

namespace cde {

namespace {
using Clock = std::chrono::steady_clock;

uint64_t ms_since(Clock::time_point t0) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t0).count());
}
} // namespace

Session::~Session() {
    shutdown();
}

void Session::shutdown() {
    m_stop = true;
    m_export_cancel = true;
    if (m_capture_thread.joinable()) m_capture_thread.join();
    if (m_transcode_thread.joinable()) m_transcode_thread.join();
}

void Session::set_state(const std::string& name, uint64_t elapsed_ms, const json& extra) {
    json ev = {{"ev", "state"}, {"state", name}, {"elapsedMs", elapsed_ms}};
    for (auto it = extra.begin(); it != extra.end(); ++it) {
        ev[it.key()] = it.value();
    }
    emit_event(ev);
}

json Session::dispatch(const std::string& cmd, const json& params, uint64_t id) {
    if (cmd == "start") return start(params);
    if (cmd == "stop") return stop_recording(false);
    if (cmd == "cancel") return stop_recording(true);
    if (cmd == "pause") return pause();
    if (cmd == "resume") return resume();
    if (cmd == "list-sources") return list_sources(params);
    if (cmd == "transcode") return transcode(params, id);
    if (cmd == "transcode-cancel") return transcode_cancel();
    if (cmd == "version") {
        return json({{"ok", true},
                     {"engine", "capturedesk-engine"},
                     {"version", kEngineVersion}});
    }
    return json({{"ok", false}, {"error", "unknown command: " + cmd}});
}

json Session::start(const json& params) {
    if (m_busy.load()) {
        return json({{"ok", false}, {"error", "A recording is already in progress."}});
    }
    StartParams p = parse_start_params(params);
    if (p.out.empty()) {
        return json({{"ok", false}, {"error", "CaptureDesk needs an output path."}});
    }
    m_stop = false;
    m_cancel = false;
    m_pause = false;
    m_busy = true;
    if (m_capture_thread.joinable()) m_capture_thread.join();
    m_capture_thread = std::thread([this, p] { capture_loop(std::move(p)); });
    return json({{"ok", true}});
}

json Session::stop_recording(bool cancelled) {
    if (!m_busy.load()) {
        return json({{"ok", true}, {"note", "nothing to stop"}});
    }
    if (cancelled) m_cancel = true;
    m_stop = true;
    return json({{"ok", true}});
}

json Session::pause() {
    if (!m_busy.load()) return json({{"ok", false}, {"error", "Not recording."}});
    m_pause = true;
    return json({{"ok", true}});
}

json Session::resume() {
    m_pause = false;
    return json({{"ok", true}});
}

json Session::list_sources(const json& kinds) {
#ifdef _WIN32
    return list_sources_impl(kinds);
#else
    (void)kinds;
    return json({{"ok", true},
                 {"sources", json::array()},
                 {"note", "Capture source enumeration requires Windows in the "
                          "v2 native alpha; the Export pipeline works here."}});
#endif
}

json Session::transcode(const json& spec, uint64_t id) {
    if (m_export_busy.load()) {
        return json({{"ok", false}, {"error", "An export is already running."}});
    }
    if (!spec.value("input", std::string()).empty() && !spec.value("out", std::string()).empty()) {
        m_export_busy = true;
        m_export_cancel = false;
        m_export_id = id;
        if (m_transcode_thread.joinable()) m_transcode_thread.join();
        m_transcode_thread = std::thread([this, spec] { transcode_loop(spec); });
        // No synchronous response — the result arrives as an id-tagged
        // done/error event once the export finishes (or fails).
        return json();
    }
    return json({{"ok", false}, {"error", "CaptureDesk export needs input and output paths."}});
}

json Session::transcode_cancel() {
    m_export_cancel = true;
    return json({{"ok", true}});
}

void Session::transcode_loop(json spec) {
    const std::string out = spec.value("out", std::string());
    const uint64_t id = m_export_id.load();
    bool ok = false;
    std::string error;
    ok = run_transcode(spec, m_export_cancel, out, error);
    m_export_busy = false;
    if (ok) {
        json ev = {{"ev", "done"}, {"id", id}, {"file", out}};
        emit_event(ev);
    } else {
        json ev = {{"ev", "error"},
                   {"id", id},
                   {"message", error.empty() ? "CaptureDesk Export failed" : error}};
        emit_event(ev);
    }
}

// ---------------------------------------------------------------------------
// Capture loop: platform split lives in capture_internal.h implementations.
// ---------------------------------------------------------------------------

void Session::capture_loop(StartParams p) {
    // Consumed by the Windows capture path for elapsed-time bookkeeping.
    [[maybe_unused]] const Clock::time_point t0 = Clock::now();
    uint64_t paused_total_ms = 0;

    // Countdown (also gives WASAPI/WGC threads time to warm up).
    for (int remain = p.countdown; remain > 0 && !m_stop.load(); --remain) {
        set_state("countdown", 0, json({{"remainingMs", remain * 1000}}));
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
    if (m_stop.load()) {
        m_busy = false;
        set_state("idle", 0);
        return;
    }
    set_state("recording", 0);

#ifdef _WIN32
    bool ok = run_capture_session(
        p, m_stop, m_pause, m_cancel, t0, paused_total_ms,
        [this](const std::string& s, uint64_t ms) { set_state(s, ms); },
        [](uint64_t) {});
    m_busy = false;
    if (ok) {
        if (m_cancel.load()) {
            set_state("idle", 0);
        }
        // The engine's capture session emits `done` with the file path; for
        // cancels the file is removed inside run_capture_session.
        if (!m_cancel.load()) {
            json ev = {{"ev", "done"}, {"file", p.out}};
            emit_event(ev);
        }
    } else {
        json ev = {{"ev", "error"}, {"message", "CaptureDesk could not capture the selected source."}};
        emit_event(ev);
    }
#else
    (void)paused_total_ms;
    m_busy = false;
    json ev = {{"ev", "error"},
               {"message", "CaptureDesk capture requires Windows in the v2 native alpha. "
                           "The engine still supports Export (transcode) on this platform."}};
    emit_event(ev);
#endif
}

} // namespace cde
