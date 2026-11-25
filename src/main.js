'use strict';

/*
 * DeepSeek Harness desktop shell.
 *
 * This is a thin native window around the DSH Web UI.  It starts `dsh web`
 * on a loopback port, remembers the launch URL (which carries the one-time
 * process token), and keeps that server alive between app launches so the
 * window reopens instantly.  Closing the window only closes the view; the
 * agent runtime keeps running in the background.
 */

const { app, BrowserWindow, Menu, screen, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const APP_DIR = __dirname;
const ICON = path.join(APP_DIR, 'icon.png');
const SPLASH = path.join(APP_DIR, 'splash.html');

const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'),
  'dsh-desktop',
);
const STATE_FILE = path.join(STATE_DIR, 'server.json');
const SERVER_LOG = path.join(STATE_DIR, 'server.log');
const APP_LOG = path.join(STATE_DIR, 'app.log');

const BUNDLE_ROOT = process.env.DSH_DESKTOP_ROOT || path.resolve(APP_DIR, '..');
const BUNDLED_NODE = path.join(BUNDLE_ROOT, 'node', 'bin', 'node');
const BUNDLED_DSH = path.join(BUNDLE_ROOT, 'dsh', 'lib', 'bin.js');
const NODE_BIN = process.env.DSH_DESKTOP_NODE
  || (fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : '/usr/bin/node');
const DSH_ENTRY = process.env.DSH_DESKTOP_DSH
  || (fs.existsSync(BUNDLED_DSH) ? BUNDLED_DSH : '/usr/local/bin/dsh');
const FIRST_PORT = 3080;
const PORT_TRIES = 12;
const START_TIMEOUT_MS = 150000;

let win = null;
let starting = false;
let shuttingDown = false;

/* ------------------------------------------------------------------ */
/* logging / state                                                     */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try {
    fs.appendFileSync(APP_LOG, line + '\n');
  } catch {
    /* logging must never break the app */
  }
  console.log(line);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  ensureDirs();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

function clearState() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* server helpers                                                      */
/* ------------------------------------------------------------------ */

function processUsesPort(pid, port) {
  try {
    const args = fs
      .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .filter(Boolean);
    const index = args.indexOf('--port');
    return index >= 0 && Number(args[index + 1]) === Number(port);
  } catch {
    return false;
  }
}

function isDshServerProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const args = fs
      .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .filter(Boolean);
    const runsDsh = args.some(
      (arg) => /(^|\/)dsh(\.js)?$/.test(arg) || /\/dsh\/lib\/bin\.js$/.test(arg),
    );
    return runsDsh && args.includes('web');
  } catch {
    return false;
  }
}

function httpStatus(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        finish(res.statusCode || 0);
      });
    } catch {
      finish(0);
      return;
    }
    req.on('error', () => finish(0));
    req.on('timeout', () => {
      req.destroy();
      finish(0);
    });
  });
}

async function stateIsUsable(state) {
  if (!state || !state.url || !state.port) return false;
  if (!isDshServerProcess(state.pid)) return false;
  const root = await httpStatus(`http://127.0.0.1:${state.port}/`);
  if (root !== 401 && root !== 200) return false;
  const token = await httpStatus(state.url);
  return token === 303 || token === 200;
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let i = 0; i < PORT_TRIES; i += 1) {
    const port = FIRST_PORT + i;
    if (await canBind(port)) return port;
  }
  return 0;
}

function desiredCwd() {
  if (process.env.DSH_DESKTOP_CWD) {
    try {
      if (fs.statSync(process.env.DSH_DESKTOP_CWD).isDirectory()) {
        return process.env.DSH_DESKTOP_CWD;
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const store = JSON.parse(
      fs.readFileSync(path.join(HOME, '.dsh', 'storages', 'workspace.json'), 'utf8'),
    );
    const id = store && store.global && store.global.defaultWorkspaceId;
    const dir = id && store.tables && store.tables.workspaces
      ? store.tables.workspaces[id] && store.tables.workspaces[id].path
      : null;
    if (dir && fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* fall through */
  }
  return HOME;
}

function readServerLog() {
  try {
    return fs.readFileSync(SERVER_LOG, 'utf8');
  } catch {
    return '';
  }
}

async function waitForServerUrl(child, spawnFailure) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnFailure()) throw spawnFailure();
    if (child.exitCode !== null) {
      throw new Error(`dsh web 提前退出（退出码 ${child.exitCode}）`);
    }
    const match = readServerLog().match(
      /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/,
    );
    if (match) return match[1];
    await sleep(250);
  }
  throw new Error('启动超时（150 秒），请查看服务日志');
}

async function startServer() {
  const port = await pickPort();
  const cwd = desiredCwd();
  const logFd = fs.openSync(SERVER_LOG, 'w');

  log('starting dsh web', `port=${port || 'auto'}`, `cwd=${cwd}`);

  const env = { ...process.env };
  if (DSH_ENTRY === BUNDLED_DSH) {
    env.PATH = `${path.join(BUNDLE_ROOT, 'node', 'bin')}:${env.PATH || ''}`;
  }

  const child = spawn(
    NODE_BIN,
    [DSH_ENTRY, 'web', '--port', String(port), '--no-open'],
    {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
    },
  );

  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
    log('spawn error', error && error.message ? error.message : String(error));
  });
  child.unref();
  try {
    fs.closeSync(logFd);
  } catch {
    /* child keeps its own descriptor */
  }

  try {
    const url = await waitForServerUrl(child, () => spawnError);
    if (spawnError) throw spawnError;
    const check = await httpStatus(url);
    if (check !== 303 && check !== 200) {
      throw new Error(`服务已启动但登录令牌不可用（HTTP ${check}）`);
    }
    const state = {
      pid: child.pid,
      port: Number(new URL(url).port),
      url,
      startedAt: new Date().toISOString(),
      version: app.getVersion(),
    };
    writeState(state);
    log('server ready', `pid=${state.pid}`, `port=${state.port}`);
    return state;
  } catch (error) {
    log('server start failed', error && error.message ? error.message : String(error));
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
}

