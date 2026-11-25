#!/usr/bin/env bash
# Build a self-contained .deb for the DeepSeek Harness desktop app.
#
#   ./build-deb.sh                        # build for the current machine's arch
#   ARCH=arm64 ./build-deb.sh             # force a target arch
#   SKIP_BUILD=1 ./build-deb.sh           # only stage the tree, don't pack
#
# The package bundles four things:
#   * the desktop shell in ../src               (this repo, MIT)
#   * DeepSeek Harness engine                   (npm global install, MIT, DeepSeek)
#   * Electron runtime                          (MIT, Electron contributors)
#   * Node.js 24 runtime                        (MIT, Node.js contributors)
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
SRC=$ROOT/src
CACHE=${CACHE:-$ROOT/cache}

PKG=deepseek-harness-desktop
VERSION=${VERSION:-0.2.2~rc5-1}
MAINTAINER=${MAINTAINER:-"Local Packager <you@example.com>"}

# ---- target architecture -------------------------------------------------
case "${ARCH:-$(uname -m)}" in
  x86_64|amd64)  ARCH=amd64; NODE_ARCH=linux-x64 ;;
  aarch64|arm64) ARCH=arm64; NODE_ARCH=linux-arm64 ;;
  *) echo "unsupported ARCH=$ARCH (use amd64 or arm64)" >&2; exit 1 ;;
esac

NODE_VERSION=24.19.0
NODE_DIR=$CACHE/node-v${NODE_VERSION}-${NODE_ARCH}
NODE_TARBALL=$CACHE/node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz
case $NODE_ARCH in
  linux-arm64) NODE_SHA256=01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc ;;
  linux-x64)   NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647 ;;
esac

# ---- inputs (override with env vars if your layout differs) --------------
APP_SRC=${APP_SRC:-$SRC}
DSH_SRC=${DSH_SRC:-/usr/local/lib/node_modules/@deepseek-ai/dsh}
ELECTRON_SRC=${ELECTRON_SRC:-$HOME/.dsh/electron}

BUILD=$ROOT/build-$ARCH
PKGROOT=$BUILD/root
OUT=$ROOT/dist/${PKG}_${VERSION}_${ARCH}.deb

log() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

for path in "$APP_SRC/main.js" "$APP_SRC/launch.sh" "$DSH_SRC/lib/bin.js" \
            "$ELECTRON_SRC/electron"; do
  [ -e "$path" ] || die "missing input: $path
  - DSH_SRC: run 'npm i -g @deepseek-ai/dsh' (default $DSH_SRC)
  - ELECTRON_SRC: unzip an Electron release to \$HOME/.dsh/electron
  - or point the env var at wherever yours lives"
done

# The engine tree must match the target arch: its native modules
# (sharp, koffi, sherpa-onnx, ripgrep, ...) are per-platform binaries.
if [ "$ARCH" = "amd64" ]; then
  [ -d "$DSH_SRC/node_modules/@img/sharp-linux-x64" ] || die \
    "$DSH_SRC looks like an arm64 tree but ARCH=amd64.
  Cross-building needs a native x64 node_modules tree; see packaging/README.md"
else
  [ -d "$DSH_SRC/node_modules/@img/sharp-linux-arm64" ] || die \
    "$DSH_SRC looks like an x64 tree but ARCH=arm64.
  Cross-building needs a native arm64 node_modules tree; see packaging/README.md"
fi

log "Node.js ${NODE_VERSION} (${NODE_ARCH})"
mkdir -p "$CACHE" "$ROOT/dist"
if [ ! -d "$NODE_DIR" ]; then
  [ -f "$NODE_TARBALL" ] || curl -fsSL -o "$NODE_TARBALL" \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  echo "$NODE_SHA256  $NODE_TARBALL" | sha256sum -c -
  tar -xf "$NODE_TARBALL" -C "$CACHE"
fi

log "Staging package tree ($ARCH)"
rm -rf "$BUILD"
for d in opt/deepseek-harness/app usr/bin usr/share/applications \
         usr/share/icons/hicolor/512x512/apps \
         usr/share/icons/hicolor/256x256/apps \
         usr/share/icons/hicolor/128x128/apps \
         usr/share/doc/$PKG DEBIAN; do
  mkdir -p "$PKGROOT/$d"
