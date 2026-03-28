const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");
const mineflayer = require("mineflayer");

const app = express();
const server = http.createServer(app);

// Base path khi chạy sau reverse proxy (vd: https://cp.oceandeepsmc.top/loginbot)
// Set env: BASE_PATH=/loginbot
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/$/, "");
const cookiePath = BASE_PATH || "/";

// URL gốc đúng (domain): khi user vào bằng IP thì redirect sang domain. Set env: CANONICAL_BASE_URL=https://cp.oceandeepsmc.top
const CANONICAL_BASE_URL = (process.env.CANONICAL_BASE_URL || "").replace(/\/$/, "");

const wss = new WebSocket.Server(BASE_PATH ? { server, path: BASE_PATH } : { server });

app.use(express.json());

// Redirect truy cập bằng IP sang domain (vd: 14.234.215.144:3000 → https://cp.oceandeepsmc.top/bot)
// Dùng X-Forwarded-Host nếu có (Nginx: proxy_set_header Host $host) để tránh redirect loop
if (CANONICAL_BASE_URL) {
  try {
    const canonicalHost = new URL(CANONICAL_BASE_URL).hostname.toLowerCase();
    app.use((req, res, next) => {
      const forwarded = (req.get("x-forwarded-host") || req.get("host") || "").toString().toLowerCase();
      const host = forwarded.split(":")[0].split(",")[0].trim();
      if (!host || host === "127.0.0.1" || host === "localhost") return next();
      if (host !== canonicalHost) {
        const target = CANONICAL_BASE_URL + (req.path || "/");
        return res.redirect(302, target);
      }
      next();
    });
  } catch (_) {}
}

// ====== ĐĂNG NHẬP WEB – tài khoản/mật khẩu chỉ cấu hình qua env (LOGIN_USER, LOGIN_PASS_HASH), không lộ ra ngoài ======
const LOGIN_USER = process.env.LOGIN_USER || "admin";
const LOGIN_SALT = process.env.LOGIN_SALT || "oceandeep_panel_salt";
const LOGIN_PASS_HASH = process.env.LOGIN_PASS_HASH || "8b7bc0ed5126710c50663a6313ea46fc027f8845b2c1841a4197c2994c99deea";
const SESSION_COOKIE = "oceandeep_sid";
const sessions = new Set(); // token -> valid

function parseCookie(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return m ? m[1].trim() : null;
}

function isLoggedIn(req) {
  const sid = parseCookie(req);
  return sid && sessions.has(sid);
}

// Bảo vệ panel: /bot và mọi route khác (trừ trang login, /api/login, /api/ping, /logo.png) bắt buộc phải đăng nhập
function requireAuth(req, res, next) {
  const p = req.path;
  const loginPath = BASE_PATH ? BASE_PATH + "/loginbot" : "/loginbot";
  const isLoginPage = p === "/loginbot" || p === "/loginbot/" || p === loginPath || p === loginPath + "/";
  const isAuthApi = p === "/api/login" || p === "/api/ping";
  const isLogo = p === "/logo.png";
  const basePluginPrefix = BASE_PATH ? BASE_PATH + "/api/plugin/" : "";
  const basePanelBotsPath = BASE_PATH ? BASE_PATH + "/api/panel-bots" : "";
  const isPluginApi = p.startsWith("/api/plugin/") || p === "/api/panel-bots" || (basePluginPrefix && p.startsWith(basePluginPrefix)) || (basePanelBotsPath && p === basePanelBotsPath);
  if (isLoginPage || isAuthApi || isLogo || isPluginApi) return next();
  if (!isLoggedIn(req)) {
    if (p.startsWith("/api/")) return res.status(401).json({ ok: false, message: "Chưa đăng nhập." });
    const loginUrl = BASE_PATH ? BASE_PATH + "/loginbot" : "/loginbot";
    return res.redirect(302, loginUrl);
  }
  next();
}

app.use(requireAuth);

// Khi dùng BASE_PATH, gỡ prefix cho /bot và /api/* để route bên dưới khớp (không gỡ /loginbot)
app.use((req, res, next) => {
  if (!BASE_PATH || !req.path.startsWith(BASE_PATH)) return next();
  const rest = req.path.slice(BASE_PATH.length);
  if (rest === "" || rest === "/" || rest === "/loginbot" || rest === "/loginbot/") return next();
  const newPath = rest.startsWith("/") ? rest : "/" + rest;
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  req.url = newPath + q;
  next();
});

function sendLoginHtml(req, res) {
  const filePath = path.join(__dirname, "login-web.html");
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) return res.status(500).send(err.message);
    const html = data.replace(/__BASE_PATH__/g, BASE_PATH);
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.send(html);
  });
}

function sendWebHtml(req, res) {
  const filePath = path.join(__dirname, "web.html");
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) return res.status(500).send(err.message);
    const html = data.replace(/__BASE_PATH__/g, BASE_PATH);
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.send(html);
  });
}

// Trang đăng nhập hoặc redirect tới panel
const panelPath = BASE_PATH ? BASE_PATH + "/bot" : "/bot";
function handleRootOrLogin(req, res) {
  if (isLoggedIn(req)) return res.redirect(302, panelPath);
  sendLoginHtml(req, res);
}
if (BASE_PATH) {
  app.get(BASE_PATH, handleRootOrLogin);
  app.get(BASE_PATH + "/", handleRootOrLogin);
  app.get(BASE_PATH + "/loginbot", handleRootOrLogin);
  app.get(BASE_PATH + "/loginbot/", handleRootOrLogin);
} else {
  app.get("/", handleRootOrLogin);
  app.get("/loginbot", handleRootOrLogin);
  app.get("/loginbot/", handleRootOrLogin);
}

