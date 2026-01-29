const { app, BrowserWindow, ipcMain } = require("electron");
const mineflayer = require("mineflayer");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

let mainWindow = null;
let activeBots = {};
let isQuitting = false;

let desiredBots = new Set();
let autoCmdRuntimeEnabled = true;

let runtimeBotCmdMap = {};
let botServerMap = {};

function getProfileId() {
  const envProfile = process.env.PROFILE;
  if (envProfile && String(envProfile).trim()) return String(envProfile).trim();

  const arg = process.argv.find((a) => a.startsWith("--profile="));
  if (!arg) return "default";
  const v = arg.split("=", 2)[1]?.trim();
  return v ? v : "default";
}
const profileId = getProfileId();

function applyProfileUserDataPath() {
  if (profileId === "default") return;

  const appData = app.getPath("appData");
  const baseName = app.getName();
  const base = path.join(appData, baseName);

  app.setPath("userData", path.join(base, `profile-${profileId}`));
}
applyProfileUserDataPath();

const yamlPath = path.join(app.getPath("userData"), "data.yml");

function ensureUserDataDir() {
  const dir = path.dirname(yamlPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeSend(channel, payload) {
  try {
    if (!mainWindow) return;
    if (mainWindow.isDestroyed()) return;

    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;

    wc.send(channel, payload);
  } catch {}
}

// ✅ gửi thêm player (không phá renderer cũ)
function sendLogs(user, msg, player = "") {
  const server = botServerMap?.[user] || "";
  safeSend("log", { user, msg, server, player });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    app.whenReady().then(() => showMainWindow());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 980,
    title: `Oceandeep Bot Panel (${profileId})`,
    icon:
      process.platform === "win32"
        ? path.join(__dirname, "build", "icon.ico")
        : path.join(__dirname, "build", "icon.png"),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    backgroundColor: "#070b16",
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile("index.html");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function showMainWindow() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow.show();
    mainWindow.focus();
  } catch {}
}

function randInt(min, max) {
  const a = parseInt(min);
  const b = parseInt(max);
  const lo = Number.isFinite(a) ? a : 0;
  const hi = Number.isFinite(b) ? b : lo;
  const mn = Math.min(lo, hi);
  const mx = Math.max(lo, hi);
  return Math.floor(Math.random() * (mx - mn + 1) + mn);
}

function normalizeMcVersion(v) {
  const s = String(v ?? "").trim();
  if (!s || s.toLowerCase() === "auto") return "";
  return s;
}

// ====== CHAT JSON PARSER (lấy tên player chắc hơn) ======
function safeParseJson(x) {
  try {
    if (!x) return null;
    if (typeof x === "object") return x;
    return JSON.parse(String(x));
  } catch {
    return null;
  }
}

function isMcUsername(name) {
  return /^[A-Za-z0-9_]{1,16}$/.test(String(name || "").trim());
}

// Lấy plain text từ chat component (đệ quy)
function componentToPlainText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";

  let out = "";
  if (typeof node.text === "string") out += node.text;
  if (typeof node.insertion === "string") out += node.insertion;

  if (Array.isArray(node.extra)) {
    for (const e of node.extra) out += componentToPlainText(e);
  }

  const hover = node.hoverEvent?.contents || node.hoverEvent?.value;
  if (hover) out += componentToPlainText(hover);

  return out;
}

function extractFirstUsernameFromText(text) {
  const s = String(text || "");

  // <Name> msg
  let m = s.match(/<\s*([A-Za-z0-9_]{1,16})\s*>/);
  if (m && isMcUsername(m[1])) return m[1];

  // [xxx] Name: msg  OR  Name: msg
  m = s.match(/(^|\]\s*)([A-Za-z0-9_]{1,16})\s*:\s+/);
  if (m && isMcUsername(m[2])) return m[2];

  // [xxx] Name » msg OR  Name » msg
  m = s.match(/(^|\]\s*)([A-Za-z0-9_]{1,16})\s*»\s+/);
  if (m && isMcUsername(m[2])) return m[2];

  return "";
}

// parse JSON theo kiểu translate chat.type.text / emote / announcement ...
function extractPlayerFromChatJson(jsonObj) {
  try {
    if (!jsonObj || typeof jsonObj !== "object") return "";

    if (typeof jsonObj.translate === "string" && Array.isArray(jsonObj.with) && jsonObj.with.length > 0) {
      const senderComp = jsonObj.with[0];
      const senderText = componentToPlainText(senderComp).trim();

      const token = senderText.split(/\s+/).find(isMcUsername);
      if (token) return token;

      if (isMcUsername(senderText)) return senderText;
    }

    if (isMcUsername(jsonObj.insertion)) return String(jsonObj.insertion).trim();

    const plain = componentToPlainText(jsonObj);
    const fromText = extractFirstUsernameFromText(plain);
    if (fromText) return fromText;

    return "";
  } catch {
    return "";
  }
}