done

cp -a "$APP_SRC/main.js" "$APP_SRC/splash.html" "$APP_SRC/icon.png" \
      "$APP_SRC/package.json" "$APP_SRC/launch.sh" \
      "$PKGROOT/opt/deepseek-harness/app/"
chmod 755 "$PKGROOT/opt/deepseek-harness/app/launch.sh"
chmod 644 "$PKGROOT/opt/deepseek-harness/app/"{main.js,splash.html,package.json,icon.png}

log "Bundling Electron runtime"
mkdir -p "$PKGROOT/opt/deepseek-harness/electron"
cp -a "$ELECTRON_SRC/." "$PKGROOT/opt/deepseek-harness/electron/"
# The bundled chrome-sandbox cannot be setuid-root in this install layout,
# so run the same Electron binary unsandboxed instead of aborting.
mv "$PKGROOT/opt/deepseek-harness/electron/electron" \
   "$PKGROOT/opt/deepseek-harness/electron/electron.bin"
cat > "$PKGROOT/opt/deepseek-harness/electron/electron" <<'EOF'
#!/bin/sh
exec "$(dirname "$0")/electron.bin" --no-sandbox "$@"
EOF
chmod 755 "$PKGROOT/opt/deepseek-harness/electron/electron" \
          "$PKGROOT/opt/deepseek-harness/electron/chrome-sandbox"

log "Bundling Node.js runtime"
mkdir -p "$PKGROOT/opt/deepseek-harness/node"
cp -a "$NODE_DIR/." "$PKGROOT/opt/deepseek-harness/node/"

log "Bundling DeepSeek Harness engine"
mkdir -p "$PKGROOT/opt/deepseek-harness/dsh"
cp -a "$DSH_SRC/." "$PKGROOT/opt/deepseek-harness/dsh/"

log "Generating icons"
ICON_SRC="$APP_SRC/icon.png" ICON_OUT="$PKGROOT/usr/share/icons/hicolor" \
NODE_PATH="$DSH_SRC/node_modules" "$NODE_DIR/bin/node" - <<'JS'
const sharp = require('sharp');
const path = require('node:path');
(async () => {
  for (const size of [512, 256, 128]) {
    const dir = path.join(process.env.ICON_OUT, `${size}x${size}`, 'apps');
    await sharp(process.env.ICON_SRC).resize(size, size).png()
      .toFile(path.join(dir, 'dsh-desktop.png'));
  }
})().catch((e) => { console.error(e); process.exit(1); });
JS

cat > "$PKGROOT/usr/share/applications/dsh-desktop.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Version=1.0
Name=DeepSeek Harness
GenericName=AI Agent
Comment=DeepSeek Harness AI agent desktop app
Exec=/opt/deepseek-harness/app/launch.sh
Icon=dsh-desktop
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=dsh-desktop
EOF
chmod 644 "$PKGROOT/usr/share/applications/dsh-desktop.desktop"
ln -sf /opt/deepseek-harness/app/launch.sh "$PKGROOT/usr/bin/dsh-desktop"

log "Package metadata"
cp "$DSH_SRC/LICENSE" "$PKGROOT/usr/share/doc/$PKG/LICENSE.dsh"
[ -f "$ELECTRON_SRC/LICENSE" ] && cp "$ELECTRON_SRC/LICENSE" "$PKGROOT/usr/share/doc/$PKG/LICENSE.electron"
[ -f "$NODE_DIR/LICENSE" ]     && cp "$NODE_DIR/LICENSE"     "$PKGROOT/usr/share/doc/$PKG/LICENSE.node"
cp "$ROOT/LICENSE" "$PKGROOT/usr/share/doc/$PKG/LICENSE.shell"
cp "$ROOT/NOTICE"  "$PKGROOT/usr/share/doc/$PKG/copyright"

cat > "$PKGROOT/usr/share/doc/$PKG/README" <<EOF
DeepSeek Harness Desktop ($ARCH)
================================

Launch from the application menu ("DeepSeek Harness"), or run:  dsh-desktop

