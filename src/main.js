const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, shell, session, desktopCapturer, screen } = require("electron");
const path = require("path");
const fs   = require("fs");
const os   = require("os");
const https = require("https");
const { exec, execFile } = require('child_process');
const { autoUpdater } = require("electron-updater");
let uIOhook = null;
let UiohookKey = null;
let uiohookUnavailable = false;

// uiohook-napi is a native module. Load it only when hotkeys are needed so a
// damaged/outdated install can still open the app and show an actionable error.
function loadUiohook() {
  if (uIOhook && UiohookKey) return true;
  if (uiohookUnavailable) return false;
  try {
    ({ uIOhook, UiohookKey } = require("uiohook-napi"));
    return true;
  } catch (err) {
    uiohookUnavailable = true;
    console.error("[Hotkeys] Unable to load uiohook-napi:", err.message);
    mainWindow?.webContents.send("toast", {
      msg: "Global hotkeys unavailable — reinstall or update RaceLeague Driver.",
      type: "err",
    });
    return false;
  }
}
const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

// libuiohook mouse button codes: 1=left 2=right 3=middle 4=side-back 5=side-forward
const MOUSE_BUTTON_CODES = { Mouse4: 4, Mouse5: 5 };
function isMouseBind(key) { return typeof key === "string" && Object.prototype.hasOwnProperty.call(MOUSE_BUTTON_CODES, key); }

const NUM_KEY_MAP = {
  "Num0": "Numpad0", "Num1": "Numpad1", "Num2": "Numpad2", "Num3": "Numpad3",
  "Num4": "Numpad4", "Num5": "Numpad5", "Num6": "Numpad6", "Num7": "Numpad7",
  "Num8": "Numpad8", "Num9": "Numpad9",
  "Num+": "NumpadAdd", "Num-": "NumpadSubtract",
  "Num*": "NumpadMultiply", "Num/": "NumpadDivide",
  "Num.": "NumpadDecimal", "NumEnter": "NumpadEnter",
};
function toUiohookKeycode(key) {
  if (typeof key !== "string") return null;
  if (!loadUiohook()) return null;
  const name = NUM_KEY_MAP[key] || key; // letters/digits/F-keys pass through as-is
  return Object.prototype.hasOwnProperty.call(UiohookKey, name) ? UiohookKey[name] : null;
}

let mouseBindings = {};   // { [buttonCode]: actionHandlerFn }
let keyBindings   = {};   // { [uiohookKeycode]: actionHandlerFn }
let uiohookStarted = false;

function ensureUiohookStarted() {
  if (uiohookStarted) return;
  if (!loadUiohook()) return;
  uIOhook.on("mousedown", (e) => {
    const handler = mouseBindings[e.button];
    if (handler) handler();
  });
  uIOhook.on("keydown", (e) => {
    const handler = keyBindings[e.keycode];
    if (handler) handler();
  });
  uIOhook.start();
  uiohookStarted = true;
}

function stopAllHotkeys() {
  globalShortcut.unregisterAll();
  mouseBindings = {};
  keyBindings   = {};
}

function shutdownUiohook() {
  if (!uiohookStarted) return;
  try { uIOhook.stop(); } catch {}
  uiohookStarted = false;
}

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
  return { apiUrl: "", alwaysOnTop: true, keybinds: { blue_flag: "F1", next_lap: "F2", pitting: "F3" } };
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

let config     = loadConfig();
let mainWindow = null;
let tray       = null;
let inPits     = false;
let inPits2 = false;
// Per-action cooldowns — each action button/keybind locks out only itself,
// not the whole panel. Replaces the old single onCooldown/onCooldown2 gate.
const actionCooldowns  = { blue_flag: false, next_lap: false, pitting: false };
const actionCooldowns2 = { blue_flag: false, next_lap: false, pitting: false };
let practiceModeActive = false; // synced from renderer via set-practice-mode-active
let committeeScreenActive = false; // synced from renderer via set-committee-screen-active — true while the Committee tab is the visible screen
let keybindOverrideGame = false; // synced from renderer via set-keybind-override-game — when off, bare single-character keys are refused at registration time

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

