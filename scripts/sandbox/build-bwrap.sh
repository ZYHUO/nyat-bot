#!/bin/sh
# Build private test dependencies only. Does not install a service, setuid bit,
# sudo rule, kernel setting, or system package. Run explicitly in staging.
set -eu
BUILD=/opt/nyatbot-staging/sandbox-build
PREFIX="$BUILD/private"
case "$PREFIX" in /opt/nyatbot-staging/sandbox-build/private) ;; *) exit 2;; esac
mkdir -p "$BUILD" "$PREFIX"
cd "$BUILD"
export PATH="/opt/nyatbot-python/bin:/usr/bin:/bin"
curl -fL --retry 2 --max-time 90 -o libcap-2.78.tar.xz https://www.kernel.org/pub/linux/libs/security/linux-privs/libcap2/libcap-2.78.tar.xz
printf '%s\n' '0d621e562fd932ccf67b9660fb018e468a683d7b827541df27813228c996bb11  libcap-2.78.tar.xz' | sha256sum -c -
curl -fL --retry 2 --max-time 90 -o bubblewrap-0.13.1.tar.xz https://github.com/containers/bubblewrap/releases/download/v0.13.1/bubblewrap-0.13.1.tar.xz
printf '%s\n' '0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d  bubblewrap-0.13.1.tar.xz' | sha256sum -c -
tar -xf libcap-2.78.tar.xz
tar -xf bubblewrap-0.13.1.tar.xz
make -C libcap-2.78/libcap -j2 GOLANG=no RAISE_SETFCAP=no prefix="$PREFIX" lib=lib all
make -C libcap-2.78/libcap GOLANG=no RAISE_SETFCAP=no prefix="$PREFIX" lib=lib install
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
meson setup bwrap-build bubblewrap-0.13.1 --prefix="$PREFIX" \
  -Dselinux=disabled -Dman=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled \
  -Dbuild_rpath="$PREFIX/lib" -Dinstall_rpath="$PREFIX/lib" -Dpython=/opt/nyatbot-python/bin/python3.12
meson compile -C bwrap-build
meson install -C bwrap-build
"$PREFIX/bin/bwrap" --version