// API đăng nhập
function apiLogin(req, res) {
  const user = String(req.body?.user ?? "").trim();
  const pass = String(req.body?.pass ?? "");
  const inputHash = crypto.createHash("sha256").update(LOGIN_SALT + pass).digest("hex");
  if (user === LOGIN_USER && inputHash === LOGIN_PASS_HASH) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.add(token);
    // Session cookie (không maxAge/expires): thoát/đóng trình duyệt là hết phiên, vào lại phải login, không vào /bot trực tiếp được
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, path: cookiePath, sameSite: "lax" });
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    return res.json({ ok: true });
  }
  res.json({ ok: false, message: "Sai tài khoản hoặc mật khẩu." });
}
app.post("/api/login", apiLogin);
app.get("/api/login", (req, res) => res.status(405).json({ ok: false, message: "Use POST to login." }));
app.get("/api/ping", (req, res) => res.json({ ok: true, pong: true }));

// API đăng xuất (tùy chọn)
function apiLogout(req, res) {
  const sid = parseCookie(req);
  if (sid) sessions.delete(sid);
  res.clearCookie(SESSION_COOKIE, { path: cookiePath });
  res.json({ ok: true });
}
app.post("/api/logout", apiLogout);

// Serve logo (cho cả trang login)
app.get("/logo.png", (req, res) => {
  res.sendFile(path.join(__dirname, "logo.png"));
});

// Root khi có BASE_PATH đã xử lý redirect ở trên

// Dashboard: chỉ vào được /bot khi đã đăng nhập (requireAuth ở trên đã chặn)
app.get("/bot", (req, res) => { sendWebHtml(req, res); });
app.get("/bot/", (req, res) => { sendWebHtml(req, res); });
app.get("/bot/panel", (req, res) => res.redirect(302, BASE_PATH ? BASE_PATH + "/bot" : "/bot"));
app.get("/bot/panel/", (req, res) => res.redirect(302, BASE_PATH ? BASE_PATH + "/bot" : "/bot"));
app.get("/panel", (req, res) => res.redirect(302, BASE_PATH ? BASE_PATH + "/bot" : "/bot"));
app.get("/panel/", (req, res) => res.redirect(302, BASE_PATH ? BASE_PATH + "/bot" : "/bot"));

// Data file path (Docker: dùng DATA_DIR để mount volume, vd DATA_DIR=/data)
const dataDir = process.env.DATA_DIR || __dirname;
const yamlPath = path.join(dataDir, "data.yml");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Global state
let CFG = {
  ip: "localhost",
  port: 25565,
  mcVersion: "",
  autoCmdEnabled: true,
  preConnectDelay: 0,
  loginDelay: 2,
  minOn: 30,
  maxOn: 60,
  minOff: 10,
  maxOff: 20,
  cmdDelay: 1,
  autoCmdDelay: 1,
  firstCmdDelay: 1.5,
  servers: {
    smp: { accounts: [], selectedBots: [], autoCmds: [] },
    sky: { accounts: [], selectedBots: [], autoCmds: [] },
  },
  accounts: [],
  selectedBots: [],
  autoCmds: [],
  autoStartOnBoot: true,
};

let activeBots = {};
let desiredBots = new Set();
let autoCmdRuntimeEnabled = true;
let runtimeBotCmdMap = {};
let isQuitting = false;

// Bot to server mapping
let botServerMap = {};
const pendingSpawnTimersByBot = new Map();
const serverReconnectStateByKey = new Map();
const LOGIN_ATTEMPT_GAP_MIN_MS = 12000;
const LOGIN_ATTEMPT_GAP_JITTER_MS = 2500;
const FAST_LOGIN_COOLDOWN_BASE_MS = 45000;
const FAST_LOGIN_COOLDOWN_MAX_MS = 300000;
const LOGIN_INFLIGHT_RETRY_MIN_MS = 2000;
const LOGIN_INFLIGHT_RETRY_MAX_MS = 4500;

// WebSocket clients
const clients = new Set();

wss.on("connection", (ws, req) => {
  clients.add(ws);
  ws.send(JSON.stringify({ channel: "bot-status", data: { online: Object.keys(activeBots).length, total: desiredBots.size } }));
  ws.on("close", () => clients.delete(ws));
});

