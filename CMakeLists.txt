# cell-app — the desktop shell + web service for cell.cpp
# =============================================================================
# Cross-platform build (the successor of build-gui.sh):
#
#   cmake -B build            # configure  (Ninja / Makefiles / Xcode)
#   cmake --build build       # compile    → build/cell-app[.exe]
#
# On Windows, run CMake from the MSYS2 "UCRT64" shell (the toolchain must be on
# PATH), or point it at the toolchain explicitly:
#   cmake -B build -G Ninja -DCMAKE_CXX_COMPILER=D:/x64/msys2/ucrt64/bin/g++.exe
#
# Options:
#   -DCELL_STATIC=OFF         Windows only: link against MSYS2 DLLs (default: static)
#   -DCELL_CONSOLE=ON         Windows only: keep a console window (debugging)
#   -DCELL_CXX_STANDARD=23    compilers without -std=c++26 (e.g. Apple clang)
#   -DCELL_BUILD_UI=OFF       keep the committed src/cell-ui.hpp (no Python needed)
#   -DPython3_EXECUTABLE=...  interpreter for the embedded-UI step (or set PYTHON)
#
# Platforms:
#   Windows (MSYS2 UCRT64): WebView2 window, statically linked by default —
#       the only imports left are Windows system DLLs (zero third-party DLLs).
#   Linux:   GTK3 + WebKitGTK window. The GTK stack only ships shared, so the
#       runtime deps come from the distro (same as any native Linux app).
#   macOS:   Cocoa + WKWebView (system frameworks), clang++, libsodium via brew.
#
# The code needs C++23 (std::generator / expected / move_only_function) and
# builds with -std=c++26 by default; no C++26-only features are used.
# =============================================================================

cmake_minimum_required(VERSION 3.25)

project(cell-app LANGUAGES CXX)

# the agent core lives in the cell.cpp submodule
if(NOT EXISTS "${CMAKE_SOURCE_DIR}/cell.cpp/cell.cpp")
    message(FATAL_ERROR
        "cell.cpp/cell.cpp not found — initialize the submodule first:\n"
        "  git submodule update --init --recursive")
endif()

# ---- options ----------------------------------------------------------------

option(CELL_STATIC "Windows only: link the runtime + libcurl/libsodium statically" ON)
option(CELL_CONSOLE "Windows only: keep a console window (debugging)" OFF)
option(CELL_BUILD_UI "Regenerate the embedded UI from src/ui/src before building" ON)

set(CELL_CXX_STANDARD "26" CACHE STRING
    "C++ standard (26 by default; set 23 on compilers without -std=c++26)")

# ---- artifacts land in <source>/build ---------------------------------------

set(CELL_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/build" CACHE PATH
    "Directory the built executable lands in")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CELL_OUTPUT_DIR}")
foreach(_cell_cfg DEBUG RELEASE RELWITHDEBINFO MINSIZEREL) # multi-config generators
    set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_${_cell_cfg} "${CELL_OUTPUT_DIR}")
endforeach()

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS Debug Release RelWithDebInfo MinSizeRel)
endif()

set(CMAKE_CXX_STANDARD "${CELL_CXX_STANDARD}")
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON) # clangd / VS Code IntelliSense

# ---- Windows: MSYS2 (MinGW) + windres for the icon --------------------------

if(WIN32)
    if(NOT MINGW)
        message(FATAL_ERROR
            "Windows builds use the MSYS2 UCRT64 (MinGW) toolchain. Run CMake from the "
            "MSYS2 UCRT64 shell, or point it at the toolchain explicitly, e.g.\n"
            "  cmake -B build -G Ninja -DCMAKE_CXX_COMPILER=D:/x64/msys2/ucrt64/bin/g++.exe")
    endif()
    # windres next to the compiler when it is not on PATH; assets/icon.rc embeds
    # assets/icon.ico as resource id 1 (webview.h loads it as the window icon)
    if(NOT CMAKE_RC_COMPILER)
        get_filename_component(_cell_bindir "${CMAKE_CXX_COMPILER}" DIRECTORY)
        if(EXISTS "${_cell_bindir}/windres.exe")
            set(CMAKE_RC_COMPILER "${_cell_bindir}/windres.exe"
                CACHE FILEPATH "Windows resource compiler")
        endif()
    endif()
    enable_language(RC)
