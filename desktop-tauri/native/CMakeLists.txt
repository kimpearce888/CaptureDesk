# CaptureDesk native engine (capturedesk-engine)
# C++17 stdio sidecar: Windows capture (WGC/WASAPI/MF) + FFmpeg encode/transcode.
#
# Dependencies (vcpkg on Windows, system packages on Linux CI):
#   nlohmann-json, ffmpeg (avcodec avformat avutil swscale swresample)
# Windows SDK: C++/WinRT (Windows.Graphics.Capture), WASAPI, Media Foundation, WIC.
#
# Linux builds are transcode/export capable (capture is Windows-only in v2 alpha).

cmake_minimum_required(VERSION 3.21)
project(capturedesk-engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(nlohmann_json CONFIG REQUIRED)
find_package(FFMPEG REQUIRED COMPONENTS avcodec avformat avutil swscale swresample)

add_executable(capturedesk-engine
  src/main.cpp
  src/session.cpp
  src/encoder.cpp
  src/transcode.cpp
)

target_include_directories(capturedesk-engine PRIVATE include ${FFMPEG_INCLUDE_DIRS})
target_link_libraries(capturedesk-engine PRIVATE nlohmann_json::nlohmann_json ${FFMPEG_LIBRARIES})

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
