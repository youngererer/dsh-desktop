# Packaging notes

`build-deb.sh` produces a fully self-contained `.deb`. It needs three inputs:

| env var        | default                                        | what it is                                    |
|----------------|------------------------------------------------|-----------------------------------------------|
| `APP_SRC`      | `<repo>/src`                                   | the desktop shell                             |
| `DSH_SRC`      | `/usr/local/lib/node_modules/@deepseek-ai/dsh` | the engine, from `npm i -g @deepseek-ai/dsh`  |
| `ELECTRON_SRC` | `$HOME/.dsh/electron`                          | an unpacked Electron release                  |

## Versions used for 0.2.2~rc5-1

| component | version |
|-----------|---------|
| DeepSeek Harness | 0.2.2-rc.5 |
| Electron | 43.3.0 |
| Node.js | 24.19.0 (from nodejs.org, sha256 pinned in the script) |

## Getting Electron

```bash
# pick the arch of the machine you are building on
curl -fsSLO https://github.com/electron/electron/releases/download/v43.3.0/electron-v43.3.0-linux-x64.zip
mkdir -p ~/.dsh/electron && unzip -q electron-v43.3.0-linux-x64.zip -d ~/.dsh/electron
```

Use `electron-v43.3.0-linux-arm64.zip` for arm64. The zip must be unpacked at the
top level of `ELECTRON_SRC` (i.e. `ELECTRON_SRC/electron` exists).

## Cross-arch builds

The engine tree carries **native binaries** (sharp/libvips, koffi, sherpa-onnx,
ripgrep, node-addon-require-builtin…). They are per-platform and cannot be
swapped by copying alone.

### Option A — build on the target architecture (recommended)

Run the script on an arm64 box for arm64 and on an x64 box for amd64.
`dpkg-deb` never needs to run foreign binaries, and the script verifies every
bundled ELF with a Python check before packing.

### Option B — swap the native modules (what the previous amd64 script did)

Build once on arm64 to get a known-good JS tree, then, on x64:

```bash
mkdir -p /tmp/x64 && cd /tmp/x64
npm init -y
npm i @img/sharp-linux-x64 @img/sharp-libvips-linux-x64 \
      @koromix/koffi-linux-x64 sherpa-onnx-linux-x64 \
      @deepseek-ai/node-addon-system-linux-x64 @vscode/ripgrep-linux-x64 \
      node-addon-require-builtin-linux-x64-gnu
```

Copy that `node_modules` over the engine tree, deleting the `*-linux-arm64`
counterparts first, then run the script with `ARCH=amd64`. The arch verifier at
the end of `build-deb.sh` will tell you if anything is left over.

## What ends up in the package

```
/opt/deepseek-harness/app        desktop shell (this repo)
/opt/deepseek-harness/dsh        DeepSeek Harness engine + node_modules
/opt/deepseek-harness/node       private Node.js runtime
/opt/deepseek-harness/electron   private Electron runtime (launched --no-sandbox)
/usr/bin/dsh-desktop             symlink to app/launch.sh
/usr/share/applications/dsh-desktop.desktop
/usr/share/doc/deepseek-harness-desktop/{LICENSE.*,NOTICE,README,changelog.gz}
```

Runtime state lives outside the package:
`~/.dsh` (profile/credentials) and `~/.local/state/dsh-desktop` (server.json, logs).

## Sandbox note

The bundled `chrome-sandbox` is not setuid and lives on a path dpkg does not
make root-owned, so Electron aborts on startup. The script renames the binary to
`electron.bin` and installs a wrapper that passes `--no-sandbox`. To keep the
sandbox instead, make it root-owned and setuid **after** install:

```bash
sudo chown root:root /opt/deepseek-harness/electron/chrome-sandbox
sudo chmod 4755   /opt/deepseek-harness/electron/chrome-sandbox
```
…and remove the `--no-sandbox` from the wrapper in `build-deb.sh`.