function broadcast(channel, data) {
  const msg = JSON.stringify({ channel, data });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function emitBotStatus() {
  const online = Object.keys(activeBots).length;
  const total = desiredBots.size;
  broadcast("bot-status", { online, total });
}

function sendLogs(user, msg, player = "") {
  const server = botServerMap?.[user] || "";
  broadcast("log", { user, msg, server, player });
}

function syncLegacyAliasesFromServers() {
  const smp = CFG?.servers?.smp || { accounts: [], selectedBots: [], autoCmds: [] };
  CFG.accounts = Array.isArray(smp.accounts) ? [...smp.accounts] : [];
  CFG.selectedBots = Array.isArray(smp.selectedBots) ? [...smp.selectedBots] : [];
  CFG.autoCmds = Array.isArray(smp.autoCmds) ? [...smp.autoCmds] : [];
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function applyIncomingConfig(newCfg) {
  if (!newCfg || typeof newCfg !== "object") return;

  if (newCfg.servers && typeof newCfg.servers === "object") {
    if (newCfg.servers.smp) {
      CFG.servers.smp.accounts = toArray(newCfg.servers.smp.accounts);
      CFG.servers.smp.selectedBots = toArray(newCfg.servers.smp.selectedBots);
      CFG.servers.smp.autoCmds = toArray(newCfg.servers.smp.autoCmds);
    }
    if (newCfg.servers.sky) {
      CFG.servers.sky.accounts = toArray(newCfg.servers.sky.accounts);
      CFG.servers.sky.selectedBots = toArray(newCfg.servers.sky.selectedBots);
      CFG.servers.sky.autoCmds = toArray(newCfg.servers.sky.autoCmds);
    }
  } else {
    if (Array.isArray(newCfg.accounts)) CFG.servers.smp.accounts = newCfg.accounts;
    if (Array.isArray(newCfg.selectedBots)) CFG.servers.smp.selectedBots = newCfg.selectedBots;
    if (Array.isArray(newCfg.autoCmds)) CFG.servers.smp.autoCmds = newCfg.autoCmds;
  }
  syncLegacyAliasesFromServers();

  CFG.ip = newCfg.ip || CFG.ip;
  CFG.port = newCfg.port || CFG.port;
  CFG.mcVersion = newCfg.mcVersion !== undefined ? newCfg.mcVersion : CFG.mcVersion;
  CFG.autoCmdEnabled = newCfg.autoCmdEnabled !== undefined ? newCfg.autoCmdEnabled : CFG.autoCmdEnabled;
  CFG.preConnectDelay = newCfg.preConnectDelay !== undefined ? newCfg.preConnectDelay : CFG.preConnectDelay;
  CFG.loginDelay = newCfg.loginDelay !== undefined ? newCfg.loginDelay : CFG.loginDelay;
  CFG.autoCmdDelay = newCfg.autoCmdDelay !== undefined ? newCfg.autoCmdDelay : CFG.autoCmdDelay;
  CFG.firstCmdDelay = newCfg.firstCmdDelay !== undefined ? newCfg.firstCmdDelay : CFG.firstCmdDelay;
  CFG.minOn = newCfg.minOn !== undefined ? newCfg.minOn : CFG.minOn;
  CFG.maxOn = newCfg.maxOn !== undefined ? newCfg.maxOn : CFG.maxOn;
  CFG.minOff = newCfg.minOff !== undefined ? newCfg.minOff : CFG.minOff;
  CFG.maxOff = newCfg.maxOff !== undefined ? newCfg.maxOff : CFG.maxOff;
  CFG.autoStartOnBoot = newCfg.autoStartOnBoot !== undefined ? !!newCfg.autoStartOnBoot : CFG.autoStartOnBoot;
}

function loadCfg() {
  try {
    if (fs.existsSync(yamlPath)) {
      const raw = yaml.load(fs.readFileSync(yamlPath, "utf8")) || {};
      
      // Load servers structure from file
      if (raw.servers && (raw.servers.smp || raw.servers.sky)) {
        CFG.servers = {
          smp: {
            accounts: toArray(raw.servers.smp?.accounts),
            selectedBots: toArray(raw.servers.smp?.selectedBots),
            autoCmds: toArray(raw.servers.smp?.autoCmds)
          },
          sky: {
            accounts: toArray(raw.servers.sky?.accounts),
            selectedBots: toArray(raw.servers.sky?.selectedBots),
            autoCmds: toArray(raw.servers.sky?.autoCmds)
          }
        };
      } else {
        // Backward compatibility: legacy root format (accounts/selectedBots/autoCmds)
        const legacyAccounts = Array.isArray(raw.accounts) ? raw.accounts : [];
        const legacySelectedBots = Array.isArray(raw.selectedBots) ? raw.selectedBots : [];
        const legacyAutoCmds = Array.isArray(raw.autoCmds) ? raw.autoCmds : [];
        if (legacyAccounts.length || legacySelectedBots.length || legacyAutoCmds.length) {
          CFG.servers.smp = {
            accounts: legacyAccounts,
            selectedBots: legacySelectedBots,
            autoCmds: legacyAutoCmds
          };
        }
      }
      syncLegacyAliasesFromServers();
      
      // Load other config fields
      CFG.ip = raw.ip || CFG.ip;
      CFG.port = raw.port || CFG.port;
      CFG.mcVersion = raw.mcVersion !== undefined ? raw.mcVersion : CFG.mcVersion;
      CFG.autoCmdEnabled = raw.autoCmdEnabled !== undefined ? raw.autoCmdEnabled : CFG.autoCmdEnabled;
      CFG.preConnectDelay = raw.preConnectDelay !== undefined ? raw.preConnectDelay : CFG.preConnectDelay;
      CFG.loginDelay = raw.loginDelay !== undefined ? raw.loginDelay : CFG.loginDelay;
      CFG.autoCmdDelay = raw.autoCmdDelay !== undefined ? raw.autoCmdDelay : CFG.autoCmdDelay;
      CFG.firstCmdDelay = raw.firstCmdDelay !== undefined ? raw.firstCmdDelay : CFG.firstCmdDelay;
      CFG.minOn = raw.minOn !== undefined ? raw.minOn : CFG.minOn;
      CFG.maxOn = raw.maxOn !== undefined ? raw.maxOn : CFG.maxOn;
      CFG.minOff = raw.minOff !== undefined ? raw.minOff : CFG.minOff;
      CFG.maxOff = raw.maxOff !== undefined ? raw.maxOff : CFG.maxOff;
      CFG.autoStartOnBoot = raw.autoStartOnBoot !== undefined ? !!raw.autoStartOnBoot : CFG.autoStartOnBoot;
    }
  } catch (e) {
    console.error("loadCfg error:", e);
  }
}

function saveCfg() {
  try {
    syncLegacyAliasesFromServers();

    // Build config object for saving
    const configToSave = {
      ip: CFG.ip,
      port: CFG.port,
      mcVersion: CFG.mcVersion,
      autoCmdEnabled: CFG.autoCmdEnabled,
      preConnectDelay: CFG.preConnectDelay,
      loginDelay: CFG.loginDelay,
      autoCmdDelay: CFG.autoCmdDelay,
      firstCmdDelay: CFG.firstCmdDelay,
      minOn: CFG.minOn,
      maxOn: CFG.maxOn,
      minOff: CFG.minOff,
      maxOff: CFG.maxOff,
      autoStartOnBoot: CFG.autoStartOnBoot,
      // Keep legacy keys for full backward compatibility with old data.yml clients
      accounts: CFG.accounts,
      selectedBots: CFG.selectedBots,
      autoCmds: CFG.autoCmds,
      servers: {
        smp: {
          accounts: CFG.servers.smp.accounts,
          selectedBots: CFG.servers.smp.selectedBots,
          autoCmds: CFG.servers.smp.autoCmds
        },
        sky: {
          accounts: CFG.servers.sky.accounts,
          selectedBots: CFG.servers.sky.selectedBots,
          autoCmds: CFG.servers.sky.autoCmds
        }
      }
    };
    
    fs.writeFileSync(yamlPath, yaml.dump(configToSave), "utf8");
  } catch (e) {
    console.error("saveCfg error:", e);
  }
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function normalizeMcVersion(v) {
  const s = String(v ?? "").trim();
  if (!s || s.toLowerCase() === "auto") return "";
  return s;
}

function isMcUsername(name) {
  return /^[A-Za-z0-9_]{1,16}$/.test(String(name || "").trim());
}

function extractPlainText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node?.text === "string") return node.text;
  if (typeof node?.value === "string") return node.value;

  const chunks = [];
  if (Array.isArray(node)) {
    node.forEach((x) => {
      const t = extractPlainText(x);
      if (t) chunks.push(t);
    });
    return chunks.join(" ").trim();
  }

  if (Array.isArray(node?.extra)) {
    node.extra.forEach((x) => {
      const t = extractPlainText(x);
      if (t) chunks.push(t);
    });
  }
  if (Array.isArray(node?.with)) {
    node.with.forEach((x) => {
      const t = extractPlainText(x);
      if (t) chunks.push(t);
    });
  }
  return chunks.join(" ").trim();
}

function extractPlayerFromJsonChat(chatNode) {
  if (!chatNode || typeof chatNode !== "object") return "";

  if (Array.isArray(chatNode.with) && chatNode.with.length > 0) {
    const first = extractPlainText(chatNode.with[0]).trim();
    if (isMcUsername(first)) return first;
  }

  const directNameCandidates = [
    chatNode.username,
    chatNode.sender,
    chatNode.name,
    chatNode.insertion,
  ];
  for (const c of directNameCandidates) {
    const s = String(c || "").trim();
    if (isMcUsername(s)) return s;
  }

  const visit = [];
  if (Array.isArray(chatNode.with)) visit.push(...chatNode.with);
  if (Array.isArray(chatNode.extra)) visit.push(...chatNode.extra);
  for (const child of visit) {
    const got = extractPlayerFromJsonChat(child);
    if (got) return got;
  }
  return "";
}

function extractPlayerNameFromMessage(message, jsonMsg, sender) {
  const senderName = String(sender || "").trim();
  if (isMcUsername(senderName)) return senderName;

  const fromJson = extractPlayerFromJsonChat(jsonMsg);
  if (fromJson) return fromJson;

  const msg = String(message || "");
  const patterns = [
    /<\s*([A-Za-z0-9_]{1,16})\s*>/,
    /\]\s*([A-Za-z0-9_]{1,16})\s*:\s+/,
    /^([A-Za-z0-9_]{1,16})\s*(?:\u00BB|:)\s+/,
    /\[[^\]]*?\]\s*([A-Za-z0-9_]{1,16})\s*(?:\u00BB|:)\s+/,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m && isMcUsername(m[1])) return m[1];
  }
  return "";
}

