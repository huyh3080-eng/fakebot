const { app, BrowserWindow, ipcMain, shell } = require("electron");
const mineflayer = require("mineflayer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const yaml = require("js-yaml");

let mainWindow = null;
let activeBots = {};
let isQuitting = false;

let desiredBots = new Set();
let autoCmdRuntimeEnabled = true;
const DEFAULT_CLIENT_BRAND = String(process.env.MC_CLIENT_BRAND || "vanilla").trim() || "vanilla";
const BLOCKED_MOD_CHANNEL_RE = /^(?:fml(?:[:|]|$)|forge(?:[:|]|$)|fabric(?:[:|]|$)|quilt(?:[:|]|$)|liteloader(?:[:|]|$))/i;

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
const CHAT_DEBUG_LOG_PATH = path.join(app.getPath("userData"), "chat-debug.log");
const CHAT_DEDUPE_MS = 4000;
const lastChatSent = new Map();

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

// Ghi debug chat ra file + console (player gửi lên)
function logChatDebug(botName, msgStr, player, rawJson) {
  try {
    ensureUserDataDir();
    const ts = new Date().toISOString();
    const line = `[${ts}] BOT=${botName} | PLAYER=${player || "(none)"} | MSG=${(msgStr || "").slice(0, 80)}\n`;
    fs.appendFileSync(CHAT_DEBUG_LOG_PATH, line, "utf8");
    console.log(`[CHAT] ${botName} | player=${player || "-"} | ${(msgStr || "").slice(0, 60)}`);
    if (rawJson && typeof rawJson === "object" && Object.keys(rawJson).length > 0) {
      const jsonLine = `  JSON: translate=${rawJson.translate || "-"} with[0]=${rawJson.with?.[0] ? JSON.stringify(rawJson.with[0]).slice(0, 100) : "-"}\n`;
      fs.appendFileSync(CHAT_DEBUG_LOG_PATH, jsonLine, "utf8");
    }
  } catch (e) {
    console.error("logChatDebug:", e?.message);
  }
}

// ✅ gửi thêm player (không phá renderer cũ)
function sendLogs(user, msg, player = "") {
  const server = botServerMap?.[user] || "";
  safeSend("log", { user, msg, server, player });
}

function installPayloadGuard(bot, botName) {
  const client = bot?._client;
  if (!client || typeof client.writeChannel !== "function") return;
  const originalWriteChannel = client.writeChannel.bind(client);
  client.writeChannel = (channel, params) => {
    const channelName = String(channel || "").trim();
    if (BLOCKED_MOD_CHANNEL_RE.test(channelName)) {
      sendLogs(botName, `§8[Guard] blocked custom payload channel: ${channelName}`);
      return;
    }
    return originalWriteChannel(channelName, params);
  };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    app.whenReady().then(() => showMainWindow());
  });
}

const isAutoStartMode = () => process.argv.includes("--auto-start");

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
  // Debian auto-start: bỏ qua đăng nhập để bot tự chạy ngay; mở app bình thường thì phải đăng nhập
  if (isAutoStartMode()) {
    mainWindow.loadFile(path.join(__dirname, "index.html"));
  } else {
    mainWindow.loadFile(path.join(__dirname, "login.html"));
  }

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

