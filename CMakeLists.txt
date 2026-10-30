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
# libc++ — Apple's and Homebrew LLVM's alike — implements neither
# std::generator nor std::move_only_function yet; third_party/compat provides
# the subset the code uses.
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

# ---- build identity (the startup update check compares it with GitHub) -------
# The exe carries the short commit hash it was built from — the same string the
# release workflow uses as the release tag (v<short hash>). At startup the app
# asks https://github.com/yauntyour/cell-app/releases/latest and compares the
# tag's hash with its own. Generated here (a build always configures after a
# checkout); the write is skipped while the content is unchanged, so an
# ordinary rebuild does not recompile.

set(CELL_BUILD_HPP "${CELL_OUTPUT_DIR}/cell-build-info.hpp")
target_include_directories(cell-app PRIVATE "${CELL_OUTPUT_DIR}")

set(_cell_commit "")
set(_cell_date "")
if(EXISTS "${CMAKE_SOURCE_DIR}/.git/HEAD")
    # a checkout that moves must refresh the hash: these change on commit /
    # pull / checkout, and each one re-runs the configure step before the build
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${CMAKE_SOURCE_DIR}/.git/HEAD" "${CMAKE_SOURCE_DIR}/.git/index")
    find_package(Git QUIET)
    if(GIT_FOUND)
        execute_process(COMMAND "${GIT_EXECUTABLE}" rev-parse --short=7 HEAD
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
            OUTPUT_VARIABLE _cell_commit OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET RESULT_VARIABLE _cell_git_rc)
        if(NOT _cell_git_rc EQUAL 0)
            set(_cell_commit "")
        endif()
        execute_process(COMMAND "${GIT_EXECUTABLE}" log -1 --format=%cI
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
            OUTPUT_VARIABLE _cell_date OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET)
    endif()
endif()

set(_cell_build_info "// generated by CMake — the commit this binary was built from
// (the startup update check compares it with the newest GitHub release)
#pragma once
namespace app::build
{
    inline constexpr const char *commit = \"${_cell_commit}\"; // short hash, \"\" when unknown
    inline constexpr const char *date = \"${_cell_date}\";     // committer date, ISO 8601
}
")
if(EXISTS "${CELL_BUILD_HPP}")
    file(READ "${CELL_BUILD_HPP}" _cell_build_info_old)
else()
    set(_cell_build_info_old "")
endif()
if(NOT _cell_build_info_old STREQUAL _cell_build_info)
    file(WRITE "${CELL_BUILD_HPP}" "${_cell_build_info}")
endif()

# ---- C++23 compatibility shims ----------------------------------------------
# libc++ implements neither C++23's std::generator (P2502R2) nor
# std::move_only_function (P0288R9): neither the macOS system libc++ nor the
# one shipped with Homebrew LLVM has them (checked up to LLVM 23), while
# libstdc++ ships both since GCC 14/12 and MSVC since 19.43/19.32. When the
# standard library cannot provide one of them, put third_party/compat on the
# include path — it holds a `generator` header and a `functional` header that
# forward to the real ones (include_next) and add the subset cell.cpp uses;
# each guards on the standard library itself, so this check only decides
# whether the directory is needed at all.
include(CheckIncludeFileCXX)
include(CheckCXXSourceCompiles)
if(NOT MSVC)
    # older CMake does not pass CMAKE_CXX_STANDARD into the checks, so hand
    # the standard over explicitly
    set(_cell_compat_check_flag "-std=c++${CELL_CXX_STANDARD}")
endif()
check_include_file_cxx("generator" CELL_HAS_STD_GENERATOR ${_cell_compat_check_flag})
set(CMAKE_REQUIRED_FLAGS "${_cell_compat_check_flag}")
check_cxx_source_compiles("
#include <functional>
int main()
{
    std::move_only_function<void()> probe = [] {};
    probe();
    return probe ? 0 : 1;
}" CELL_HAS_STD_MOVE_ONLY_FUNCTION)
unset(CMAKE_REQUIRED_FLAGS)
if(NOT CELL_HAS_STD_GENERATOR OR NOT CELL_HAS_STD_MOVE_ONLY_FUNCTION)
    message(STATUS "cell-app: standard library lacks <generator> / std::move_only_function — using third_party/compat")
    target_include_directories(cell-app SYSTEM BEFORE PRIVATE
        "${CMAKE_SOURCE_DIR}/third_party/compat")
endif()

# ---- platform wiring --------------------------------------------------------

if(NOT WIN32)
    find_package(Threads REQUIRED)
    # forkpty/openpty live in libutil where it is still a separate library
    # (glibc before 2.34); macOS folds them into libSystem, so the library is
    # optional there and only linked when the SDK provides it.
    find_library(CELL_UTIL_LIBRARY util)
    set(_cell_util_libs "")
    if(CELL_UTIL_LIBRARY)
        list(APPEND _cell_util_libs ${CELL_UTIL_LIBRARY})
    endif()
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

    # the system libcurl comes with the SDK: plain `curl` links -lcurl through
    # the sysroot, and <curl/curl.h> resolves in the SDK's usr/include, which
    # clang adds after its own headers. find_package(CURL) must not be used
    # here: its imported target adds CURL_INCLUDE_DIR as a *system* include,
    # and with the SDK path that lands in front of libc++'s <c++/v1> — then
    # <cstdlib> finds the SDK's <stdlib.h> instead of libc++'s wrapper
    # ("tried including <stdlib.h> but didn't find libc++'s <stdlib.h>
    # header") and every libc++ header fails. It would also happily resolve
    # to Homebrew's curl, which the shipped binary must not depend on.
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
        curl ${SODIUM_LIBRARY} Threads::Threads ${_cell_util_libs})

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

    # util: forkpty for the terminal panel's pty sessions (glibc)
    target_link_libraries(cell-app PRIVATE
        PkgConfig::GTK PkgConfig::WEBKIT
        CURL::libcurl ${SODIUM_LIBRARY} Threads::Threads ${_cell_util_libs})
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