async function maybeHandleAiChatTrigger() {
  return;
}

/*
async function maybeHandleAiChatTrigger({ listenerBotName, bot, message, player }) {
  try {
    if (!aiBridgeExtension || typeof aiBridgeExtension.processPluginChat !== "function") return;

    const rawMessage = String(message || "").trim();
    if (!rawMessage) return;

    const playerName = String(player || "").trim();
    if (!playerName || !isMcUsername(playerName)) return;
    if (hasActiveBotName(playerName)) return;

    const panelBots = (typeof aiBridgeExtension.getPublicBots === "function" ? aiBridgeExtension.getPublicBots() : [])
      .filter((x) => x && x.status !== "off" && String(x.prefix || "").startsWith("@"));
    if (panelBots.length === 0) return;

    const lowerMessage = rawMessage.toLowerCase();
    const mentionToken = extractLeadingMentionToken(rawMessage);
    let selectedAiBot = null;
    let messageForAi = rawMessage;

    if (mentionToken) {
      const mentionName = mentionToken.slice(1);
      if (mentionName === String(listenerBotName || "").toLowerCase()) {
        selectedAiBot = panelBots[0];
        messageForAi = rawMessage.slice(mentionToken.length).trim();
      } else if (hasActiveBotName(mentionName)) {
        return;
      }
    }

    if (!selectedAiBot) {
      selectedAiBot = panelBots.find((x) => lowerMessage.startsWith(String(x.prefix || "").toLowerCase())) || null;
      if (!selectedAiBot) return;
      const primaryResponder = getPrimaryResponderBotName();
      if (primaryResponder && String(listenerBotName).toLowerCase() !== String(primaryResponder).toLowerCase()) return;
    }

    if (!messageForAi.trim()) return;

    const dedupeKey = `${selectedAiBot.id}|${playerName.toLowerCase()}|${lowerMessage}`;
    if (isDuplicateAiTrigger(dedupeKey)) return;

    const result = await aiBridgeExtension.processPluginChat(
      {
        botId: selectedAiBot.id,
        prefix: selectedAiBot.prefix,
        player: playerName,
        message: messageForAi,
      },
      `ingame:${listenerBotName}`
    );

    const reply = String(result?.reply || "").trim();
    if (!reply) return;

    const typingExtraMs = Math.max(0, Math.min(1200, Math.floor(Number(result?.typingMs || 0) * 0.25)));
    if (typingExtraMs > 0) await new Promise((resolve) => setTimeout(resolve, typingExtraMs));

    if (!desiredBots.has(listenerBotName)) return;
    if (!activeBots[listenerBotName]) return;
    bot.chat(reply.slice(0, 255));
    sendLogs(listenerBotName, `§d[AI] §f${reply.slice(0, 255)}`);
  } catch (err) {
    sendLogs(listenerBotName, `§c[AI Error] ${err?.message || String(err)}`);
  }
}
*/