// Minecraft Java: tên 3–16 ký tự, tránh nhầm nội dung chat (vd: "a") thành tên
function isMcUsername(name) {
  const s = String(name || "").trim();
  return s.length >= 3 && s.length <= 16 && /^[A-Za-z0-9_]+$/.test(s);
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

// Bỏ mã màu § và ANSI để parse tên (vd: "§7IsCz§f: fj" → "IsCz: fj")
function stripMcAndAnsiCodes(str) {
  return String(str || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/§[0-9a-fk-or]/gi, "");
}

function extractFirstUsernameFromText(text) {
  const raw = String(text || "");
  const s = stripMcAndAnsiCodes(raw).trim();
  const namePart = "[A-Za-z0-9_]{3,16}";

  // <Name> msg
  let m = s.match(new RegExp(`<\\s*(${namePart})\\s*>`));
  if (m && isMcUsername(m[1])) return m[1];

  // Name: msg chỉ ở đầu hoặc ngay sau ] (tránh nhầm từ trong nội dung như "buon")
  m = s.match(new RegExp(`(^|\\]\\s*)(${namePart})\\s*:\\s+`));
  if (m && isMcUsername(m[2])) return m[2];

  // Name » msg
  m = s.match(new RegExp(`(^|\\]\\s*)(${namePart})\\s*»\\s+`));
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

    const plain = stripMcAndAnsiCodes(componentToPlainText(jsonObj));
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

// Chỉ lấy tên từ sender server gửi (with[0] / insertion), KHÔNG parse từ nội dung chat
function getSenderFromPacketOnly(jsonMaybe, msgObj) {
  const j = safeParseJson(jsonMaybe);
  if (j && typeof j === "object" && typeof j.translate === "string" && Array.isArray(j.with) && j.with.length > 0) {
    const senderText = componentToPlainText(j.with[0]).trim();
    const token = senderText.split(/\s+/).find(isMcUsername);
    if (token) return token;
    if (isMcUsername(senderText)) return senderText;
  }
  if (j && isMcUsername(j.insertion)) return String(j.insertion).trim();
  if (msgObj && typeof msgObj === "object" && msgObj.with && msgObj.with[0]) {
    const first = msgObj.with[0];
    const text = typeof first === "string" ? first : (first?.text ?? (first?.json ? componentToPlainText(first.json) : ""));
    const nameStr = String(text || "").trim();
    if (nameStr && isMcUsername(nameStr)) return nameStr;
  }
  return "";
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
// configVersion: tăng khi đổi cấu trúc config để sau này có thể chạy migration
const CONFIG_VERSION = 1;

function loadCfg() {
  const def = {
    configVersion: CONFIG_VERSION,
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
    autoCmdDelay: 1,

    firstCmdDelay: 1.5,

    loginDelay: 1,
    minOn: 30,
    maxOn: 60,
    minOff: 10,
    maxOff: 20,

    groups: [],
    activeGroupId: "",

    autoStartOnBoot: true,
  };

  if (!fs.existsSync(yamlPath)) return def;

  try {
    const raw = yaml.load(fs.readFileSync(yamlPath, "utf8")) || {};
    // Luôn merge def + raw: dữ liệu cũ giữ nguyên, key mới (tính năng mới) lấy từ def
    const cfg = { ...def, ...raw };
    // Sau này nếu đổi cấu trúc: if (cfg.configVersion < 2) { ... migration ... cfg.configVersion = 2; }
    cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
    cfg.selectedBots = Array.isArray(cfg.selectedBots) ? cfg.selectedBots : [];
    cfg.autoCmds = Array.isArray(cfg.autoCmds) ? cfg.autoCmds : [];

    cfg.groups = Array.isArray(cfg.groups) ? cfg.groups : [];
    cfg.activeGroupId = String(cfg.activeGroupId || "");

    cfg.autoCmdEnabled = !!cfg.autoCmdEnabled;
    cfg.autoStartOnBoot = !!cfg.autoStartOnBoot;

    cfg.preConnectDelay = Number(cfg.preConnectDelay);
    if (!Number.isFinite(cfg.preConnectDelay) || cfg.preConnectDelay < 0) cfg.preConnectDelay = 0;

    cfg.port = parseInt(cfg.port) || def.port;
    cfg.loginDelay = parseInt(cfg.loginDelay) || def.loginDelay;

    cfg.minOn = parseInt(cfg.minOn) || def.minOn;
    cfg.maxOn = parseInt(cfg.maxOn) || def.maxOn;
    cfg.minOff = parseInt(cfg.minOff) || def.minOff;
    cfg.maxOff = parseInt(cfg.maxOff) || def.maxOff;

    // Giới hạn On/Off trong khoảng hợp lý (giây), tránh config lỗi → "Nghỉ 1455885s"
    const MAX_ON_OFF_SEC = 86400; // tối đa 24h
    cfg.minOn = Math.max(1, Math.min(MAX_ON_OFF_SEC, cfg.minOn));
    cfg.maxOn = Math.max(1, Math.min(MAX_ON_OFF_SEC, cfg.maxOn));
    cfg.minOff = Math.max(0, Math.min(MAX_ON_OFF_SEC, cfg.minOff));
    cfg.maxOff = Math.max(0, Math.min(MAX_ON_OFF_SEC, cfg.maxOff));

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
      cfg.configVersion = CONFIG_VERSION;
    }

    fs.writeFileSync(yamlPath, yaml.dump(cfg), "utf8");
  } catch (e) {
    console.error("saveCfg error:", e);
  }
}

// ====== AUTO START ON BOOT (Debian/Linux – systemd) ======
const SYSTEMD_SERVICE_NAME = "oceandeep-bot-panel.service";

function getSystemdUserDir() {
  return path.join(os.homedir(), ".config", "systemd", "user");
}

function getSystemdServicePath() {
  return path.join(getSystemdUserDir(), SYSTEMD_SERVICE_NAME);
}

function installSystemdService() {
  if (process.platform !== "linux") return { ok: false, message: "Chỉ hỗ trợ Linux/Debian." };
  try {
    const userDir = getSystemdUserDir();
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    const execPath = process.execPath.replace(/\\/g, "/");
    const appPath = app.getAppPath().replace(/\\/g, "/");
    const execStart = [execPath, appPath].some((p) => p.includes(" "))
      ? `"${execPath}" "${appPath}" --auto-start`
      : `${execPath} ${appPath} --auto-start`;

    const content = `[Unit]
Description=Oceandeep Bot Panel - Tự chạy bot khi khởi động máy
After=network-online.target graphical-session.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${appPath}
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
Environment=DISPLAY=:0
Environment=XAUTHORITY=%h/.Xauthority

[Install]
WantedBy=default.target
`;
    const servicePath = getSystemdServicePath();
    fs.writeFileSync(servicePath, content, "utf8");

    return new Promise((resolve) => {
      const child = spawn("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      child.on("close", (code1) => {
        if (code1 !== 0) {
          resolve({ ok: false, message: "daemon-reload thất bại. Chạy: systemctl --user daemon-reload" });
          return;
        }
        const child2 = spawn("systemctl", ["--user", "enable", SYSTEMD_SERVICE_NAME], { stdio: "ignore" });
        child2.on("close", (code2) => {
          if (code2 !== 0) {
            resolve({ ok: false, message: "enable thất bại. Chạy: systemctl --user enable " + SYSTEMD_SERVICE_NAME });
            return;
          }
          resolve({
            ok: true,
            message: "Đã bật. App sẽ tự chạy khi bạn đăng nhập vào máy (sau reboot). Kiểm tra: systemctl --user status " + SYSTEMD_SERVICE_NAME,
          });
        });
      });
    });
  } catch (e) {
    return Promise.resolve({ ok: false, message: e?.message || String(e) });
  }
}

function uninstallSystemdService() {
  if (process.platform !== "linux") return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    const child = spawn("systemctl", ["--user", "disable", "--now", SYSTEMD_SERVICE_NAME], { stdio: "ignore" });
    child.on("close", (code) => {
      try {
        const p = getSystemdServicePath();
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
      resolve({ ok: true, message: "Đã tắt khởi động cùng máy." });
    });
  });
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
// Login: chỉ lưu hash (SHA-256 + salt), không lưu mật khẩu plain text (an toàn khi đưa source lên web).
// Đổi mật khẩu: chạy node -e "console.log(require('crypto').createHash('sha256').update('oceandeep_panel_salt'+'MẬT_KHẨU_MỚI').digest('hex'))" rồi thay LOGIN_PASS_HASH.
const LOGIN_USER = "admin";
const LOGIN_SALT = "oceandeep_panel_salt";
const LOGIN_PASS_HASH = "8b7bc0ed5126710c50663a6313ea46fc027f8845b2c1841a4197c2994c99deea";

ipcMain.handle("login", (e, { user, pass } = {}) => {
  const u = String(user || "").trim();
  const p = String(pass || "");
  const inputHash = crypto.createHash("sha256").update(LOGIN_SALT + p).digest("hex");
  if (u === LOGIN_USER && inputHash === LOGIN_PASS_HASH) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, "index.html"));
    }
    return { ok: true };
  }
  return { ok: false, message: "Sai tài khoản hoặc mật khẩu." };
});