const http = require("http");
const OAUTH_PORT = 7823;
let oauthResolve = null;
const oauthServer = http.createServer((req, res) => {
  const url  = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body style='background:#0a0a0f;color:#e8e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;'><h2>✅ Logged in! You can close this window.</h2></body></html>");

  if (oauthResolve) {
    const resolveFn = oauthResolve;
    oauthResolve = null;
    resolveFn(code);
  }
});

oauthServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[OAuth] Port ${OAUTH_PORT} in use — retrying...`);
    setTimeout(() => {
      oauthServer.close();
      oauthServer.listen(OAUTH_PORT);
    }, 1000);
  } else {
    console.error("[OAuth] Server error:", err.message);
  }
});
oauthServer.listen(OAUTH_PORT);

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();
  setupFuelDisplayMediaHandler();

  if (config.splitViewEnabled) {
    plateWin = createOverlayWindow("plate", { width: 260, height: 330, x: 40, y: 40 });
    fieldWin = createOverlayWindow("field", { width: 300, height: 420, x: 40, y: 400 });
  }
  if (config.timerOverlayEnabled) {
    timerWin = createOverlayWindow("timer", { width: 260, height: 170, x: 40, y: 760 });
  }
  if (config.notifOverlayEnabled) {
    notifWin = createOverlayWindow("notif", notifBoundsForPosition(config.notifPosition || "right"));
  }
});


app.on("window-all-closed", () => app.quit());

function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log("[Updater] Skipping — running in dev mode.");
    return;
  }

  if (config.devPrereleaseOptIn) {
    autoUpdater.allowPrerelease = true;
    console.log("[Updater] Pre-release opt-in enabled.");
  }

  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = false;

let updateAvailable = false;

  // electron-updater surfaces the GitHub release's description as info.releaseNotes
  // (a string, or an array of {version, note} for multi-version updates). If the
  // release description mentions "bug fix", flag it so the renderer can show a
  // lighter-weight "bug fix" banner instead of the standard update banner.
  function isBugfixRelease(info) {
    const notes = info?.releaseNotes;
    const text = typeof notes === "string"
      ? notes
      : Array.isArray(notes)
        ? notes.map(n => n?.note || "").join(" ")
        : "";
    return /bug fix/i.test(text);
  }

  autoUpdater.on("checking-for-update", () => console.log("[Updater] Checking..."));
  autoUpdater.on("update-not-available", () => console.log("[Updater] Up to date."));
  autoUpdater.on("update-available",  (info) => {
    updateAvailable = true;
    mainWindow?.webContents.send("update-available",  info.version, isBugfixRelease(info));
    console.log(`[Updater] Available: v${info.version}`);
  });
  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.webContents.send("update-downloaded", info.version, isBugfixRelease(info));
    console.log(`[Updater] Downloaded: v${info.version}`);
  });
  autoUpdater.on("error", (err) => {
    console.log("[Updater] Error:", err.message);
    if (updateAvailable) mainWindow?.webContents.send("update-error", err.message);
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(e => console.log("[Updater]", e.message)), 5000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440, height: 740, minWidth: 200, minHeight: 80,
    alwaysOnTop: config.alwaysOnTop ?? true,
    frame: false, transparent: true, backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
    },
    icon:  path.join(__dirname, "../assets/icon.png"),
    title: "RaceLeague Control",
  });

mainWindow.loadFile(path.join(__dirname, "renderer.html"));
if (config.alwaysOnTop) mainWindow.setAlwaysOnTop(true, "screen-saver");

mainWindow.on("focus", () => mainWindow.webContents.invalidate());
mainWindow.on("resize", () => mainWindow.webContents.invalidate());

  mainWindow.on("close", () => {
    stopAllHotkeys();
    shutdownUiohook();
    app.quit();
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, "../assets/tray_icon.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("TurboGrid Control");

  const menu = Menu.buildFromTemplate([
    { label: "Show", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "Quit", click: () => { stopAllHotkeys(); shutdownUiohook(); app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

function setupFuelDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 300, height: 200 },
      fetchWindowIcons: true,
    }).then(sources => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (!win) { callback({}); return; }

      const payload = sources.map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
      }));
      win.webContents.send('fuel-source-picker-open', payload);

      const onResult = (event, sourceId) => {
        ipcMain.removeListener('fuel-source-picker-result', onResult);
        const chosen = sources.find(s => s.id === sourceId);
        callback(chosen ? { video: chosen } : {});
      };
      ipcMain.on('fuel-source-picker-result', onResult);
    }).catch(() => callback({}));
  }, { useSystemPicker: true });
}

function registerHotkeys(keybinds) {
  globalShortcut.unregisterAll();
  mouseBindings = {};
  keybinds = keybinds || {};

  // Shared per-action handlers, called from either the uiohook keydown listener
  // (keyboard) or the uiohook mousedown listener (mouse side buttons).
  const actionHandlers = {
    blue_flag: () => {
      if (practiceModeActive) return; // race keybinds are disabled while Practice Mode is on
      if (actionCooldowns.blue_flag) return;
      mainWindow?.webContents.send("keybind-fired", "blue_flag");
      sendDriverAction("blue_flag");
    },
    next_lap: () => {
      if (practiceModeActive) return;
      if (actionCooldowns.next_lap) return;
      mainWindow?.webContents.send("keybind-fired", "next_lap");
      sendDriverAction("next_lap");
    },
    pitting: () => {
      if (practiceModeActive) return;
      if (actionCooldowns.pitting || inPits) return;
      mainWindow?.webContents.send("keybind-fired", "pitting");
      enterPits(1);
    },
    dnf: () => {
      if (practiceModeActive) return;
      mainWindow?.webContents.send("keybind-fired", "dnf");
    },
    practice_start: () => {
      if (!practiceModeActive && !committeeScreenActive) return; // works in Practice Mode, or on the Committee screen (drives its stopwatch)
      mainWindow?.webContents.send("keybind-fired", "practice_start");
    },
    practice_lap: () => {
      if (!practiceModeActive && !committeeScreenActive) return;
      mainWindow?.webContents.send("keybind-fired", "practice_lap");
    },
    practice_reset: () => {
      if (!practiceModeActive && !committeeScreenActive) return;
      mainWindow?.webContents.send("keybind-fired", "practice_reset");
    },
  };

  let needsHook = false;

  // Group by physical key instead of registering one-handler-per-key directly —
  // two actions can share the same key (e.g. F2 for both Next Lap and Practice
  // Lap) since they're mode-gated and mutually exclusive. Registering them
  // separately would just have the last one silently overwrite the first;
  // grouping means both run, and each one's own gate decides whether it acts.
  const keyGroups = {};      // uiohook keycode -> [handler, ...]
  const mouseGroups = {};    // mouse code -> [handler, ...]
  const exclusiveGroups = {}; // Electron accelerator -> [handler, ...] — bare keys, Override Game only

  Object.entries(actionHandlers).forEach(([action, handler]) => {
    const key = keybinds[action];
    if (!key) return;

    if (isMouseBind(key)) {
      const code = MOUSE_BUTTON_CODES[key];
      (mouseGroups[code] ||= []).push(handler);
      needsHook = true;
    } else if (key.length === 1) {
      // A bare single printable character (e.g. "E"). By default this is
      // skipped entirely — safe, but the action just won't fire on it.
      // With Override Game on, it's registered via globalShortcut instead
      // of uiohook: an exclusive OS-level grab that reliably fires the
      // action, at the cost of that key no longer typing anywhere on the
      // PC while it's bound — the original behavior, brought back on purpose.
      if (keybindOverrideGame) {
        (exclusiveGroups[key] ||= []).push(handler);
      } else {
        console.warn(`[Hotkeys] "${key}" for action "${action}" is a bare key and Override Game is off — skipping registration.`);
      }
    } else {
      const code = toUiohookKeycode(key);
      if (code == null) {
        console.warn(`[Hotkeys] Unrecognized key "${key}" for action "${action}" — skipping.`);
        return;
      }
      (keyGroups[code] ||= []).push(handler);
      needsHook = true;
    }
  });

  // Keyboard binds go through uiohook's passive keydown hook, not globalShortcut —
  // globalShortcut grabs the key exclusively at the OS level, which stops it from
  // reaching any other focused window (chat, Discord, our own text fields). uiohook
  // just observes the keypress, so the keystroke still types normally everywhere
  // while also firing the bound action. Bare keys under Override Game are the
  // deliberate exception — see exclusiveGroups above.
  Object.entries(keyGroups).forEach(([code, handlers]) => {
    keyBindings[code] = () => handlers.forEach(h => h());
  });
  Object.entries(mouseGroups).forEach(([code, handlers]) => {
    mouseBindings[code] = () => handlers.forEach(h => h());
  });
  Object.entries(exclusiveGroups).forEach(([accel, handlers]) => {
    const ok = globalShortcut.register(accel, () => handlers.forEach(h => h()));
    if (!ok) console.warn(`[Hotkeys] Failed to register exclusive key "${accel}" — it may already be in use by another app.`);
  });

  if (needsHook) ensureUiohookStarted();
}

function pickAssetForPlatform(assets) {
  const ext = process.platform === "win32" ? ".exe"
    : process.platform === "darwin" ? ".dmg"
    : ".AppImage";
  return assets.find(a => a.name.endsWith(ext));
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const request = (u) => {
      https.get(u, { headers: { "User-Agent": "RaceControl-App" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (total && onProgress) onProgress(Math.round((downloaded / total) * 100));
        });
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      }).on("error", reject);
    };
    request(url);
  });
}

let plateWin = null;
let fieldWin = null;
let timerWin = null;
let notifWin = null;

function notifBoundsForPosition(position) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const width = 320, height = 120, margin = 20;
  if (position === "top") return { width, height, x: Math.round((sw - width) / 2), y: margin };
  if (position === "left") return { width, height, x: margin, y: margin };
  return { width, height, x: sw - width - margin, y: margin }; // "right" (default)
}

function createOverlayWindow(key, defaultBounds) {
  const saved = config.overlayBounds?.[key] || defaultBounds;
  const win = new BrowserWindow({
    ...saved,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (key === "notif") win.setIgnoreMouseEvents(true, { forward: true }); // empty most of the time — never block clicks under it
  win.loadFile(path.join(__dirname, `overlay-${key}.html`));

  let lastBounds = win.getBounds();
  const boundsPoll = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(boundsPoll); return; }
    const b = win.getBounds();
    if (b.x !== lastBounds.x || b.y !== lastBounds.y || b.width !== lastBounds.width || b.height !== lastBounds.height) {
      lastBounds = b;
      config.overlayBounds = config.overlayBounds || {};
      config.overlayBounds[key] = b;
      saveConfig(config);
    }
  }, 500);

  win.on("closed", () => {
    clearInterval(boundsPoll);
    if (key === "plate") plateWin = null;
    else if (key === "field") fieldWin = null;
    else if (key === "timer") timerWin = null;
    else if (key === "notif") notifWin = null;
  });

  return win;
}

ipcMain.handle("overlay:toggle-split", (e, enable) => {
  config.splitViewEnabled = enable;
  saveConfig(config);

  if (enable) {
    if (!plateWin) plateWin = createOverlayWindow("plate", { width: 260, height: 330, x: 40, y: 40 });
    if (!fieldWin) fieldWin = createOverlayWindow("field", { width: 300, height: 420, x: 40, y: 400 });
  } else {
    plateWin?.close(); plateWin = null;
    fieldWin?.close(); fieldWin = null;
  }
  return true;
});

ipcMain.handle("overlay:toggle-timer", () => {
  if (timerWin) {
    timerWin.close();
    timerWin = null;
    config.timerOverlayEnabled = false;
    saveConfig(config);
    return false;
  } else {
    timerWin = createOverlayWindow("timer", { width: 260, height: 170, x: 40, y: 760 });
    config.timerOverlayEnabled = true;
    saveConfig(config);
    return true;
  }
});

ipcMain.handle("overlay:fit-height", (e, height) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const b = win.getBounds();
  win.setBounds({ ...b, height: Math.max(120, Math.round(height)) });
});

ipcMain.handle("overlay:set-click-through", (e, ignore) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.handle("overlay:reset-positions", () => {
  config.overlayBounds = {};
  saveConfig(config);
  if (plateWin) plateWin.setBounds({ width: 260, height: 330, x: 40, y: 40 });
  if (fieldWin) fieldWin.setBounds({ width: 300, height: 420, x: 40, y: 400 });
  if (timerWin) timerWin.setBounds({ width: 260, height: 170, x: 40, y: 760 });
  if (notifWin) notifWin.setBounds(notifBoundsForPosition(config.notifPosition || "right"));
  return true;
});

ipcMain.handle("overlay:set-notif-enabled", (e, enabled) => {
  config.notifOverlayEnabled = !!enabled;
  saveConfig(config);
  if (enabled) {
    if (!notifWin) notifWin = createOverlayWindow("notif", notifBoundsForPosition(config.notifPosition || "right"));
  } else {
    notifWin?.close();
    notifWin = null;
  }
  return config.notifOverlayEnabled;
});

ipcMain.handle("overlay:set-notif-position", (e, position) => {
  config.notifPosition = position;
  saveConfig(config);
  config.overlayBounds = config.overlayBounds || {};
  delete config.overlayBounds["notif"]; // a manual drag shouldn't fight the new preset corner
  saveConfig(config);
  if (notifWin) notifWin.setBounds(notifBoundsForPosition(position));
  return true;
});

ipcMain.handle("overlay:send-notification", (e, payload) => {
  if (notifWin && !notifWin.isDestroyed()) notifWin.webContents.send("notif:incoming", payload);
});

ipcMain.handle("overlay:test-notification", () => {
  if (!notifWin) return false; // window only ever exists because the Enable toggle created it — never spin one up just to test
  notifWin.webContents.send("notif:incoming", { message: "🔔 This is a test notification", type: "ok" });
  return true;
});

async function sendDriverAction(action) {
  if (!config.apiUrl || !config.driver) {
    mainWindow?.webContents.send("toast", { msg: "⚠️ Not configured", type: "err" });
    return;
  }
  if (actionCooldowns[action]) {
    mainWindow?.webContents.send("toast", { msg: "⏳ Cooldown active", type: "err" });
    return;
  }
    actionCooldowns[action] = true;
  try {
    if (!config.driverToken) {
      actionCooldowns[action] = false;
      mainWindow?.webContents.send("toast", { msg: "⚠️ Driver session expired — re-login in Settings", type: "err" });
      return;
    }
    const res = await fetch(`${config.apiUrl}/driver/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-discord-id": config.discordId, "x-discord-token": config.driverToken },