function detectPlayerFromAny(msgStr, jsonMaybe) {
  const j = safeParseJson(jsonMaybe);
  const p1 = extractPlayerFromChatJson(j);
  if (p1) return p1;

  return extractFirstUsernameFromText(msgStr);
}

function isChatTranslate(jsonObj) {
  try {
    if (!jsonObj || typeof jsonObj !== "object") return false;
    const tr = String(jsonObj.translate || "");
    return tr.startsWith("chat.type.") || tr.includes("chat.type");
  } catch {
    return false;
  }
}

// ====== CONFIG ======
function loadCfg() {
  const def = {
    ip: "localhost",
    port: 25565,
    mcVersion: "1.19.4",

    preConnectDelay: 0,

    accounts: [],
    selectedBots: [],

    autoCmdEnabled: true,
    autoCmds: [],

    // legacy
    cmdDelay: 1,
    // ✅ NEW: UI "AutoCmd Delay"
    autoCmdDelay: 1,

    firstCmdDelay: 1.5,

    loginDelay: 1,
    minOn: 30,
    maxOn: 60,
    minOff: 10,
    maxOff: 20,

    groups: [],
    activeGroupId: "",
  };

  if (!fs.existsSync(yamlPath)) return def;

  try {
    const raw = yaml.load(fs.readFileSync(yamlPath, "utf8")) || {};
    const cfg = { ...def, ...raw };

    cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
    cfg.selectedBots = Array.isArray(cfg.selectedBots) ? cfg.selectedBots : [];
    cfg.autoCmds = Array.isArray(cfg.autoCmds) ? cfg.autoCmds : [];

    cfg.groups = Array.isArray(cfg.groups) ? cfg.groups : [];
    cfg.activeGroupId = String(cfg.activeGroupId || "");

    cfg.autoCmdEnabled = !!cfg.autoCmdEnabled;

    cfg.preConnectDelay = Number(cfg.preConnectDelay);
    if (!Number.isFinite(cfg.preConnectDelay) || cfg.preConnectDelay < 0) cfg.preConnectDelay = 0;

    cfg.port = parseInt(cfg.port) || def.port;
    cfg.loginDelay = parseInt(cfg.loginDelay) || def.loginDelay;

    cfg.minOn = parseInt(cfg.minOn) || def.minOn;
    cfg.maxOn = parseInt(cfg.maxOn) || def.maxOn;
    cfg.minOff = parseInt(cfg.minOff) || def.minOff;
    cfg.maxOff = parseInt(cfg.maxOff) || def.maxOff;

    // ✅ delay: ưu tiên autoCmdDelay mới, fallback cmdDelay cũ
    const rawDelay = (cfg.autoCmdDelay ?? cfg.cmdDelay);
    cfg.autoCmdDelay = Number(rawDelay);
    if (!Number.isFinite(cfg.autoCmdDelay) || cfg.autoCmdDelay <= 0) cfg.autoCmdDelay = def.autoCmdDelay;

    // giữ cmdDelay đồng bộ để tương thích cũ
    cfg.cmdDelay = cfg.autoCmdDelay;

    cfg.firstCmdDelay = Number(cfg.firstCmdDelay);
    if (!Number.isFinite(cfg.firstCmdDelay) || cfg.firstCmdDelay < 0) cfg.firstCmdDelay = def.firstCmdDelay;

    cfg.mcVersion = normalizeMcVersion(cfg.mcVersion);

    if (cfg.minOn > cfg.maxOn) [cfg.minOn, cfg.maxOn] = [cfg.maxOn, cfg.minOn];
    if (cfg.minOff > cfg.maxOff) [cfg.minOff, cfg.maxOff] = [cfg.maxOff, cfg.minOff];

    return cfg;
  } catch {
    return def;
  }
}

function saveCfg(cfg) {
  try {
    ensureUserDataDir();

    if (cfg && typeof cfg === "object") {
      if (cfg.autoCmdDelay != null && cfg.cmdDelay == null) cfg.cmdDelay = cfg.autoCmdDelay;
      if (cfg.cmdDelay != null && cfg.autoCmdDelay == null) cfg.autoCmdDelay = cfg.cmdDelay;
      if (cfg.autoCmdDelay != null) cfg.cmdDelay = cfg.autoCmdDelay;
    }

    fs.writeFileSync(yamlPath, yaml.dump(cfg), "utf8");
  } catch (e) {
    console.error("saveCfg error:", e);
  }
}

