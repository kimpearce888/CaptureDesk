#pragma once
// CaptureDesk engine — recording session FSM and transcode orchestration.
#include "capturedesk/protocol.h"

#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>

namespace cde {

class Session {
public:
    Session() = default;
    ~Session();
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    /// Command dispatch; returns the JSON response object, or null when the
    /// result is delivered later as an id-tagged done/error event (transcode).
    json dispatch(const std::string& cmd, const json& params, uint64_t id);

    /// Stop everything and join workers (engine shutdown).
    void shutdown();

private:
    json start(const json& params);
    json stop_recording(bool cancelled);
    json pause();
    json resume();
    json list_sources(const json& kinds);
    json grab_screen(const json& params);
    json transcode(const json& spec, uint64_t id);
    json transcode_cancel();

    void capture_loop(StartParams p);
    void transcode_loop(json spec);
    void set_state(const std::string& name, uint64_t elapsed_ms = 0,
                   const json& extra = json());

    std::mutex m_worker_mutex;
    std::thread m_capture_thread;
    std::thread m_transcode_thread;
    std::atomic<uint64_t> m_export_id{0};

    std::atomic<bool> m_stop{false};
    std::atomic<bool> m_cancel{false};
    std::atomic<bool> m_pause{false};
    std::atomic<bool> m_busy{false};
    std::atomic<bool> m_export_busy{false};
    std::atomic<bool> m_export_cancel{false};
};

} // namespace cde