function normalizeServerSlot(serverKey) {
  const key = String(serverKey || "smp").trim().toLowerCase();
  return key || "smp";
}

function isLoginFastKickReason(reasonText) {
  const text = String(reasonText || "").toLowerCase();
  return text.includes("logging in too fast") || text.includes("login too fast");
}

function getServerReconnectState(serverKey) {
  const key = normalizeServerSlot(serverKey);
  if (!serverReconnectStateByKey.has(key)) {
    serverReconnectStateByKey.set(key, {
      nextAllowedAt: 0,
      inFlight: 0,
      fastKickStreak: 0,
      touchedAt: Date.now(),
    });
  }
  return serverReconnectStateByKey.get(key);
}

function cleanupServerReconnectState(now = Date.now()) {
  for (const [key, state] of serverReconnectStateByKey.entries()) {
    const idle = state.inFlight <= 0 && (state.nextAllowedAt || 0) < now - 60000;
    if (idle) serverReconnectStateByKey.delete(key);
  }
}

function calcBaseLoginGapMs(cfg) {
  const cfgGapMs = Math.max(0, Number(cfg?.loginDelay || 0) * 1000);
  return Math.max(LOGIN_ATTEMPT_GAP_MIN_MS, cfgGapMs) + randInt(300, LOGIN_ATTEMPT_GAP_JITTER_MS);
}

function clearPendingSpawn(name) {
  const timer = pendingSpawnTimersByBot.get(name);
  if (timer) clearTimeout(timer);
  pendingSpawnTimersByBot.delete(name);
}

function scheduleBotSpawn(name, serverKey, delayMs = 0) {
  if (!name) return;
  clearPendingSpawn(name);

  const safeDelayMs = Math.max(0, Math.floor(Number(delayMs) || 0));
  const targetServerKey = normalizeServerSlot(serverKey);

  const timer = setTimeout(() => {
    pendingSpawnTimersByBot.delete(name);
    if (desiredBots.has(name)) spawnBot(name, targetServerKey);
  }, safeDelayMs);

  pendingSpawnTimersByBot.set(name, timer);
}

function getServerLoginWaitMs(serverKey) {
  const state = getServerReconnectState(serverKey);
  const now = Date.now();
  state.touchedAt = now;
  const waitByCooldownMs = Math.max(0, Number(state.nextAllowedAt || 0) - now);
  if (Number(state.inFlight || 0) > 0) {
    const waitByInFlightMs = randInt(LOGIN_INFLIGHT_RETRY_MIN_MS, LOGIN_INFLIGHT_RETRY_MAX_MS);
    return Math.max(waitByCooldownMs, waitByInFlightMs);
  }
  return waitByCooldownMs;
}

function startServerLoginAttempt(serverKey, cfg) {
  const state = getServerReconnectState(serverKey);
  const now = Date.now();
  state.touchedAt = now;
  state.inFlight = Math.max(0, Number(state.inFlight || 0)) + 1;
  const nextGapMs = calcBaseLoginGapMs(cfg);
  state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + nextGapMs);
}

function finishServerLoginAttempt(serverKey, { cfg, success = false, fastKick = false } = {}) {
  const state = getServerReconnectState(serverKey);
  const now = Date.now();
  state.touchedAt = now;
  state.inFlight = Math.max(0, Number(state.inFlight || 0) - 1);

  if (success) {
    state.fastKickStreak = 0;
    state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + calcBaseLoginGapMs(cfg));
    cleanupServerReconnectState(now);
    return { cooldownMs: 0, streak: 0 };
  }

  if (fastKick) {
    state.fastKickStreak = Math.max(1, Number(state.fastKickStreak || 0) + 1);
    const mult = Math.pow(2, state.fastKickStreak - 1);
    const cooldownBase = Math.min(FAST_LOGIN_COOLDOWN_MAX_MS, FAST_LOGIN_COOLDOWN_BASE_MS * mult);
    const cooldownMs = Math.min(FAST_LOGIN_COOLDOWN_MAX_MS, cooldownBase + randInt(1000, 6000));
    state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + cooldownMs);
    cleanupServerReconnectState(now);
    return {
      cooldownMs: Math.max(0, Number(state.nextAllowedAt || 0) - now),
      streak: state.fastKickStreak,
    };
  }

  state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + calcBaseLoginGapMs(cfg));
  cleanupServerReconnectState(now);
  return {
    cooldownMs: Math.max(0, Number(state.nextAllowedAt || 0) - now),
    streak: Number(state.fastKickStreak || 0),
  };
}