First start creates the profile in ~/.dsh and shows the API setup screen.
The app keeps a local DSH server running in the background; closing the
window only closes the view. To stop the server, open the app and use
Alt -> 应用 -> 停止服务并退出.

Files:
  /opt/deepseek-harness/app       desktop shell
  /opt/deepseek-harness/dsh       DeepSeek Harness engine
  /opt/deepseek-harness/node      private Node.js runtime
  /opt/deepseek-harness/electron  private Electron runtime
  ~/.dsh                          user profile and credentials
  ~/.local/state/dsh-desktop      launcher state and logs
EOF

INSTALLED_SIZE=$(du -sk "$PKGROOT" | cut -f1)
cat > "$PKGROOT/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: devel
Priority: optional
Architecture: $ARCH
Installed-Size: $INSTALLED_SIZE
Maintainer: $MAINTAINER
Depends: libc6 (>= 2.28), libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libasound2 | libasound2t64, libgbm1, libxkbcommon0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libcups2 | libcups2t64, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libatspi2.0-0 | libatspi2.0-0t64, libpango-1.0-0, libcairo2, libglib2.0-0 | libglib2.0-0t64, libdbus-1-3, libexpat1, libudev1, libstdc++6, zlib1g, xdg-utils
Description: DeepSeek Harness AI agent desktop app (self-contained, $ARCH)
 This package bundles the Electron desktop shell, a private Node.js runtime
 and the DeepSeek Harness agent engine, so it runs on $ARCH Ubuntu/Debian
 without any additional installation.
 .
 It starts a local DSH web service on 127.0.0.1 and shows it in a native
 window. User data stays in ~/.dsh and ~/.local/state/dsh-desktop.
EOF

cat > "$PKGROOT/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database -q /usr/share/applications || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && \
    gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
fi
exit 0
EOF
printf '#!/bin/sh\nset -e\nexit 0\n' > "$PKGROOT/DEBIAN/prerm"
chmod 755 "$PKGROOT/DEBIAN/postinst" "$PKGROOT/DEBIAN/prerm"

cat > "$PKGROOT/usr/share/doc/$PKG/changelog" <<EOF
$PKG ($VERSION) unstable; urgency=low

  * Self-contained $ARCH build.

 -- ${MAINTAINER#*<}  $(date -R)
EOF
gzip -9 -fn "$PKGROOT/usr/share/doc/$PKG/changelog"

log "Verifying: every bundled ELF is $ARCH"
python3 - "$PKGROOT/opt/deepseek-harness" "$ARCH" <<'PY' || die "architecture verification failed"
import os, struct, sys
root, target = sys.argv[1], sys.argv[2]
want = {'amd64': 62, 'arm64': 183}[target]
M = {183: 'arm64', 62: 'x86-64', 3: 'i386', 40: 'arm'}
bad, n = [], 0
for dp, _, fn in os.walk(root):
    for f in fn:
        p = os.path.join(dp, f)
        try:
            with open(p, 'rb') as fh:
                h = fh.read(20)
        except OSError:
            continue
        if h[:4] != b'\x7fELF' or len(h) < 20:
            continue
        n += 1
        machine = struct.unpack('<H', h[18:20])[0]
        if machine != want:
            bad.append((M.get(machine, str(machine)), os.path.relpath(p, root)))
if bad:
    for arch, rel in bad[:15]:
        print('WRONG ARCH', arch, rel)
    sys.exit(1)
print(f'{n} ELF files checked, all {target}')
PY

log "Staged: $(du -sh "$PKGROOT" | cut -f1) ($INSTALLED_SIZE KiB)"

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "SKIP_BUILD=1 -> staged only at $PKGROOT"; exit 0
fi

log "Building $OUT"
rm -f "$OUT"
case $ARCH in
  amd64) COMP='-Zzstd -z19' ;;
  arm64) COMP='-Zxz -z6' ;;
esac
dpkg-deb --build --root-owner-group $COMP --threads-max=4 "$PKGROOT" "$OUT"

log "Done"
dpkg-deb --info "$OUT" | head -12
ls -lh "$OUT"
