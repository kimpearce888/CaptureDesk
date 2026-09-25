// CaptureDesk engine entry point — newline-delimited JSON over stdio.
//
//   shell → engine : {"id":1,"cmd":"start","params":{...}}
//   engine → shell : {"id":1,"ok":true,...}          (response, one per request)
//   engine → shell : {"ev":"state"|"done"|"progress"|"error"|"log", ...}
//
// Media bytes never cross stdio; the engine writes files directly.

#include "capturedesk/protocol.h"
#include "session.h"

#include <iostream>
#include <mutex>
#include <string>

namespace {

std::mutex g_stdout_mutex;

void send_line(const std::string& line) {
    std::lock_guard<std::mutex> lock(g_stdout_mutex);
    std::cout << line << '\n';
    std::cout.flush();
}

} // namespace

namespace cde {

/// Async event channel used by the whole engine.
void emit_event(const json& ev) {
    send_line(ev.dump());
}

void log_line(const std::string& line) {
    json ev = {{"ev", "log"}, {"line", line}};
    send_line(ev.dump());
}

} // namespace cde

using cde::json;

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    cde::log_line(std::string("CaptureDesk engine ") + cde::kEngineVersion + " ready");
    cde::Session session;
    std::string line;

    while (std::getline(std::cin, line)) {
        if (line.find_first_not_of(" \t\r\n") == std::string::npos) {
            continue;
        }
        json req = json::parse(line, nullptr, false);
        if (req.is_discarded() || !req.is_object()) {
            continue;
        }
        const uint64_t id = req.value("id", static_cast<uint64_t>(0));
        const std::string cmd = req.value("cmd", std::string());
        const json params = req.value("params", json::object());

        json result = session.dispatch(cmd, params, id);
        if (!result.is_null()) {
            json response = {{"id", id}};
            for (auto it = result.begin(); it != result.end(); ++it) {
                response[it.key()] = it.value();
            }
            send_line(response.dump());
        }
    }

    session.shutdown();
    return 0;
}
