#!/usr/bin/env bash
# Build the cell shell (desktop window + web service) for the host platform.
#
#   ./build-gui.sh              # release build
#   ./build-gui.sh --shared     # Windows only: link against MSYS2 DLLs
#   ./build-gui.sh --console    # Windows only: keep a console (debugging)
#
# Platforms:
#   Windows (MSYS2 UCRT64): WebView2 window, statically linked by default —
#       the only imports left are Windows system DLLs (zero third-party DLLs).
#   Linux:   GTK3 + WebKitGTK window. The GTK stack only ships shared, so the
#       runtime deps come from the distro (same as any native Linux app).
#   macOS:   Cocoa + WKWebView (system frameworks), clang++, libsodium via brew.
#
# The compiler standard can be overridden: STD=-std=c++23 ./build-gui.sh
# (the code needs C++23 — generator/expected/move_only_function — but no
# C++26-only features).
set -euo pipefail
cd "$(dirname "$0")"

CONSOLE=0
STATIC=1
for arg in "$@"; do
    case "$arg" in
        --console) CONSOLE=1 ;;
        --static)  STATIC=1 ;;
        --shared)  STATIC=0 ;;
        *) echo "unknown option: $arg" >&2; exit 1 ;;
    esac
done

STD="${STD:--std=c++26}"
APP="cell-app"

case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*)
    APP="cell-app.exe"
    CXX="${CXX:-D:/x64/msys2/ucrt64/bin/g++.exe}"
    PKGCFG="${PKGCFG:-D:/x64/msys2/ucrt64/bin/pkg-config.exe}"
    MODE="-mwindows"
    [ "$CONSOLE" = 1 ] && MODE="-mconsole"
    if [ "$STATIC" = 1 ]; then
        # -DCURL_STATICLIB makes curl's headers declare plain symbols instead
        # of dllimport ones (without it the link fails with __imp_curl_*)
        SFLAGS="-static -DCURL_STATICLIB"
        LIBS="$("$PKGCFG" --static --libs libcurl) -lsodium"
    else
        SFLAGS=""
        LIBS="-lcurl -lsodium"
    fi
    # crypt32: cell::net's CA-bundle resolver walks the Windows ROOT store via
    # CertOpenSystemStore/CryptBinaryCertificateToStr. Without it a statically
    # linked libcurl trusts nothing (its baked-in CA path is a POSIX path) and
    # every HTTPS request fails with curl 60 "Problem with the SSL CA cert".
    # uuid: CLSID_FileOpenDialog / IID_IFileOpenDialog (host_pick_folder's
    # native folder picker) live in libuuid.
    LIBS="$LIBS -lole32 -lshell32 -lshlwapi -luuid -luser32 -lversion -ladvapi32 -lgdi32 -lws2_32 -lmswsock -lbcrypt -lcrypt32"
    # application icon: compile icon.rc (icon.ico -> resource id 1) and link it;
    # webview.h loads the resource as the window class icon (see icon.rc)
    RES=""
    if [ -f icon.ico ]; then
        WINDRES="${WINDRES:-$(dirname "$CXX")/windres.exe}"
        if [ ! -x "$WINDRES" ]; then WINDRES="$(command -v windres || true)"; fi
        if [ -n "$WINDRES" ] && [ -x "$WINDRES" ]; then
            mkdir -p bin
            "$WINDRES" icon.rc -O coff -o bin/icon.res
            RES="bin/icon.res"
        else
            echo "warning: windres not found; the exe keeps no embedded icon" >&2
        fi
    fi
    ;;
Linux)
    CXX="${CXX:-g++}"
    MODE=""
    SFLAGS=""
    WEBKIT_PC=""
    if pkg-config --exists webkit2gtk-4.1; then
        WEBKIT_PC="webkit2gtk-4.1"
    elif pkg-config --exists webkit2gtk-4.0; then
        WEBKIT_PC="webkit2gtk-4.0"
    else
        echo "error: WebKitGTK development package not found." >&2
        echo "  install: webkit2gtk-4.1-dev + libgtk-3-dev (Debian/Ubuntu)," >&2
        echo "           webkit2gtk4.1-devel + gtk3-devel (Fedora)," >&2
        echo "           webkit2gtk-4.1 + gtk3 (Arch), plus libsodium-dev libcurl-dev" >&2
        exit 1
    fi
    LIBS="$(pkg-config --libs gtk+-3.0 "$WEBKIT_PC") -lcurl -lsodium -pthread"
    ;;
Darwin)
    CXX="${CXX:-clang++}"
    MODE=""
    SFLAGS=""
    # Cocoa + WKWebView are system frameworks; curl is a system library too.
    # libsodium is the one Homebrew dependency (brew install libsodium).
    LIBS="-framework Cocoa -framework WebKit -lcurl -lsodium -pthread"
    ;;
*)
    echo "unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

mkdir -p bin

# embed the UI: ui/src/{index.html,css/*.css,js/*.js} are the sources,
# scripts/build_ui.py assembles them into ui/index.html (dev loop) and
# cell-ui.hpp (the only artifact the C++ build needs). During development,
# skip the rebuild entirely with:  cell-app.exe --ui ui/index.html
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
    for cand in python3 python py; do
        if command -v "$cand" >/dev/null 2>&1; then
            PY="$cand"
            break
        fi
    done
fi
if [ -n "$PY" ]; then
    "$PY" scripts/build_ui.py || exit 1
else
    echo "warning: no python3/python found; keeping the committed cell-ui.hpp" >&2
    echo "         (set PYTHON=/path/to/python to regenerate the embedded UI)" >&2
fi

# shellcheck disable=SC2086
"$CXX" "$STD" -O2 $MODE $SFLAGS -o "bin/$APP" cell-app.cpp \
    -Ithird_party/include \
    $RES $LIBS

echo "built: bin/$APP ($(uname -s), $([ "$STATIC" = 1 ] && echo static || echo shared))"