body: JSON.stringify({
  action,
  driver:    config.driver,
  callsign:  config.callsign,
  number:    config.number,
  username:  config.username || config.driver,
  engineer:  config.engineer || false,
}),
    });
if (res.ok) {
      const labels = { blue_flag:"🔵 Blue Flag", next_lap:"🏁 Next Lap", pitting:"🔧 Pitting", in_race:"🏎️ Back on Track" };
      mainWindow?.webContents.send("toast", { msg: `✓ ${labels[action]}`, type: "ok" });
      mainWindow?.webContents.send("cooldown-start", 7, 1, action);
      setTimeout(() => { actionCooldowns[action] = false; mainWindow?.webContents.send("cooldown-end", 1, action); }, 7000);
    } else {
      actionCooldowns[action] = false;
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && /hasn.t started/i.test(data.error || "")) {
        mainWindow?.webContents.send("toast", { msg: "⏳ Race not started", type: "err" });
      } else {
        mainWindow?.webContents.send("toast", { msg: `✗ ${data.error || "Action rejected"}`, type: "err" });
      }
    }
  } catch {
    actionCooldowns[action] = false;
    mainWindow?.webContents.send("toast", { msg: "✗ Bot unreachable", type: "err" });
  }
}

async function sendDriverAction2(action) {
  if (!config.apiUrl || !config.driver2) return;
  if (actionCooldowns2[action]) {
    mainWindow?.webContents.send("toast", { msg: "⏳ Cooldown active (D2)", type: "err" });
    return;
  }
  actionCooldowns2[action] = true;
  if (!config.driverToken) {
    actionCooldowns2[action] = false;
    mainWindow?.webContents.send("toast", { msg: "⚠️ Driver session expired — re-login in Settings", type: "err" });
    return;
  }
  try {
    const res = await fetch(`${config.apiUrl}/driver/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-discord-id": config.discordId, "x-discord-token": config.driverToken },
      body: JSON.stringify({
        action,
        driver:    config.driver2,
        callsign:  config.callsign2,
        number:    config.number2,
        username:  config.username || config.driver2,
        engineer:  config.engineer || false,
      }),
    });
    if (res.ok) {
      const labels = { blue_flag:"🔵 Blue Flag", next_lap:"🏁 Next Lap", pitting:"🔧 Pitting", in_race:"🏎️ Back on Track" };
      mainWindow?.webContents.send("toast", { msg: `✓ ${labels[action]} (D2)`, type: "ok" });
      mainWindow?.webContents.send("cooldown-start", 7, 2, action);
      setTimeout(() => { actionCooldowns2[action] = false; mainWindow?.webContents.send("cooldown-end", 2, action); }, 7000);
    } else {
      actionCooldowns2[action] = false;
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && /hasn.t started/i.test(data.error || "")) {
        mainWindow?.webContents.send("toast", { msg: "⏳ Race not started", type: "err" });
      } else {
        mainWindow?.webContents.send("toast", { msg: `✗ ${data.error || "Action rejected"} (D2)`, type: "err" });
      }
    }
  } catch {
    actionCooldowns2[action] = false;
    mainWindow?.webContents.send("toast", { msg: "✗ Bot unreachable", type: "err" });
  }
}

// ── FIX: this function was being called by the pitting hotkeys and the
// toggle-pitting / toggle-pitting2 IPC handlers below, but was never
// actually defined — that's what caused the
// "ReferenceError: enterPits is not defined" crash on Pit press.
async function enterPits(slot) {
  const isSlot1 = slot === 1;
  if (isSlot1 && inPits)   return;
  if (!isSlot1 && inPits2) return;

  const driver       = isSlot1 ? config.driver   : config.driver2;
  const callsign     = isSlot1 ? config.callsign : config.callsign2;
  const number       = isSlot1 ? config.number   : config.number2;
  const cooldowns    = isSlot1 ? actionCooldowns : actionCooldowns2;

  if (!config.apiUrl || !driver) {
    mainWindow?.webContents.send("toast", { msg: "⚠️ Not configured", type: "err" });
    return;
  }
  if (cooldowns.pitting) {
    mainWindow?.webContents.send("toast", { msg: "⏳ Cooldown active", type: "err" });
    return;
  }
  if (!config.driverToken) {
    mainWindow?.webContents.send("toast", { msg: "⚠️ Driver session expired — re-login in Settings", type: "err" });
    return;
  }

  cooldowns.pitting = true;
  try {
    const res = await fetch(`${config.apiUrl}/driver/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-discord-id": config.discordId, "x-discord-token": config.driverToken },
      body: JSON.stringify({
        action: "pitting",
        driver, callsign, number,
        username: config.username || driver,
        engineer: config.engineer || false,
      }),
    });

    if (res.ok) {
      if (isSlot1) {
        inPits = true;
        mainWindow?.webContents.send("pit-state-changed", true);
      } else {
        inPits2 = true;
        mainWindow?.webContents.send("pit-state-changed-2", true);
      }
      mainWindow?.webContents.send("toast", { msg: `✓ 🔧 Pitting${isSlot1 ? "" : " (D2)"}`, type: "ok" });
      mainWindow?.webContents.send("cooldown-start", 7, slot, "pitting");
      setTimeout(() => { cooldowns.pitting = false; mainWindow?.webContents.send("cooldown-end", slot, "pitting"); }, 7000);

      // Mirrors the backend's 15s auto-clear of inPits
      setTimeout(() => {
        if (isSlot1) {
          inPits = false;
          mainWindow?.webContents.send("pit-state-changed", false);
        } else {
          inPits2 = false;
          mainWindow?.webContents.send("pit-state-changed-2", false);
        }
      }, 15_000);
    } else {
      cooldowns.pitting = false;
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && /hasn.t started/i.test(data.error || "")) {
        mainWindow?.webContents.send("toast", { msg: "⏳ Race not started", type: "err" });
      } else {
        mainWindow?.webContents.send("toast", { msg: `✗ ${data.error || "Action rejected"}`, type: "err" });
      }
    }
  } catch {
    cooldowns.pitting = false;
    mainWindow?.webContents.send("toast", { msg: "✗ Bot unreachable", type: "err" });
  }
}