ipcMain.handle("get-config", () => loadCfg());

ipcMain.handle("open-user-data-folder", async () => {
  const dir = app.getPath("userData");
  await shell.openPath(dir);
});

ipcMain.handle("export-config", () => {
  try {
    if (!fs.existsSync(yamlPath)) return null;
    return fs.readFileSync(yamlPath, "utf8");
  } catch (e) {
    console.error("export-config:", e);
    return null;
  }
});

ipcMain.handle("import-config", (e, yamlContent) => {
  try {
    if (typeof yamlContent !== "string" || !yamlContent.trim()) return { ok: false, error: "Nội dung trống" };
    const parsed = yaml.load(yamlContent);
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "File YAML không hợp lệ" };
    ensureUserDataDir();
    fs.writeFileSync(yamlPath, yamlContent, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

let lastAllOnlineSent = false;
function emitBotStatus() {
  const online = Object.keys(activeBots).length;
  const total = desiredBots.size;
  safeSend("bot-status", { online, total });
  if (total > 0 && online === total && !lastAllOnlineSent) {
    safeSend("notify-all-online", { total });
    lastAllOnlineSent = true;
  }
}

ipcMain.on("save-config", (e, cfg) => {
  if (!cfg || typeof cfg !== "object") return;
  // Gộp với config đang lưu để không mất key cũ khi cập nhật app (client có thể chưa gửi key mới)
  const merged = { ...loadCfg(), ...cfg };
  saveCfg(merged);
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

ipcMain.handle("get-platform", () => process.platform);

ipcMain.handle("toggle-auto-start-on-boot", async (e, enabled) => {
  const cfg = loadCfg();
  cfg.autoStartOnBoot = !!enabled;
  saveCfg(cfg);
  if (process.platform !== "linux") {
    return { ok: true, message: enabled ? "Đã bật (chỉ có hiệu lực khi chạy trên Linux)." : "Đã tắt." };
  }
  if (enabled) return installSystemdService();
  return uninstallSystemdService();
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
    brand: DEFAULT_CLIENT_BRAND,
  };
  if (mcVersion) botOpts.version = mcVersion;

  const bot = mineflayer.createBot(botOpts);
  installPayloadGuard(bot, name);
  bot._panelMeta = { autoCmdTimers: [], autoCmdRunning: false };

  let quitTimer = null;

  bot.once("spawn", () => {
    activeBots[name] = bot;
    emitBotStatus();
    sendLogs(name, `§a✔ Đã vào server! §8(Ver: ${mcVersion || "AUTO"})`);

    runAutoCmdOncePerSpawn(bot, name, cfg);

    // Random thời gian online riêng từng bot, thêm jitter 0–12s để không rời hàng loạt
    const timeOnSec = randInt(cfg.minOn, cfg.maxOn);
    const jitterOnSec = randInt(0, 12);
    const timeOnMs = (timeOnSec + jitterOnSec) * 1000;
    quitTimer = setTimeout(() => {
      if (activeBots[name]) {
        try { bot.quit(); } catch {}
      }
    }, timeOnMs);
  });

  /**
   * ✅ Chat: chỉ lấy từ messagestr vị trí "chat" để tránh trùng.
   * -> Lấy tên player từ server: msg.json (prismarine-chat) hoặc sender (packet).
   */
  bot.on("messagestr", (message, position, msg, packetSender) => {
    try {
      if (position && String(position) !== "chat") return;

      const msgStr = String(message ?? "");
      const rawJson = msg && typeof msg === "object" && msg.json ? msg.json : (typeof msg === "object" && msg !== null && !Array.isArray(msg) ? msg : null);
      // CHAT: chỉ lấy tên từ packet/JSON (with[0]), KHÔNG parse từ nội dung → tránh [ngon], [lam] sai
      const player = getSenderFromPacketOnly(rawJson, msg);

      // Dedupe: cùng bot + cùng nội dung trong CHAT_DEDUPE_MS chỉ gửi 1 lần
      const norm = stripMcAndAnsiCodes(msgStr).trim().slice(0, 200);
      const dedupeKey = `${name}|${norm}`;
      const now = Date.now();
      const last = lastChatSent.get(dedupeKey);
      if (last != null && now - last < CHAT_DEDUPE_MS) return;
      lastChatSent.set(dedupeKey, now);
      if (lastChatSent.size > 500) {
        const cut = now - CHAT_DEDUPE_MS * 2;
        for (const k of lastChatSent.keys()) if (lastChatSent.get(k) < cut) lastChatSent.delete(k);
      }

      logChatDebug(name, msgStr, player, rawJson);
      sendLogs(name, msgStr, player);
    } catch {}
  });

  /**
   * Server/System: log mọi thứ TRỪ chat (chat đã log ở messagestr → 1 tin chỉ 1 lần)
   */
  bot.on("message", (m, position) => {
    try {
      if (position === "chat") return; // không log chat ở đây, chỉ ở messagestr

      const j = safeParseJson(m?.json);
      if (isChatTranslate(j)) return;

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
    safeSend("notify-kick", { botName: name, reason: text });
  });

  bot.on("error", (err) => {
    sendLogs(name, `§cLỗi: ${err?.message || String(err)}`);
  });

  bot.on("end", () => {
    stopAutoCmdTimers(bot);

    if (quitTimer) clearTimeout(quitTimer);
    delete activeBots[name];
    emitBotStatus();

    if (isQuitting) return;

    if (desiredBots.has(name)) {
      const current = loadCfg();
      const minOff = Math.max(0, Math.min(86400, parseInt(current.minOff) || 0));
      const maxOff = Math.max(0, Math.min(86400, parseInt(current.maxOff) || 0));
      // Random thời gian nghỉ riêng từng bot, thêm jitter 0–8s để không vào lại hàng loạt
      const timeOffSec = randInt(minOff, maxOff || minOff);
      const jitterOffSec = randInt(0, 8);
      const timeOffMs = (timeOffSec + jitterOffSec) * 1000;
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
  const list = Array.isArray(cfg.selectedBots) && cfg.selectedBots.length > 0
    ? cfg.selectedBots
    : (Array.isArray(safe.selectedBots) ? safe.selectedBots : []);

  desiredBots = new Set(list);
  autoCmdRuntimeEnabled = !!safe.autoCmdEnabled;

  // Delay từ config UI (cfg) — đảm bảo dùng đúng số đã chỉnh
  const loginDelaySec = Math.max(0, parseInt(cfg.loginDelay, 10) || 0);
  const preConnectDelaySec = Math.max(0, Number(cfg.preConnectDelay) || 0);
  const loginDelayMs = loginDelaySec * 1000;
  const MIN_FIRST_CONNECT_MS = 5000;
  const preDelayMs = Math.max(MIN_FIRST_CONNECT_MS, preConnectDelaySec * 1000);

  lastAllOnlineSent = false;
  list.forEach((name, i) => {
    setTimeout(() => {
      if (desiredBots.has(name)) spawnBot(name);
    }, preDelayMs + i * loginDelayMs);
  });
  emitBotStatus();
});

ipcMain.on("stop-all", () => {
  desiredBots.clear();
  emitBotStatus();

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
  emitBotStatus();
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
