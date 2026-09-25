# CaptureDesk native engine (capturedesk-engine)
# C++20 stdio sidecar: Windows capture (WGC/WASAPI/MF) + FFmpeg encode/transcode.
#
# Dependencies (vcpkg on Windows, system packages on Linux CI):
#   nlohmann-json, ffmpeg (avcodec avformat avutil swscale swresample)
# Windows SDK: C++/WinRT (Windows.Graphics.Capture), WASAPI, Media Foundation, WIC.
#
# Linux builds are transcode/export capable (capture is Windows-only in v2 alpha).

cmake_minimum_required(VERSION 3.21)
project(capturedesk-engine CXX)

# C++20: C++/WinRT (Windows.Graphics.Capture) requires <coroutine>; MSVC
# deprecates the experimental C++17 coroutine headers.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(nlohmann_json CONFIG REQUIRED)

# FFmpeg detection — two supported layouts:
#   1. pkg-config (Linux / system installs: libavcodec-dev, ...)
#   2. vcpkg's unofficial-ffmpeg CMake config (Windows CI and dev)
# Non-REQUIRED pkg_check_modules keeps Windows flowing to fallback (2).
find_package(PkgConfig QUIET)
if(PKG_CONFIG_FOUND)
  pkg_check_modules(FFMPEG IMPORTED_TARGET
    libavcodec libavformat libavutil libswscale libswresample)
endif()

add_executable(capturedesk-engine
  src/main.cpp
  src/session.cpp
  src/encoder.cpp
  src/transcode.cpp
)

target_include_directories(capturedesk-engine PRIVATE include)

set(CAPTUREDESK_FFMPEG_LIB "")
if(TARGET PkgConfig::FFMPEG)
  set(CAPTUREDESK_FFMPEG_LIB PkgConfig::FFMPEG)
else()
  set(CAPTUREDESK_FFMPEG_LIB
    unofficial::ffmpeg::avcodec
    unofficial::ffmpeg::avformat
    unofficial::ffmpeg::avutil
    unofficial::ffmpeg::swscale
    unofficial::ffmpeg::swresample)
endif()

target_link_libraries(capturedesk-engine PRIVATE ${CAPTUREDESK_FFMPEG_LIB}
                                                 nlohmann_json::nlohmann_json)

# Portable encode/encode-test harness (regression test for the export
# pipeline: WebM VP9+Opus, MP4 H.264+AAC, GIF). Runs on every platform
# that can link FFmpeg; CI executes it on Linux.
option(CAPTUREDESK_BUILD_TESTS "Build the encoder test harness" OFF)
if(CAPTUREDESK_BUILD_TESTS)
  add_executable(capturedesk-encode-test tests/encode_harness.cpp src/encoder.cpp)
  target_include_directories(capturedesk-encode-test PRIVATE src include)
  target_link_libraries(capturedesk-encode-test PRIVATE
    nlohmann_json::nlohmann_json ${CAPTUREDESK_FFMPEG_LIB})
endif()

if(WIN32)
  target_sources(capturedesk-engine PRIVATE
    src/capture_windows.cpp
    src/compositor.cpp
  )
  target_compile_definitions(capturedesk-engine PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
  target_link_libraries(capturedesk-engine PRIVATE
    windowsapp   # C++/WinRT (Windows.Graphics.Capture)
    d3d11 dxgi   # frame staging
    dwmapi       # DwmGetWindowAttribute (cloaked-window detection)
    ole32        # WASAPI / COM
    mf mfplat mfreadwrite mfuuid  # Media Foundation camera
    windowscodecs # WIC PNG encode for source thumbnails
  )
endif()

if(MSVC)
  target_compile_options(capturedesk-engine PRIVATE /W4 /permissive- /utf-8)
else()
  target_compile_options(capturedesk-engine PRIVATE -Wall -Wextra)
endif()
