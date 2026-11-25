# DeepSeek Harness Desktop for Linux

A **double-click-to-run** desktop build of DeepSeek Harness for Linux, packaged as a single `.deb` for **amd64 (x86-64)** and **arm64**.

> ⚠️ **Unofficial project.** The engine (DeepSeek Harness) is developed and open-sourced by DeepSeek. This repository only provides the desktop shell and packaging scripts. See [NOTICE](NOTICE).

---

## What this is

A small program that does three things:

1. Starts the local DeepSeek Harness service (`dsh web`, bound to 127.0.0.1 only)
2. Shows it in a native window so it feels like a real desktop app
3. Keeps the server alive when you close the window, so it reopens instantly

The package bundles Electron, Node.js and the engine itself — nothing else to install.

## Install

Grab the package for your architecture from [Releases](../../releases):

```bash
# Intel / AMD
sudo dpkg -i deepseek-harness-desktop_*_amd64.deb
# Raspberry Pi / ARM servers
sudo dpkg -i deepseek-harness-desktop_*_arm64.deb

# if dependencies are missing
sudo apt install -f
```

Then launch **DeepSeek Harness** from the application menu, or run `dsh-desktop`.

Uninstall: `sudo dpkg -r deepseek-harness-desktop` (user data in `~/.dsh` is kept).

## Build it yourself

Needs a **Debian/Ubuntu** machine whose architecture matches the target package.

```bash
# 1. engine
npm i -g @deepseek-ai/dsh

# 2. Electron (version matching the engine, see packaging/README.md)
mkdir -p ~/.dsh/electron
unzip electron-v43.3.0-linux-x64.zip -d ~/.dsh/electron

# 3. package
git clone https://github.com/youngererer/dsh-desktop.git
cd dsh-desktop
./packaging/build-deb.sh              # detects the current arch
ARCH=arm64 ./packaging/build-deb.sh   # force a target
VERSION=0.2.2~rc5-1 MAINTAINER="You <you@example.com>" ./packaging/build-deb.sh
```

Output lands in `dist/`.

## Known issues

- **Electron runs with `--no-sandbox`.** The bundled `chrome-sandbox` cannot be made setuid-root in this install layout, so the launcher runs the same Electron binary unsandboxed instead of aborting. The renderer therefore has no OS sandbox. If that matters to you, build from source, `chown root:root` + `chmod 4755` the sandbox helper and drop the flag.
- **Slow first launch.** Spinning up the local service takes 10–30 s; later launches are instant.
- **Ubuntu/Debian only.** On other distros you can `dpkg -x` the package and run `/opt/deepseek-harness/app/launch.sh` manually.

## License

The shell code in this repository is MIT — see [LICENSE](LICENSE). Bundled third-party components (DeepSeek Harness, Electron, Node.js, …) are MIT or their own licenses — see [NOTICE](NOTICE).

No API keys are included; bring your own.
