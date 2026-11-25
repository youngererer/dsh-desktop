#!/bin/sh
# Launcher for the DeepSeek Harness desktop app.
# Starts (or reuses) the local DSH web server and shows it in a native window.
set -eu

SELF=$(readlink -f -- "$0" 2>/dev/null || echo "$0")
APP_DIR=$(dirname -- "$SELF")
APP_DIR=$(cd -- "$APP_DIR" && pwd)
BUNDLE_ROOT=$(dirname -- "$APP_DIR")

if [ -x "$BUNDLE_ROOT/electron/electron" ]; then
  ELECTRON="$BUNDLE_ROOT/electron/electron"
else
  ELECTRON=${DSH_DESKTOP_ELECTRON:-"$HOME/.dsh/electron/electron"}
fi

if [ ! -x "$ELECTRON" ]; then
  MSG="找不到 Electron 运行时：$ELECTRON"
  echo "$MSG" >&2
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="DeepSeek Harness" --text="$MSG" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "DeepSeek Harness" "$MSG" || true
  fi
  exit 1
fi

exec "$ELECTRON" "$APP_DIR" "$@"