ipcMain.handle("open-oauth", (_, _url) => {
  return new Promise((resolve) => {
    const CLIENT_ID  = "1540060254791016588";
    const REDIRECT   = encodeURIComponent(`http://localhost:${OAUTH_PORT}`);
    const discordUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT}&response_type=code&scope=identify`;

    const authWin = new BrowserWindow({
      width: 520, height: 720, show: true, alwaysOnTop: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      title: "Login with Discord", autoHideMenuBar: true,
    });

    oauthResolve = (code) => {
      console.log("[OAuth] Code received:", code ? "yes" : "no");
      oauthResolve = null;
      if (authWin && !authWin.isDestroyed()) {
        setTimeout(() => authWin.destroy(), 1500);
      }
      resolve(code);
    };

    authWin.loadURL(discordUrl);
    authWin.show();
    authWin.focus();

    authWin.on("closed", () => {
      console.log("[OAuth] Window closed");
      if (oauthResolve) {
        oauthResolve = null;
        resolve(null);
      }
    });
  });
});

ipcMain.handle("overlay:nudge", (e, dx, dy) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const b = win.getBounds();
  win.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
});

ipcMain.handle("overlay:resize-by", (e, dw, dh) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const b = win.getBounds();
  win.setBounds({
    ...b,
    width: Math.max(150, b.width + dw),
    height: Math.max(120, b.height + dh),
  });
});

ipcMain.handle("get-config",     ()      => config);
ipcMain.handle("save-config", (_, cfg) => {
  const { overlayBounds, ...safeCfg } = cfg || {};
  config = { ...config, ...safeCfg };
  saveConfig(config);
  if (cfg.keybinds) {
    const active = {};
    Object.entries(cfg.keybinds).forEach(([action, key]) => {
      if (key && key !== "None") active[action] = key;
    });
    registerHotkeys(active);
  }
  return true;
});
ipcMain.handle("send-action",    (_, action) => sendDriverAction(action));
ipcMain.handle("toggle-pitting", () => {
  if (inPits) return inPits;
  enterPits(1);
  return inPits;
});
ipcMain.handle("minimize-app",   () => mainWindow?.minimize());
ipcMain.handle("dev-auth-password", () => {
  let secrets = {};
  try { secrets = require("./secrets.json"); } catch {}
  return process.env.ADMIN_PASSWORD || secrets.adminPassword || null;
});
ipcMain.handle("close-app",      () => { stopAllHotkeys(); shutdownUiohook(); app.quit(); });
ipcMain.handle("toggle-top", () => {
  config.alwaysOnTop = !config.alwaysOnTop;
  mainWindow?.setAlwaysOnTop(config.alwaysOnTop, "screen-saver");
  saveConfig(config);
  return config.alwaysOnTop;
});
ipcMain.handle("open-devtools",  () => mainWindow?.webContents.openDevTools({ mode: "undocked" }));
ipcMain.handle("install-update", () => autoUpdater.quitAndInstall());
ipcMain.handle("check-version",  () => app.getVersion());
ipcMain.handle("flag-broadcast", (_, data) => mainWindow?.webContents.send("flag-event", data));
ipcMain.handle("register-hotkeys",  (_, keybinds) => { registerHotkeys(keybinds); return true; });
ipcMain.handle("set-practice-mode-active", (_, active) => { practiceModeActive = !!active; return true; });
ipcMain.handle("set-committee-screen-active", (_, active) => { committeeScreenActive = !!active; return true; });
ipcMain.handle("set-keybind-override-game", (_, active) => { keybindOverrideGame = !!active; return true; });
ipcMain.handle("suspend-hotkeys",   () => { stopAllHotkeys(); return true; });
ipcMain.handle("send-action2",    (_, action) => sendDriverAction2(action));
ipcMain.handle("toggle-pitting2", () => {
  if (inPits2) return inPits2;
  enterPits(2);
  return inPits2;
});
ipcMain.handle("resume-hotkeys",    () => { registerHotkeys(config.keybinds); return true; });
ipcMain.handle("open-releases", () => shell.openExternal("https://github.com/AleEjx/racecontrol-app/releases/latest"));

ipcMain.handle("install-release-version", async (event, tag) => {
  const sender = event.sender;
  try {
    const res = await new Promise((resolve, reject) => {
      https.get(
        `https://api.github.com/repos/AleEjx/racecontrol-app/releases/tags/${tag}`,
        { headers: { "User-Agent": "RaceControl-App" } },
        (r) => {
          let data = "";
          r.on("data", (c) => (data += c));
          r.on("end", () => resolve(JSON.parse(data)));
        }
      ).on("error", reject);
    });

    const asset = pickAssetForPlatform(res.assets || []);
    if (!asset) throw new Error(`No build found for this OS in ${tag}`);

    const destPath = path.join(os.tmpdir(), asset.name);
    await downloadFile(asset.browser_download_url, destPath, (pct) => {
      sender.send("version-install-progress", pct);
    });