function calcReconnectDelayMs(name, cfg, lastKickReasonText) {
  const minOff = Math.max(0, Number(cfg.minOff) || 0);
  const maxOff = Math.max(minOff, Number(cfg.maxOff) || minOff);
  const baseMs = (randInt(minOff, maxOff) + randInt(0, 8)) * 1000;

  if (isLoginFastKickReason(lastKickReasonText)) {
    return randInt(1500, 3500);
  }
  return baseMs;
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
  const firstCmdJitterMs = randInt(0, 3000);

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
  }, baseDelayMs + firstCmdJitterMs);

  bot._panelMeta.autoCmdTimers.push(t0);
}

function spawnBot(name, serverKey) {
  if (!name) return;
  clearPendingSpawn(name);
  if (activeBots[name]) return;
  if (!desiredBots.has(name)) return;

  const targetServerKey = normalizeServerSlot(serverKey || botServerMap[name] || "smp");
  const loginWaitMs = getServerLoginWaitMs(targetServerKey);
  if (loginWaitMs > 0) {
    const retryInMs = loginWaitMs + randInt(300, 1200);
    scheduleBotSpawn(name, targetServerKey, retryInMs);
    return;
  }
  startServerLoginAttempt(targetServerKey, CFG);

  let loginPhaseDone = false;
  let wasFastLoginKick = false;
  let loginFinishMeta = { cooldownMs: 0, streak: 0 };
  function markLoginPhaseDone({ success = false, fastKick = false } = {}) {
    if (loginPhaseDone) return loginFinishMeta;
    loginPhaseDone = true;
    loginFinishMeta = finishServerLoginAttempt(targetServerKey, { cfg: CFG, success, fastKick });
    return loginFinishMeta;
  }

  const mcVersion = normalizeMcVersion(CFG.mcVersion);

  const botOpts = {
    host: CFG.ip,
    port: parseInt(CFG.port),
    username: name,
    auth: "offline",
  };
  if (mcVersion) botOpts.version = mcVersion;

  sendLogs(name, `§aĐang kết nối đến ${CFG.ip}:${CFG.port}...`);

  // Store bot-server mapping
  botServerMap[name] = targetServerKey;

  const bot = mineflayer.createBot(botOpts);
  bot._panelMeta = { autoCmdTimers: [], autoCmdRunning: false };

  let quitTimer = null;
  let lastKickReasonText = "";

  bot.once("spawn", () => {
    markLoginPhaseDone({ success: true });
    lastKickReasonText = "";
    activeBots[name] = bot;
    emitBotStatus();
    sendLogs(name, `§a✔ Đã vào server! §8(Ver: ${mcVersion || "AUTO"})`);
    runAutoCmdOncePerSpawn(bot, name, CFG);

    const timeOnSec = randInt(CFG.minOn, CFG.maxOn);
    const jitterOnSec = randInt(0, 12);
    const timeOnMs = (timeOnSec + jitterOnSec) * 1000;
    quitTimer = setTimeout(() => {
      if (activeBots[name]) {
        try { bot.quit(); } catch {}
      }
    }, timeOnMs);
  });

  // Chỉ dùng messagestr để tránh 1 tin hiện 2 lần (message + messagestr cùng fire cho 1 chat)
  bot.on("messagestr", (message, position, jsonMsg, packetSender) => {
    try {
      if (position && String(position) !== "chat") return;
      const msgStr = String(message ?? "");
      const player = extractPlayerNameFromMessage(msgStr, jsonMsg, packetSender);
      sendLogs(name, msgStr, player);
    } catch {}
  });

  bot.on("kicked", (reason) => {
    let text = "";
    try {
      text = reason?.value?.text?.value ?? reason?.text ?? (typeof reason === "string" ? reason : JSON.stringify(reason));
    } catch {
      text = String(reason);
    }
    lastKickReasonText = text;
    sendLogs(name, `§cBị kick: ${text}`);
    broadcast("notify-kick", { botName: name, reason: text });
    wasFastLoginKick = isLoginFastKickReason(text);
  });

  bot.on("error", (err) => {
    markLoginPhaseDone({ success: false, fastKick: false });
    sendLogs(name, `§cLỗi: ${err?.message || String(err)}`);
  });

  bot.on("end", () => {
    const loginMeta = markLoginPhaseDone({ success: false, fastKick: wasFastLoginKick });
    stopAutoCmdTimers(bot);
    if (quitTimer) clearTimeout(quitTimer);
    const savedServerKey = botServerMap[name];
    delete activeBots[name];
    delete botServerMap[name];
    emitBotStatus();

    if (isQuitting) return;

    if (desiredBots.has(name)) {
      const timeOffMs = calcReconnectDelayMs(name, CFG, lastKickReasonText);
      const enforcedCooldownMs = Math.max(0, Number(loginMeta?.cooldownMs || 0));
      const nextWaitMs = Math.max(timeOffMs, enforcedCooldownMs);
      if (wasFastLoginKick && enforcedCooldownMs > 0) {
        sendLogs(name, `[AntiKick] wait ${Math.round(enforcedCooldownMs / 1000)}s (streak ${Number(loginMeta?.streak || 1)}).`);
      }
      sendLogs(name, `§7Nghỉ ${Math.round(nextWaitMs / 1000)}s...`);

      scheduleBotSpawn(name, savedServerKey || "smp", nextWaitMs);
    } else {
      sendLogs(name, "§7Đã dừng (không còn được tick).");
    }
  });
}

// API Routes
app.get("/api/config", (req, res) => {
  loadCfg();
  res.json(CFG);
});