endif()

# ---- the application --------------------------------------------------------

add_executable(cell-app src/cell-app.cpp)

target_include_directories(cell-app PRIVATE
    "${CMAKE_SOURCE_DIR}/src"                  # cell-app-core.hpp, cell-ui.hpp, …
    "${CMAKE_SOURCE_DIR}/third_party/include"  # webview/, servic.hpp, router/
    "${CMAKE_SOURCE_DIR}")                     # "cell.cpp/cell.cpp" (the submodule)

# ---- platform wiring --------------------------------------------------------

if(NOT WIN32)
    find_package(Threads REQUIRED)
endif()

if(WIN32)   # MSYS2 UCRT64 — WebView2 window

    find_package(PkgConfig REQUIRED)

    # libcurl via pkg-config. The <…>_LIBRARIES lists carry the -l names only;
    # they all resolve through the toolchain's default library search path. In
    # static mode the --static set also pulls in the transitive dependencies
    # (zlib, brotli, ssl, ssh2, …) and their static-linking defines —
    # -DCURL_STATICLIB makes curl's headers declare plain symbols instead of
    # dllimport ones (without it the link fails with __imp_curl_*).
    pkg_check_modules(CURL REQUIRED libcurl)
    target_include_directories(cell-app PRIVATE ${CURL_INCLUDE_DIRS})
    if(CELL_STATIC)
        target_compile_definitions(cell-app PRIVATE ${CURL_STATIC_CFLAGS_OTHER})
        target_link_options(cell-app PRIVATE -static)
        set(_cell_curl_libs ${CURL_STATIC_LIBRARIES})
    else()
        set(_cell_curl_libs ${CURL_LIBRARIES})
    endif()

    # crypt32: cell::net's CA-bundle resolver walks the Windows ROOT store via
    # CertOpenSystemStore/CryptBinaryCertificateToStr. Without it a statically
    # linked libcurl trusts nothing (its baked-in CA path is a POSIX path) and
    # every HTTPS request fails with curl 60 "Problem with the SSL CA cert".
    # uuid: CLSID_FileOpenDialog / IID_IFileOpenDialog (host_pick_folder's
    # native folder picker) live in libuuid. The rest are Win32/BCrypt/socket
    # imports across cell.cpp, webview.h and libsodium.
    target_link_libraries(cell-app PRIVATE
        ${_cell_curl_libs}
        sodium
        ole32 shell32 shlwapi uuid user32 version advapi32
        gdi32 ws2_32 mswsock bcrypt crypt32)

    # windowed subsystem (-mwindows) by default; -DCELL_CONSOLE=ON keeps the console
    if(CELL_CONSOLE)
        set_target_properties(cell-app PROPERTIES WIN32_EXECUTABLE OFF)
    else()
        set_target_properties(cell-app PROPERTIES WIN32_EXECUTABLE ON)
    endif()

    # application icon: compile assets/icon.rc (icon.ico → resource id 1) and
    # link it; webview.h loads the resource as the window class icon
    set(_cell_icon_rc "${CMAKE_SOURCE_DIR}/assets/icon.rc")
    if(EXISTS "${_cell_icon_rc}")
        target_sources(cell-app PRIVATE "${_cell_icon_rc}")
        # windres resolves `ICON "icon.ico"` through its include path
        set_source_files_properties("${_cell_icon_rc}" PROPERTIES
            INCLUDE_DIRECTORIES "${CMAKE_SOURCE_DIR}/assets")
    else()
        message(WARNING "assets/icon.rc not found — the exe keeps no embedded icon")
    endif()