if (process.platform === "win32") {
      const pid = process.pid;
      const batPath = path.join(os.tmpdir(), "rc_update.bat");
      const batScript = `@echo off
:wait
tasklist /FI "PID eq ${pid}" | find "${pid}" >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait
)
start "" "${destPath}"
del "%~f0"
`;
      fs.writeFileSync(batPath, batScript);
      execFile("cmd.exe", ["/c", batPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      stopAllHotkeys();
      shutdownUiohook();
      mainWindow?.destroy();
      app.exit(0);
    } else if (process.platform === "darwin") {
      await shell.openPath(destPath);
      stopAllHotkeys();
      shutdownUiohook();
      app.quit();
    } else {
      fs.chmodSync(destPath, 0o755);
      execFile(destPath, [], { detached: true, stdio: "ignore" }).unref();
      stopAllHotkeys();
      shutdownUiohook();
      app.quit();
    }
  } catch (err) {
    sender.send("version-install-error", err.message);
    throw err;
  }
});
function getUninstallStringFromRegistry() {
  return new Promise((resolve) => {
    const appName = "RaceLeague Driver";
    const hives = [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];
 
    let remaining = hives.length;
    let found = null;
 
    hives.forEach((hive) => {
      execFile(
        "reg",
        ["query", hive, "/s", "/f", appName, "/k"],
        (err, stdout) => {
          remaining--;
          if (!found && !err && stdout) {
            const match = stdout
              .split(/\r?\n/)
              .find((line) => line.trim().startsWith("HKEY"));
            if (match) found = match.trim();
          }
          if (remaining === 0) resolve(found);
        }
      );
    });
  });
}
 
