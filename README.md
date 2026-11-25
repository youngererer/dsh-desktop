# DeepSeek Harness Desktop for Linux

在 Linux 上**双击就能用**的 DeepSeek Harness 桌面版，打包成单个 `.deb` 安装包，支持 **amd64 (x86-64)** 和 **arm64**。

> ⚠️ **非官方项目。** 引擎（DeepSeek Harness）由 DeepSeek 官方开发并开源，本仓库只提供「桌面外壳 + 打包脚本」。详见 [NOTICE](NOTICE)。

---

## 这是什么

一个只有几十 KB 的小程序，负责三件事：

1. 在你电脑上启动 DeepSeek Harness 的本地服务（`dsh web`，只听 127.0.0.1）
2. 用一个原生窗口把它显示出来，看起来像一个真正的桌面 App
3. 关窗口时不杀后台服务，下次打开秒开

安装包里自带 Electron、Node.js 和引擎本体，**装完不用再装任何东西**。

## 安装

从 [Releases](../../releases) 下载对应架构的包：

```bash
# Intel / AMD 电脑
sudo dpkg -i deepseek-harness-desktop_*_amd64.deb
# 树莓派 / ARM 服务器 / 飞腾、鲲鹏等
sudo dpkg -i deepseek-harness-desktop_*_arm64.deb

# 如果有依赖缺失
sudo apt install -f
```

装完在应用菜单里找 **DeepSeek Harness**，或者终端里执行 `dsh-desktop`。

卸载：`sudo dpkg -r deepseek-harness-desktop`（用户数据在 `~/.dsh`，不会自动删）。

## 自己编译

需要一台 **Debian/Ubuntu** 机器（架构要和目标包一致）。

```bash
# 1. 装引擎
npm i -g @deepseek-ai/dsh

# 2. 准备 Electron（版本要和引擎配套，见 packaging/README.md）
mkdir -p ~/.dsh/electron
unzip electron-v43.3.0-linux-x64.zip -d ~/.dsh/electron

# 3. 打包
git clone https://github.com/<你的用户名>/dsh-desktop.git
cd dsh-desktop
./packaging/build-deb.sh              # 自动识别当前架构
ARCH=arm64 ./packaging/build-deb.sh   # 强制指定
VERSION=0.2.2~rc5-1 MAINTAINER="你 <you@example.com>" ./packaging/build-deb.sh
```

产物在 `dist/`。

## 已知问题

- **以 `--no-sandbox` 运行 Electron。** 包里的 `chrome-sandbox` 无法设置为 setuid-root，因此外壳脚本用 `--no-sandbox` 启动同一份 Electron 二进制，否则直接报错退出。这意味着渲染进程没有沙箱隔离；如果你在意这一点，建议从源码自行构建并把 `chrome-sandbox` 正确设置为 root:root 4755 后去掉该参数。
- **首次启动慢。** 要拉起本地服务，大约 10–30 秒，之后秒开。
- **只支持 Ubuntu/Debian。** 其他发行版理论上可用 `dpkg -x` 解包后手动跑 `/opt/deepseek-harness/app/launch.sh`。

## 许可

本仓库的外壳代码为 MIT，见 [LICENSE](LICENSE)。打包进 `.deb` 的第三方组件（DeepSeek Harness、Electron、Node.js 等）均为 MIT 或各自许可，见 [NOTICE](NOTICE)。

本项目不附带任何 API Key，请自备。