elseif(APPLE)   # Cocoa + WKWebView; libsodium is the one Homebrew dependency

    find_package(CURL REQUIRED)
    find_library(SODIUM_LIBRARY NAMES sodium
        HINTS /opt/homebrew/lib /usr/local/lib REQUIRED)
    find_path(SODIUM_INCLUDE_DIR sodium.h
        HINTS /opt/homebrew/include /usr/local/include)
    if(SODIUM_INCLUDE_DIR)
        target_include_directories(cell-app PRIVATE "${SODIUM_INCLUDE_DIR}")
    endif()
    # Homebrew also keeps the header-only deps (boost.asio, nlohmann/json) off
    # the default include path
    find_path(CELL_BREW_INCLUDE_DIR boost/asio.hpp
        HINTS /opt/homebrew/include /usr/local/include)
    if(CELL_BREW_INCLUDE_DIR)
        target_include_directories(cell-app PRIVATE "${CELL_BREW_INCLUDE_DIR}")
    endif()

    target_link_libraries(cell-app PRIVATE
        "-framework Cocoa" "-framework WebKit"
        CURL::libcurl ${SODIUM_LIBRARY} Threads::Threads)

else()          # Linux — GTK3 + WebKitGTK

    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GTK REQUIRED IMPORTED_TARGET gtk+-3.0)
    pkg_check_modules(WEBKIT IMPORTED_TARGET webkit2gtk-4.1)
    if(NOT WEBKIT_FOUND)
        pkg_check_modules(WEBKIT IMPORTED_TARGET webkit2gtk-4.0)
    endif()
    if(NOT WEBKIT_FOUND)
        message(FATAL_ERROR
            "WebKitGTK development package not found. Install:\n"
            "  webkit2gtk-4.1-dev + libgtk-3-dev  (Debian/Ubuntu)\n"
            "  webkit2gtk4.1-devel + gtk3-devel  (Fedora)\n"
            "  webkit2gtk-4.1 + gtk3             (Arch)\n"
            "plus libcurl4-openssl-dev, libsodium-dev, nlohmann-json3-dev, libboost-dev.")
    endif()

    find_package(CURL REQUIRED)
    find_library(SODIUM_LIBRARY NAMES sodium REQUIRED)

    target_link_libraries(cell-app PRIVATE
        PkgConfig::GTK PkgConfig::WEBKIT
        CURL::libcurl ${SODIUM_LIBRARY} Threads::Threads)
endif()

# ---- embedded UI ------------------------------------------------------------
# src/ui/src/{index.html,css/*.css,js/*.js}  →  src/cell-ui.hpp (the only file
# the C++ build needs) and src/ui/index.html (the dev-loop page served by
# `cell-app.exe --headless PORT --ui src/ui/index.html`). Declaring cell-ui.hpp
# as the command's OUTPUT lets the compiler's depfile tie the compile edge to
# the regenerated header, so one `cmake --build` after a UI edit produces a
# fresh binary; build_ui.py itself only rewrites when the content changed.

if(CELL_BUILD_UI)
    if(DEFINED ENV{PYTHON} AND NOT Python3_EXECUTABLE)
        set(Python3_EXECUTABLE "$ENV{PYTHON}")
    endif()
    find_package(Python3 COMPONENTS Interpreter QUIET)
endif()

if(CELL_BUILD_UI AND Python3_Interpreter_FOUND)
    file(GLOB_RECURSE CELL_UI_SOURCES CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/src/ui/src/*")
    set(CELL_UI_HPP "${CMAKE_SOURCE_DIR}/src/cell-ui.hpp")
    add_custom_command(
        OUTPUT "${CELL_UI_HPP}"
        BYPRODUCTS "${CMAKE_SOURCE_DIR}/src/ui/index.html"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/build_ui.py"
        WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
        DEPENDS "${CMAKE_SOURCE_DIR}/build_ui.py" ${CELL_UI_SOURCES}
        COMMENT "Embedding the UI (src/ui/src → src/cell-ui.hpp)"
        VERBATIM)
    add_custom_target(cell-ui DEPENDS "${CELL_UI_HPP}")
    add_dependencies(cell-app cell-ui)
elseif(CELL_BUILD_UI)
    message(WARNING
        "Python 3 not found — keeping the committed src/cell-ui.hpp. "
        "Pass -DPython3_EXECUTABLE=... or set the PYTHON environment variable "
        "to regenerate the embedded UI.")
endif()

# ---- summary ----------------------------------------------------------------

message(STATUS "cell-app: C++${CELL_CXX_STANDARD}, executable lands in ${CELL_OUTPUT_DIR}")