function getUninstallCommand(subkeyPath) {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", subkeyPath, "/v", "UninstallString"],
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const line = stdout
          .split(/\r?\n/)
          .find((l) => l.includes("UninstallString"));
        if (!line) return resolve(null);
        const parts = line.trim().split(/\s+/);
        const value = line.slice(line.indexOf("REG_SZ") + 6).trim();
        resolve(value || null);
      }
    );
  });
}
 
ipcMain.handle("uninstall", async () => {
  try {
    const subkey = await getUninstallStringFromRegistry();
 
    if (subkey) {
      const uninstallString = await getUninstallCommand(subkey);
      if (uninstallString) {
        console.log("[Uninstall] Found via registry:", uninstallString);
        exec(uninstallString, (err) => {
          if (err) {
            console.error("[Uninstall] Failed to launch uninstaller:", err.message);
            mainWindow?.webContents.send("toast", {
              msg: "✗ Couldn't launch uninstaller automatically",
              type: "err",
            });
            shell.openExternal("ms-settings:appsfeatures");
            return;
          }
        });
        setTimeout(() => { stopAllHotkeys(); shutdownUiohook(); app.quit(); }, 1000);
        return true;
      }
    }
    console.warn("[Uninstall] Could not resolve uninstaller path from registry.");
    mainWindow?.webContents.send("toast", {
      msg: "✗ Couldn't find uninstaller — opening Windows settings",
      type: "err",
    });
    shell.openExternal("ms-settings:appsfeatures");
    return false;
  } catch (err) {
    console.error("[Uninstall] Unexpected error:", err.message);
    mainWindow?.webContents.send("toast", {
      msg: "✗ Uninstall failed — see logs",
      type: "err",
    });
    return false;
  }
});

app.on("will-quit", () => { stopAllHotkeys(); shutdownUiohook(); });