app.get("/api/export-config", (req, res) => {
  try {
    if (!fs.existsSync(yamlPath)) return res.status(404).send("Chưa có config");
    const content = fs.readFileSync(yamlPath, "utf8");
    res.setHeader("Content-Type", "application/x-yaml");
    res.setHeader("Content-Disposition", "attachment; filename=data.yml");
    res.send(content);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Lỗi export" });
  }
});

app.post("/api/import-config", (req, res) => {
  try {
    const content = req.body?.content ?? req.body;
    const yamlContent = typeof content === "string" ? content : (content && content.yaml ? content.yaml : "");
    if (!yamlContent.trim()) return res.json({ ok: false, error: "Nội dung trống" });
    const parsed = yaml.load(yamlContent);
    if (!parsed || typeof parsed !== "object") return res.json({ ok: false, error: "YAML không hợp lệ" });
    applyIncomingConfig(parsed);
    saveCfg();
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/config", (req, res) => {
  const newCfg = req.body;
  applyIncomingConfig(newCfg);

  saveCfg();
  res.json({ success: true });
});

// Gọi nội bộ: chạy tất cả bot theo CFG hiện tại (dùng cho API run-all và tự chạy khi restart)
// botCmdMapFromApi: nếu truyền (từ web) thì dùng, không thì build từ CFG
function runAllBots(botCmdMapFromApi) {
  const selected = [...CFG.servers.smp.selectedBots, ...CFG.servers.sky.selectedBots];
  if (selected.length === 0) return;

  if (botCmdMapFromApi && typeof botCmdMapFromApi === "object") {
    runtimeBotCmdMap = botCmdMapFromApi;
  } else {
    runtimeBotCmdMap = {};
    CFG.servers.smp.selectedBots.forEach((name) => {
      runtimeBotCmdMap[name] = [...(CFG.servers.smp.autoCmds || [])];
    });
    CFG.servers.sky.selectedBots.forEach((name) => {
      runtimeBotCmdMap[name] = [...(CFG.servers.sky.autoCmds || [])];
    });
  }

  desiredBots = new Set(selected);
  autoCmdRuntimeEnabled = !!CFG.autoCmdEnabled;

  const loginDelaySec = Math.max(0, parseInt(CFG.loginDelay, 10) || 0);
  const preConnectDelaySec = Math.max(0, Number(CFG.preConnectDelay) || 0);
  const MIN_LOGIN_DELAY_MS = LOGIN_ATTEMPT_GAP_MIN_MS;
  const loginDelayMs = Math.max(MIN_LOGIN_DELAY_MS, loginDelaySec * 1000);
  const MIN_FIRST_CONNECT_MS = 5000;
  const preDelayMs = Math.max(MIN_FIRST_CONNECT_MS, preConnectDelaySec * 1000);

  CFG.servers.smp.selectedBots.forEach((name, i) => {
    botServerMap[name] = "smp";
    sendLogs(name, `§a⏳ Đang khởi động bot SMP...`);
    scheduleBotSpawn(name, "smp", preDelayMs + i * loginDelayMs);
  });
  const smpCount = CFG.servers.smp.selectedBots.length;
  CFG.servers.sky.selectedBots.forEach((name, i) => {
    botServerMap[name] = "sky";
    sendLogs(name, `§a⏳ Đang khởi động bot Skyblock...`);
    scheduleBotSpawn(name, "sky", preDelayMs + (smpCount + i) * loginDelayMs);
  });

  emitBotStatus();
  console.log(`[Auto] Đã lên lịch chạy ${selected.length} bot (autoStartOnBoot).`);
}

app.post("/api/run-all", (req, res) => {
  const { cfg, botCmdMap } = req.body || {};
  
  // Update servers from cfg
  if (cfg && cfg.servers) {
    if (cfg.servers.smp) {
      CFG.servers.smp.accounts = cfg.servers.smp.accounts || CFG.servers.smp.accounts;
      CFG.servers.smp.selectedBots = cfg.servers.smp.selectedBots || [];
      CFG.servers.smp.autoCmds = cfg.servers.smp.autoCmds || CFG.servers.smp.autoCmds;
    }
    if (cfg.servers.sky) {
      CFG.servers.sky.accounts = cfg.servers.sky.accounts || CFG.servers.sky.accounts;
      CFG.servers.sky.selectedBots = cfg.servers.sky.selectedBots || [];
      CFG.servers.sky.autoCmds = cfg.servers.sky.autoCmds || CFG.servers.sky.autoCmds;
    }
  }
  
  // Update other settings
  if (cfg) {
    CFG.ip = cfg.ip || CFG.ip;
    CFG.port = cfg.port || CFG.port;
    CFG.mcVersion = cfg.mcVersion !== undefined ? cfg.mcVersion : CFG.mcVersion;
    CFG.autoCmdEnabled = cfg.autoCmdEnabled !== undefined ? cfg.autoCmdEnabled : CFG.autoCmdEnabled;
    CFG.minOn = cfg.minOn !== undefined ? cfg.minOn : CFG.minOn;
    CFG.maxOn = cfg.maxOn !== undefined ? cfg.maxOn : CFG.maxOn;
    CFG.minOff = cfg.minOff !== undefined ? cfg.minOff : CFG.minOff;
    CFG.maxOff = cfg.maxOff !== undefined ? cfg.maxOff : CFG.maxOff;
    CFG.autoCmdDelay = cfg.autoCmdDelay !== undefined ? cfg.autoCmdDelay : CFG.autoCmdDelay;
    CFG.firstCmdDelay = cfg.firstCmdDelay !== undefined ? cfg.firstCmdDelay : CFG.firstCmdDelay;
  }
  
  runAllBots(botCmdMap);
  const selected = [...CFG.servers.smp.selectedBots, ...CFG.servers.sky.selectedBots];
  res.json({ success: true, count: selected.length });
});

app.post("/api/run-server", (req, res) => {
  const { serverKey, cfg, botCmdMap } = req.body || {};
  if (!serverKey || !CFG.servers[serverKey]) {
    return res.json({ success: false, error: "Invalid server" });
  }
  
  // Update servers from cfg
  if (cfg && cfg.servers) {
    if (cfg.servers[serverKey]) {
      CFG.servers[serverKey].accounts = cfg.servers[serverKey].accounts || CFG.servers[serverKey].accounts;
      CFG.servers[serverKey].selectedBots = cfg.servers[serverKey].selectedBots || [];
      CFG.servers[serverKey].autoCmds = cfg.servers[serverKey].autoCmds || CFG.servers[serverKey].autoCmds;
    }
  }
  
  // Update other settings
  if (cfg) {
    CFG.ip = cfg.ip || CFG.ip;
    CFG.port = cfg.port || CFG.port;
    CFG.mcVersion = cfg.mcVersion !== undefined ? cfg.mcVersion : CFG.mcVersion;
    CFG.autoCmdEnabled = cfg.autoCmdEnabled !== undefined ? cfg.autoCmdEnabled : CFG.autoCmdEnabled;
    CFG.minOn = cfg.minOn !== undefined ? cfg.minOn : CFG.minOn;
    CFG.maxOn = cfg.maxOn !== undefined ? cfg.maxOn : CFG.maxOn;
    CFG.minOff = cfg.minOff !== undefined ? cfg.minOff : CFG.minOff;
    CFG.maxOff = cfg.maxOff !== undefined ? cfg.maxOff : CFG.maxOff;
    CFG.autoCmdDelay = cfg.autoCmdDelay !== undefined ? cfg.autoCmdDelay : CFG.autoCmdDelay;
    CFG.firstCmdDelay = cfg.firstCmdDelay !== undefined ? cfg.firstCmdDelay : CFG.firstCmdDelay;
  }
  
  runtimeBotCmdMap = botCmdMap || {};

  const selected = [...CFG.servers[serverKey].selectedBots];
  const loginDelaySec = Math.max(0, parseInt(cfg?.loginDelay, 10) || 0);
  const preConnectDelaySec = Math.max(0, Number(cfg?.preConnectDelay) || 0);
  const MIN_LOGIN_DELAY_MS = LOGIN_ATTEMPT_GAP_MIN_MS;
  const loginDelayMs = Math.max(MIN_LOGIN_DELAY_MS, loginDelaySec * 1000);
  const MIN_FIRST_CONNECT_MS = 5000;
  const preDelayMs = Math.max(MIN_FIRST_CONNECT_MS, preConnectDelaySec * 1000);

  selected.forEach((name, i) => {
    desiredBots.add(name);
    botServerMap[name] = serverKey;
    sendLogs(name, `§a⏳ Đang khởi động bot ${serverKey.toUpperCase()}...`);
    scheduleBotSpawn(name, serverKey, preDelayMs + i * loginDelayMs);
  });

  emitBotStatus();
  res.json({ success: true, count: selected.length });
});

app.post("/api/stop-all", (req, res) => {
  desiredBots.clear();
  for (const name of [...pendingSpawnTimersByBot.keys()]) {
    clearPendingSpawn(name);
  }
  serverReconnectStateByKey.clear();
  Object.values(activeBots).forEach((bot) => {
    stopAutoCmdTimers(bot);
    try { bot.quit(); } catch {}
  });
  activeBots = {};
  emitBotStatus();
  sendLogs("SYSTEM", "§cĐã dừng tất cả bot");
  res.json({ success: true });
});

app.post("/api/stop-selected", (req, res) => {
  const { names } = req.body || {};
  if (Array.isArray(names)) {
    names.forEach(name => {
      desiredBots.delete(name);
      clearPendingSpawn(name);
      const b = activeBots[name];
      if (b) {
        stopAutoCmdTimers(b);
        try { b.quit(); } catch {}
      }
    });
    emitBotStatus();
  }
  sendLogs("SYSTEM", "§cĐã dừng bot đã chọn");
  res.json({ success: true });
});

app.post("/api/bot/chat", (req, res) => {
  const { message, names } = req.body || {};
  const text = String(message ?? "").trim();
  if (!text) return res.json({ success: false, error: "Thiếu message" });
  const list = Array.isArray(names) && names.length > 0 ? names : Object.keys(activeBots);
  list.forEach((n) => {
    const b = activeBots[n];
    if (b) {
      try { b.chat(text); sendLogs(n, `§8[Send] §7${text}`); } catch (e) { sendLogs("SYSTEM", `§c[SendError] ${n}: ${e?.message || e}`); }
    } else {
      sendLogs("SYSTEM", `§8[Send] §7${n} đang OFFLINE.`);
    }
  });
  res.json({ success: true });
});

app.post("/api/toggle-autocmd", (req, res) => {
  const { enabled } = req.body || {};
  autoCmdRuntimeEnabled = !!enabled;
  res.json({ success: true });
});

// Load initial config
loadCfg();

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  const base = BASE_PATH ? ` (base path: ${BASE_PATH})` : "";
  console.log(`🚀 Server running at http://${HOST}:${PORT}${base}`);
  // Tự chạy bot khi restart (Docker / server khởi động lại) nếu bật autoStartOnBoot và có bot được tick
  if (CFG.autoStartOnBoot) {
    const hasBots = (CFG.servers.smp.selectedBots && CFG.servers.smp.selectedBots.length) ||
      (CFG.servers.sky.selectedBots && CFG.servers.sky.selectedBots.length);
    if (hasBots) setTimeout(runAllBots, 5000);
  }
});