function stopAutoCmdTimers(bot) {
  try {
    if (bot?._panelMeta?.autoCmdTimers) {
      bot._panelMeta.autoCmdTimers.forEach((t) => clearTimeout(t));
      bot._panelMeta.autoCmdTimers = [];
    }
    if (bot?._panelMeta) bot._panelMeta.autoCmdRunning = false;
  } catch {}
}

function runAutoCmdOncePerSpawn(bot, name, cfg) {
  if (!autoCmdRuntimeEnabled) return;
  if (!cfg.autoCmdEnabled) return;

  const perBot = runtimeBotCmdMap?.[name];
  const cmdsRaw = Array.isArray(perBot) ? perBot : cfg.autoCmds;
  if (!Array.isArray(cmdsRaw) || cmdsRaw.length === 0) return;

  if (bot._panelMeta.autoCmdRunning) return;
  bot._panelMeta.autoCmdRunning = true;

  const cmds = cmdsRaw.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (cmds.length === 0) return;

  const baseDelayMs = Math.max(0, Number(cfg.firstCmdDelay) || 0) * 1000;

  const delaySec = Number(cfg.autoCmdDelay ?? cfg.cmdDelay ?? 1);
  const stepDelayMs = Math.max(100, Math.max(0.1, delaySec) * 1000);

  const t0 = setTimeout(() => {
    let i = 0;

    const runNext = () => {
      if (!activeBots[name]) return;
      if (!desiredBots.has(name)) return;
      if (!autoCmdRuntimeEnabled) return;
      if (i >= cmds.length) return;

      const cmd = cmds[i++];
      try {
        bot.chat(cmd);
        sendLogs(name, `§8[AutoCmd] §7${cmd}`);
      } catch {}

      const t = setTimeout(runNext, stepDelayMs);
      bot._panelMeta.autoCmdTimers.push(t);
    };

    runNext();
  }, baseDelayMs);

  bot._panelMeta.autoCmdTimers.push(t0);
}

// ====== IPC ======
ipcMain.handle("get-config", () => loadCfg());

ipcMain.on("save-config", (e, cfg) => {
  if (cfg && typeof cfg === "object") saveCfg(cfg);
});

ipcMain.on("toggle-autocmd", (e, enabled) => {
  const cfg = loadCfg();
  cfg.autoCmdEnabled = !!enabled;
  saveCfg(cfg);

  autoCmdRuntimeEnabled = cfg.autoCmdEnabled;

  if (!autoCmdRuntimeEnabled) {
    Object.values(activeBots).forEach((b) => stopAutoCmdTimers(b));
  }
});