async function stopOwnedServer() {
  const state = readState();
  if (!state || !isDshServerProcess(state.pid) || !processUsesPort(state.pid, state.port)) {
    clearState();
    return;
  }
  log('stopping server', `pid=${state.pid}`);
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 60; i += 1) {
    if (!isDshServerProcess(state.pid)) break;
    await sleep(200);
  }
  if (isDshServerProcess(state.pid)) {
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  clearState();
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function configureSession(sess) {
  const allowed = new Set([
    'clipboard-read',
    'clipboard-sanitized-write',
    'fullscreen',
    'media',
    'notifications',
    'pointerLock',
    'idle-detection',
  ]);
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  sess.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

function isLocalHttp(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const compact = workArea.width < 1200 || workArea.height < 760;
  const width = Math.min(1320, workArea.width);
  const height = Math.min(880, workArea.height);

  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(900, workArea.width),
    minHeight: Math.min(560, workArea.height),
    show: false,
    title: 'DeepSeek Harness',
    icon: ICON,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:dsh-desktop',
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  configureSession(win.webContents.session);

  win.once('ready-to-show', () => {
    if (!win) return;
    win.show();
    if (compact) win.maximize();
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: '复制' });
    }
    if (params.linkURL) {
      if (items.length) items.push({ type: 'separator' });
      items.push({
        label: '在浏览器中打开链接',
        click: () => shell.openExternal(params.linkURL),
      });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalHttp(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          icon: ICON,
          backgroundColor: '#0b0d10',
          autoHideMenuBar: true,
        },
      };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isLocalHttp(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  win.loadFile(SPLASH).catch((error) => {
    if (error && error.code === 'ERR_ABORTED') return; // superseded by the real page
    log('splash failed', String(error));
  });
}

async function loadApp(url) {
  if (!win) return;
  try {
    await win.loadURL(url);
    log('UI loaded', win.webContents.getURL());
  } catch (error) {
    log('UI load failed', error && error.message ? error.message : String(error));
    throw error;
  }
  maybeCapture();
}

function maybeCapture() {
  const target = process.env.DSH_DESKTOP_CAPTURE;
  if (!target || !win) return;
  setTimeout(async () => {
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(target, image.toPNG());
      log('capture written', target, JSON.stringify(image.getSize()));
    } catch (error) {
      log('capture failed', String(error));
    }
    if (process.env.DSH_DESKTOP_CAPTURE_EXIT === '1') app.quit();
  }, 6000);
}

/* ------------------------------------------------------------------ */
/* menus / lifecycle                                                   */
/* ------------------------------------------------------------------ */

function openServerLog() {
  ensureDirs();
  if (!fs.existsSync(SERVER_LOG)) fs.writeFileSync(SERVER_LOG, '');
  shell.openPath(SERVER_LOG);
}

async function restartServer() {
  if (starting) return;
  starting = true;
  try {
    await stopOwnedServer();
    if (win) await win.loadFile(SPLASH);
    const state = await startServer();
    await loadApp(state.url);
  } catch (error) {
    await showFatal('无法重启 DeepSeek Harness', error);
  } finally {
    starting = false;
  }
}

async function stopServerAndQuit() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopOwnedServer();
  app.quit();
}

function buildMenu() {
  const template = [
    {
      label: '应用',
      submenu: [
        {
          label: '重新加载页面',
          accelerator: 'CmdOrCtrl+R',
          click: () => win && win.webContents.reload(),
        },
        { label: '重启服务', click: () => restartServer() },
        { type: 'separator' },
        { label: '打开服务日志', click: openServerLog },
        {
          label: '打开工作区文件夹',
          click: () => shell.openPath(desiredCwd()),
        },
        { type: 'separator' },
        { label: '停止服务并退出', click: () => stopServerAndQuit() },
        { label: '退出（服务继续后台运行）', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showFatal(message, error) {
  const detail = String((error && error.message) || error || '未知错误');
  log('fatal', message, detail);
  const result = await dialog.showMessageBox(win || undefined, {
    type: 'error',
    title: 'DeepSeek Harness',
    message,
    detail: `${detail}\n\n服务日志：${SERVER_LOG}`,
    buttons: ['打开日志', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) openServerLog();
  app.quit();
}

async function bootstrap() {
  const state = readState();
  if (await stateIsUsable(state)) {
    log('reusing running server', `pid=${state.pid}`, `port=${state.port}`);
    try {
      await loadApp(state.url);
      return;
    } catch {
      log('reuse failed, starting a fresh server');
      clearState();
    }
  } else if (state) {
    log('stale server state discarded');
    clearState();
  }

  try {
    const fresh = await startServer();
    await loadApp(fresh.url);
  } catch (error) {
    await showFatal('无法启动 DeepSeek Harness', error);
  }
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

app.setName('DeepSeek Harness');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'dsh-desktop');
  try {
    app.setDesktopName('dsh-desktop.desktop');
  } catch {
    /* older Electron */
  }
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    ensureDirs();
    log('app started', `electron=${process.versions.electron}`, `node=${process.versions.node}`);
    buildMenu();
    createWindow();
    bootstrap();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