// ====== BOT ======
function spawnBot(name) {
  if (!name) return;
  if (activeBots[name]) return;
  if (!desiredBots.has(name)) return;

  const cfg = loadCfg();
  const mcVersion = normalizeMcVersion(cfg.mcVersion);

  const botOpts = {
    host: cfg.ip,
    port: parseInt(cfg.port),
    username: name,
    auth: "offline",
  };
  if (mcVersion) botOpts.version = mcVersion;

  const bot = mineflayer.createBot(botOpts);
  bot._panelMeta = { autoCmdTimers: [], autoCmdRunning: false };

  let quitTimer = null;

  bot.once("spawn", () => {
    activeBots[name] = bot;
    sendLogs(name, `§a✔ Đã vào server! §8(Ver: ${mcVersion || "AUTO"})`);

    runAutoCmdOncePerSpawn(bot, name, cfg);

    const timeOnMs = randInt(cfg.minOn, cfg.maxOn) * 1000;
    quitTimer = setTimeout(() => {
      if (activeBots[name]) {
        try { bot.quit(); } catch {}
      }
    }, timeOnMs);
  });

  /**
   * ✅ Chat: chỉ lấy từ messagestr vị trí "chat" để tránh trùng.
   * -> parse jsonMsg để lấy username.
   */
  bot.on("messagestr", (message, position, jsonMsg) => {
    try {
      // chỉ log chat thật
      if (position && String(position) !== "chat") return;

      const msgStr = String(message ?? "");
      const player = detectPlayerFromAny(msgStr, jsonMsg);

      sendLogs(name, msgStr, player);
    } catch {}
  });

  /**
   * ✅ Server/System: dùng "message" để log mọi thứ,
   * nhưng bỏ các message là chat.type.* để không trùng chat.
   */
  bot.on("message", (m) => {
    try {
      const j = safeParseJson(m?.json);
      if (isChatTranslate(j)) return; // bỏ chat packet (đã log ở messagestr)

      const ansiText = m.toAnsi();
      sendLogs(name, ansiText);
    } catch {
      try { sendLogs(name, m.toAnsi()); } catch {}
    }
  });

  bot.on("kicked", (reason) => {
    let text = "";
    try {
      text =
        reason?.value?.text?.value ??
        reason?.text ??
        (typeof reason === "string" ? reason : JSON.stringify(reason));
    } catch {
      text = String(reason);
    }
    sendLogs(name, `§cBị kick: ${text}`);
  });

  bot.on("error", (err) => {
    sendLogs(name, `§cLỗi: ${err?.message || String(err)}`);
  });

  bot.on("end", () => {
    stopAutoCmdTimers(bot);

    if (quitTimer) clearTimeout(quitTimer);
    delete activeBots[name];

    if (isQuitting) return;

    if (desiredBots.has(name)) {
      const current = loadCfg();
      const timeOffMs = randInt(current.minOff, current.maxOff) * 1000;
      sendLogs(name, `§7Nghỉ ${Math.round(timeOffMs / 1000)}s...`);

      setTimeout(() => {
        if (desiredBots.has(name)) spawnBot(name);
      }, timeOffMs);
    } else {
      sendLogs(name, "§7Đã dừng (không còn được tick).");
    }
  });
}

ipcMain.on("run-all", (e, payload) => {
  const cfg = payload?.cfg ? payload.cfg : payload;
  const botCmdMap = payload?.botCmdMap || {};

  if (!cfg || typeof cfg !== "object") return;

  runtimeBotCmdMap = botCmdMap && typeof botCmdMap === "object" ? botCmdMap : {};

  botServerMap = {};
  const smpList = cfg?.servers?.smp?.selectedBots || [];
  const skyList = cfg?.servers?.sky?.selectedBots || [];
  smpList.forEach((n) => (botServerMap[n] = "smp"));
  skyList.forEach((n) => (botServerMap[n] = "sky"));

  saveCfg(cfg);

  const safe = loadCfg();
  const list = Array.isArray(safe.selectedBots) ? safe.selectedBots : [];

  desiredBots = new Set(list);
  autoCmdRuntimeEnabled = !!safe.autoCmdEnabled;

  const loginDelayMs = Math.max(0, parseInt(safe.loginDelay) || 0) * 1000;
  const preDelayMs = Math.max(0, Number(safe.preConnectDelay) || 0) * 1000;

  list.forEach((name, i) => {
    setTimeout(() => {
      if (desiredBots.has(name)) spawnBot(name);
    }, preDelayMs + i * loginDelayMs);
  });
});

ipcMain.on("stop-all", () => {
  desiredBots.clear();

  Object.values(activeBots).forEach((b) => {
    stopAutoCmdTimers(b);
    try { b.quit(); } catch {}
  });
  activeBots = {};
});

ipcMain.on("stop-selected", (e, { names }) => {
  if (!Array.isArray(names)) return;

  names.forEach((n) => {
    desiredBots.delete(n);
    const b = activeBots[n];
    if (b) {
      stopAutoCmdTimers(b);
      try { b.quit(); } catch {}
    }
  });
});

ipcMain.on("send-global-chat", (e, { names, msg }) => {
  if (!Array.isArray(names)) return;

  const text = String(msg ?? "").trim();
  if (!text) return;

  names.forEach((n) => {
    const b = activeBots[n];
    if (!b) {
      sendLogs("SYSTEM", `§8[Send] §7${n} đang OFFLINE / chưa spawn.`);
      return;
    }
    try {
      b.chat(text);
      sendLogs(n, `§8[Send] §7${text}`);
    } catch (err) {
      sendLogs("SYSTEM", `§c[SendError] ${n}: ${err?.message || String(err)}`);
    }
  });
});

// ====== APP ======
app.whenReady().then(() => {
  ensureUserDataDir();
  createWindow();

  autoCmdRuntimeEnabled = !!loadCfg().autoCmdEnabled;

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  desiredBots.clear();

  Object.values(activeBots).forEach((b) => {
    stopAutoCmdTimers(b);
    try { b.quit(); } catch {}
  });
  activeBots = {};
});
