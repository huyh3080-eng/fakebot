const { ipcRenderer } = require("electron");
const AnsiToHtml = require("ansi-to-html");
const ansi = new AnsiToHtml({ newline: true, escapeXML: true });

let CFG = {
  ip: "localhost",
  port: 25565,
  mcVersion: "",

  autoCmdEnabled: true,

  preConnectDelay: 0,

  loginDelay: 1,
  minOn: 30,
  maxOn: 60,
  minOff: 10,
  maxOff: 20,

  // legacy
  cmdDelay: 1,
  // new
  autoCmdDelay: 1,

  firstCmdDelay: 1.5,
  reconnectDelay: 5000,

  servers: {
    smp: { accounts: [], selectedBots: [], autoCmds: [] },
    sky: { accounts: [], selectedBots: [], autoCmds: [] },
  },

  accounts: [],
  selectedBots: [],
  autoCmds: [],

  autoStartOnBoot: true,
};

let UI_SMP = new Set();
let UI_SKY = new Set();

const chatHistory = { smp: [], sky: [] };
const historyIndex = { smp: -1, sky: -1 };

const CONSOLE_KEYS = ["smp", "sky"];
const consolePinned = { smp: true, sky: true };

const RECENT_LOGS = new Map();
const DEDUPE_WINDOW_MS = 2500;
function shouldDedupe(key) {
  const now = Date.now();
  const last = RECENT_LOGS.get(key);
  RECENT_LOGS.set(key, now);
  if (RECENT_LOGS.size > 1500) {
    const cutoff = now - 3000;
    for (const [k, t] of RECENT_LOGS) if (t < cutoff) RECENT_LOGS.delete(k);
  }
  return last && now - last <= DEDUPE_WINDOW_MS;
}

function nowHHMMSS() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function setAutoCmdBtn(enabled) {
  const btn = document.getElementById("btnToggleAutoCmd");
  if (!btn) return;
  if (enabled) {
    btn.classList.remove("toggleOff");
    btn.classList.add("toggleOn");
    btn.textContent = "AutoCmd: BẬT";
  } else {
    btn.classList.remove("toggleOn");
    btn.classList.add("toggleOff");
    btn.textContent = "AutoCmd: TẮT";
  }
}

function setAutoStartOnBootBtn(enabled) {
  const btn = document.getElementById("btnToggleAutoStartOnBoot");
  if (!btn) return;
  if (enabled) {
    btn.classList.remove("toggleOff");
    btn.classList.add("toggleOn");
    btn.textContent = "BẬT";
  } else {
    btn.classList.remove("toggleOn");
    btn.classList.add("toggleOff");
    btn.textContent = "TẮT";
  }
}

function normalizeMcVersion(v) {
  const s = String(v ?? "").trim();
  if (!s || s.toLowerCase() === "auto") return "";
  return s;
}

// ===== DOM helpers =====
function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = String(v ?? "");
}
function getVal(id) {
  return document.getElementById(id)?.value ?? "";
}
function numOr(oldVal, raw, opts = {}) {
  const { int = true, min = null, allowZero = true } = opts;
  const text = String(raw ?? "").trim().replace(",", ".");
  let n = int ? parseInt(text, 10) : Number(text);
  if (!Number.isFinite(n)) return oldVal;
  if (!allowZero && n === 0) return oldVal;
  if (min !== null && n < min) n = min;
  return n;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/* Minecraft § -> ANSI */
function mcToAnsi(input) {
  const s = String(input ?? "");
  const map = {
    "§0": "\x1b[30m","§1": "\x1b[34m","§2": "\x1b[32m","§3": "\x1b[36m",
    "§4": "\x1b[31m","§5": "\x1b[35m","§6": "\x1b[33m","§7": "\x1b[37m",
    "§8": "\x1b[90m","§9": "\x1b[94m","§a": "\x1b[92m","§b": "\x1b[96m",
    "§c": "\x1b[91m","§d": "\x1b[95m","§e": "\x1b[93m","§f": "\x1b[97m",
    "§l": "\x1b[1m","§n": "\x1b[4m","§o": "\x1b[3m","§m": "\x1b[9m",
    "§r": "\x1b[0m",
  };
  return s.replace(/§[0-9a-fklmnor]/gi, (m) => map[m.toLowerCase()] || m);
}
function formatConsoleHtml(rawMsg) {
  return ansi.toHtml(mcToAnsi(rawMsg));
}

function getConsoleBox(serverKey) {
  return document.getElementById(serverKey === "sky" ? "logBoxSky" : "logBoxSmp");
}

function getConsoleBoxesForLog(serverKey) {
  const key = String(serverKey || "").toLowerCase();
  if (key === "smp" || key === "sky") return [getConsoleBox(key)].filter(Boolean);
  return CONSOLE_KEYS.map(getConsoleBox).filter(Boolean);
}

function bindConsoleScrollState() {
  CONSOLE_KEYS.forEach((serverKey) => {
    const box = getConsoleBox(serverKey);
    if (!box || box.dataset.scrollBound === "1") return;
    box.dataset.scrollBound = "1";
    box.addEventListener("scroll", () => {
      const threshold = 40;
      const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
      consolePinned[serverKey] = dist <= threshold;
    });
  });
}

// Minecraft Java: tên 3–16 ký tự, tránh nhầm nội dung chat (vd: "a") thành tên
function isMcUsername(name) {
  const s = String(name || "").trim();
  return s.length >= 3 && s.length <= 16 && /^[A-Za-z0-9_]+$/.test(s);
}

// Bỏ suffix "world/nether/end" nếu bị dính
function normalizePlayerName(player, msg) {
  let p = String(player || "").trim();
  if (!p) return "";

  const rawMsg = String(msg || "");

  // nếu player dính suffix (vd Thanh_Phongworld) thì cắt ra Thanh_Phong
  const suffixes = ["world", "nether", "end"];
  for (const suf of suffixes) {
    if (p.toLowerCase().endsWith(suf) && p.length > suf.length) {
      const base = p.slice(0, -suf.length);
      if (isMcUsername(base) && rawMsg.includes(base)) {
        p = base;
        break;
      }
    }
  }

  // Nếu vẫn không hợp lệ thì bỏ
  if (!isMcUsername(p)) return "";
  return p;
}

// fallback parse từ text (chỉ nhận tên 3–16 ký tự)
function extractPlayerNameFromChat(rawMsg) {
  const s = String(rawMsg ?? "");
  const namePart = "[A-Za-z0-9_]{3,16}";

  let m = s.match(/<\s*([^>]{3,32})\s*>/);
  if (m && m[1]) {
    const n = m[1].trim();
    if (isMcUsername(n)) return n;
  }

  m = s.match(new RegExp(`\\]\\s*(${namePart})\\s*:\\s+`));
  if (m && m[1] && isMcUsername(m[1])) return m[1].trim();

  m = s.match(new RegExp(`^(${namePart})\\s*(?:»|:)\\s+`));
  if (m && m[1] && isMcUsername(m[1])) return m[1].trim();

  return "";
}

// ===== migrate / ensure =====
function ensureServers() {
  if (!CFG.servers || typeof CFG.servers !== "object") {
    CFG.servers = {
      smp: { accounts: [], selectedBots: [], autoCmds: [] },
      sky: { accounts: [], selectedBots: [], autoCmds: [] },
    };
  }
  if (!CFG.servers.smp) CFG.servers.smp = { accounts: [], selectedBots: [], autoCmds: [] };
  if (!CFG.servers.sky) CFG.servers.sky = { accounts: [], selectedBots: [], autoCmds: [] };

  CFG.servers.smp.accounts = Array.isArray(CFG.servers.smp.accounts) ? CFG.servers.smp.accounts : [];
  CFG.servers.smp.selectedBots = Array.isArray(CFG.servers.smp.selectedBots) ? CFG.servers.smp.selectedBots : [];
  CFG.servers.smp.autoCmds = Array.isArray(CFG.servers.smp.autoCmds) ? CFG.servers.smp.autoCmds : [];

  CFG.servers.sky.accounts = Array.isArray(CFG.servers.sky.accounts) ? CFG.servers.sky.accounts : [];
  CFG.servers.sky.selectedBots = Array.isArray(CFG.servers.sky.selectedBots) ? CFG.servers.sky.selectedBots : [];
  CFG.servers.sky.autoCmds = Array.isArray(CFG.servers.sky.autoCmds) ? CFG.servers.sky.autoCmds : [];

  const legacyHas = Array.isArray(CFG.accounts) && CFG.accounts.length > 0;
  const serversEmpty = CFG.servers.smp.accounts.length === 0 && CFG.servers.sky.accounts.length === 0;
  if (legacyHas && serversEmpty) {
    CFG.servers.smp.accounts = [...(CFG.accounts || [])];
    CFG.servers.smp.selectedBots = [...(CFG.selectedBots || [])];
    CFG.servers.smp.autoCmds = [...(CFG.autoCmds || [])];
  }
}

function allAccountsSet() {
  const s = new Set();
  CFG.servers.smp.accounts.forEach(x => s.add(x));
  CFG.servers.sky.accounts.forEach(x => s.add(x));
  return s;
}

function syncAutoCmdDelayCompat() {
  const d = Number(CFG.autoCmdDelay ?? CFG.cmdDelay ?? 1);
  const ok = Number.isFinite(d) && d > 0 ? d : 1;
  CFG.autoCmdDelay = ok;
  CFG.cmdDelay = ok;
}

async function loadConfig() {
  const got = await ipcRenderer.invoke("get-config");
  CFG = { ...CFG, ...(got || {}) };

  CFG.autoCmdEnabled = !!CFG.autoCmdEnabled;
  CFG.mcVersion = normalizeMcVersion(CFG.mcVersion);

  CFG.preConnectDelay = Number(CFG.preConnectDelay);
  if (!Number.isFinite(CFG.preConnectDelay) || CFG.preConnectDelay < 0) CFG.preConnectDelay = 0;

  syncAutoCmdDelayCompat();
  ensureServers();

  UI_SMP = new Set(CFG.servers.smp.selectedBots);
  UI_SKY = new Set(CFG.servers.sky.selectedBots);

  setVal("ip", CFG.ip);
  setVal("port", CFG.port);
  setVal("preConnectDelay", CFG.preConnectDelay);
  setVal("loginDelay", CFG.loginDelay);

  setVal("autoCmdDelay", CFG.autoCmdDelay);
  setVal("firstCmdDelay", CFG.firstCmdDelay);

  setVal("minOn", CFG.minOn);
  setVal("maxOn", CFG.maxOn);
  setVal("minOff", CFG.minOff);
  setVal("maxOff", CFG.maxOff);

  const verEl = document.getElementById("mcVersion");
  if (verEl) verEl.value = CFG.mcVersion;

  setAutoCmdBtn(CFG.autoCmdEnabled);
  setAutoStartOnBootBtn(CFG.autoStartOnBoot);

  renderSmpBots();
  renderSkyBots();
  renderSmpCmds();
  renderSkyCmds();

  bindConsoleScrollState();
}

function buildRunPayloadFromUI() {
  CFG.servers.smp.selectedBots = Array.from(UI_SMP);
  CFG.servers.sky.selectedBots = Array.from(UI_SKY);

  const selected = [...CFG.servers.smp.selectedBots, ...CFG.servers.sky.selectedBots];

  const botCmdMap = {};
  CFG.servers.smp.selectedBots.forEach((name) => {
    botCmdMap[name] = [...CFG.servers.smp.autoCmds];
  });
  CFG.servers.sky.selectedBots.forEach((name) => {
    botCmdMap[name] = [...CFG.servers.sky.autoCmds];
  });

  CFG.selectedBots = selected;
  CFG.accounts = Array.from(allAccountsSet());
  CFG.autoCmds = [];

  syncAutoCmdDelayCompat();
  return { cfg: CFG, botCmdMap };
}

function saveConfig() {
  CFG.servers.smp.selectedBots = Array.from(UI_SMP);
  CFG.servers.sky.selectedBots = Array.from(UI_SKY);

  CFG.accounts = Array.from(allAccountsSet());
  CFG.selectedBots = [...CFG.servers.smp.selectedBots, ...CFG.servers.sky.selectedBots];

  syncAutoCmdDelayCompat();
  ipcRenderer.send("save-config", CFG);
}

// ===== CONFIG update =====
function updateCfgFromInputs({ writeBack = true } = {}) {
  CFG.ip = getVal("ip").trim() || CFG.ip;
  CFG.port = numOr(CFG.port, getVal("port"), { int: true, min: 1 });

  CFG.mcVersion = normalizeMcVersion(document.getElementById("mcVersion")?.value);

  CFG.preConnectDelay = numOr(CFG.preConnectDelay, getVal("preConnectDelay"), { int: false, min: 0 });
  if (!Number.isFinite(CFG.preConnectDelay) || CFG.preConnectDelay < 0) CFG.preConnectDelay = 0;

  CFG.loginDelay = numOr(CFG.loginDelay, getVal("loginDelay"), { int: true, min: 0 });

  CFG.autoCmdDelay = numOr(CFG.autoCmdDelay, getVal("autoCmdDelay"), { int: false, min: 0.1 });
  if (!Number.isFinite(CFG.autoCmdDelay) || CFG.autoCmdDelay <= 0) CFG.autoCmdDelay = 1;

  CFG.cmdDelay = CFG.autoCmdDelay;

  CFG.firstCmdDelay = numOr(CFG.firstCmdDelay, getVal("firstCmdDelay"), { int: false, min: 0 });
  if (!Number.isFinite(CFG.firstCmdDelay) || CFG.firstCmdDelay < 0) CFG.firstCmdDelay = 1.5;

  CFG.minOn = numOr(CFG.minOn, getVal("minOn"), { int: true, min: 1 });
  CFG.maxOn = numOr(CFG.maxOn, getVal("maxOn"), { int: true, min: 1 });
  CFG.minOff = numOr(CFG.minOff, getVal("minOff"), { int: true, min: 0 });
  CFG.maxOff = numOr(CFG.maxOff, getVal("maxOff"), { int: true, min: 0 });

  if (CFG.minOn > CFG.maxOn) [CFG.minOn, CFG.maxOn] = [CFG.maxOn, CFG.minOn];
  if (CFG.minOff > CFG.maxOff) [CFG.minOff, CFG.maxOff] = [CFG.maxOff, CFG.minOff];

  if (writeBack) {
    setVal("ip", CFG.ip);
    setVal("port", CFG.port);
    setVal("preConnectDelay", CFG.preConnectDelay);
    setVal("loginDelay", CFG.loginDelay);

    setVal("autoCmdDelay", CFG.autoCmdDelay);
    setVal("firstCmdDelay", CFG.firstCmdDelay);

    setVal("minOn", CFG.minOn);
    setVal("maxOn", CFG.maxOn);
    setVal("minOff", CFG.minOff);
    setVal("maxOff", CFG.maxOff);

    const verEl = document.getElementById("mcVersion");
    if (verEl) verEl.value = CFG.mcVersion;
  }
}

let toastSavedTimer = null;
let toastKickTimer = null;

function showSavedToast(message = "Đã lưu config") {
  const el = document.getElementById("toastSaved");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  if (toastSavedTimer) clearTimeout(toastSavedTimer);
  toastSavedTimer = setTimeout(() => {
    el.classList.remove("show");
    el.textContent = "Đã lưu config";
    toastSavedTimer = null;
  }, 1000);
}

function showKickToast(botName, reason) {
  const el = document.getElementById("toastKick");
  if (!el) return;
  const short = (reason || "").slice(0, 60);
  el.textContent = `Bot ${botName} bị kick: ${short}${short.length >= 60 ? "…" : ""}`;
  el.classList.add("show");
  if (toastKickTimer) clearTimeout(toastKickTimer);
  toastKickTimer = setTimeout(() => {
    el.classList.remove("show");
    toastKickTimer = null;
  }, 4000);
}

function playKickSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 400;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch (_) {}
}

function clearConsole(serverKey = "") {
  getConsoleBoxesForLog(serverKey).forEach((box) => {
    box.innerHTML = "";
  });
}

function exportLog(serverKey = "") {
  const boxes = getConsoleBoxesForLog(serverKey);
  const lines = boxes
    .flatMap((box) => Array.from(box.querySelectorAll(".logLine")))
    .map((el) => el.innerText || el.textContent)
    .filter(Boolean);
  if (!lines.length) return;
  const text = lines.join("\n");
  const blob = new Blob(["\uFEFF" + text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const suffix = serverKey === "smp" || serverKey === "sky" ? `-${serverKey}` : "";
  a.download = `console${suffix}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function showAllOnlineToast(total) {
  const el = document.getElementById("toastAllOnline");
  if (!el) return;
  el.textContent = `Tất cả ${total} bot đã vào server!`;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3000);
}

function applyNormalizeAndWriteBack() {
  updateCfgFromInputs({ writeBack: true });
  saveConfig();
  showSavedToast();
}

function bindRealtimeNormalize() {
  const ids = ["port","preConnectDelay","loginDelay","autoCmdDelay","firstCmdDelay","minOn","maxOn","minOff","maxOff"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("blur", applyNormalizeAndWriteBack);
    el.addEventListener("change", applyNormalizeAndWriteBack);
  });

  const ipEl = document.getElementById("ip");
  if (ipEl) {
    ipEl.addEventListener("blur", applyNormalizeAndWriteBack);
    ipEl.addEventListener("change", applyNormalizeAndWriteBack);
  }

  const mcVersionEl = document.getElementById("mcVersion");
  if (mcVersionEl) {
    mcVersionEl.addEventListener("blur", applyNormalizeAndWriteBack);
    mcVersionEl.addEventListener("change", applyNormalizeAndWriteBack);
  }
}

// ===== BOT LIST RENDER =====
function renderBotList(containerId, accounts, selectedSet, onToggle, onDelete) {
  const list = document.getElementById(containerId);
  if (!list) return;
  list.innerHTML = "";

  accounts.forEach((name) => {
    const row = document.createElement("div");
    row.className = "row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "chk";
    cb.checked = selectedSet.has(name);

    cb.onchange = () => onToggle(name, cb.checked);

    const label = document.createElement("span");
    label.textContent = name;
    label.title = name;

    const del = document.createElement("button");
    del.textContent = "Xóa";
    del.onclick = () => onDelete(name);

    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function renderSmpBots() {
  renderBotList(
    "botListSmp",
    CFG.servers.smp.accounts,
    UI_SMP,
    (name, checked) => {
      if (checked) UI_SMP.add(name);
      else UI_SMP.delete(name);
      saveConfig();
    },
    (name) => {
      CFG.servers.smp.accounts = CFG.servers.smp.accounts.filter((x) => x !== name);
      UI_SMP.delete(name);
      saveConfig();
      renderSmpBots();
    }
  );
}

function renderSkyBots() {
  renderBotList(
    "botListSky",
    CFG.servers.sky.accounts,
    UI_SKY,
    (name, checked) => {
      if (checked) UI_SKY.add(name);
      else UI_SKY.delete(name);
      saveConfig();
    },
    (name) => {
      CFG.servers.sky.accounts = CFG.servers.sky.accounts.filter((x) => x !== name);
      UI_SKY.delete(name);
      saveConfig();
      renderSkyBots();
    }
  );
}

function addBotTo(serverKey) {
  const inputId = serverKey === "smp" ? "botNameSmp" : "botNameSky";
  const input = document.getElementById(inputId);
  const name = (input?.value || "").trim();
  if (!name) return;

  const all = allAccountsSet();
  if (all.has(name)) {
    alert("Tên bot đã tồn tại ở SMP hoặc Skyblock!");
    return;
  }

  CFG.servers[serverKey].accounts.push(name);

  if (serverKey === "smp") UI_SMP.add(name);
  else UI_SKY.add(name);

  if (input) input.value = "";
  saveConfig();
  if (serverKey === "smp") renderSmpBots();
  else renderSkyBots();
}

function selectAll(serverKey) {
  if (serverKey === "smp") UI_SMP = new Set(CFG.servers.smp.accounts);
  else UI_SKY = new Set(CFG.servers.sky.accounts);
  saveConfig();
  if (serverKey === "smp") renderSmpBots();
  else renderSkyBots();
}

function unselectAll(serverKey) {
  if (serverKey === "smp") UI_SMP.clear();
  else UI_SKY.clear();
  saveConfig();
  if (serverKey === "smp") renderSmpBots();
  else renderSkyBots();
}

// ===== CMD LIST =====
function renderCmdList(containerId, cmds, onDeleteAt) {
  const list = document.getElementById(containerId);
  if (!list) return;
  list.innerHTML = "";

  cmds.forEach((cmd, idx) => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.gridTemplateColumns = "1fr 74px";

    const label = document.createElement("span");
    label.textContent = cmd;
    label.title = cmd;

    const del = document.createElement("button");
    del.textContent = "Xóa";
    del.onclick = () => onDeleteAt(idx);

    row.appendChild(label);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function renderSmpCmds() {
  renderCmdList("cmdListSmp", CFG.servers.smp.autoCmds, (idx) => {
    CFG.servers.smp.autoCmds.splice(idx, 1);
    saveConfig();
    renderSmpCmds();
  });
}
function renderSkyCmds() {
  renderCmdList("cmdListSky", CFG.servers.sky.autoCmds, (idx) => {
    CFG.servers.sky.autoCmds.splice(idx, 1);
    saveConfig();
    renderSkyCmds();
  });
}

function addCmdTo(serverKey) {
  const inputId = serverKey === "smp" ? "cmdTextSmp" : "cmdTextSky";
  const input = document.getElementById(inputId);
  const cmd = (input?.value || "").trim();
  if (!cmd) return;

  CFG.servers[serverKey].autoCmds.push(cmd);
  if (input) input.value = "";
  saveConfig();
  if (serverKey === "smp") renderSmpCmds();
  else renderSkyCmds();
}

// ===== RUN/STOP =====
function runAll() {
  updateCfgFromInputs({ writeBack: true });
  const payload = buildRunPayloadFromUI();
  saveConfig();
  ipcRenderer.send("run-all", payload);
}

function runOnly(serverKey) {
  updateCfgFromInputs({ writeBack: true });

  CFG.servers.smp.selectedBots = Array.from(UI_SMP);
  CFG.servers.sky.selectedBots = Array.from(UI_SKY);

  let selected = [];
  let botCmdMap = {};

  if (serverKey === "smp") {
    selected = [...CFG.servers.smp.selectedBots];
    CFG.servers.smp.selectedBots.forEach((name) => (botCmdMap[name] = [...CFG.servers.smp.autoCmds]));
  } else {
    selected = [...CFG.servers.sky.selectedBots];
    CFG.servers.sky.selectedBots.forEach((name) => (botCmdMap[name] = [...CFG.servers.sky.autoCmds]));
  }

  CFG.selectedBots = selected;
  CFG.accounts = Array.from(allAccountsSet());
  CFG.autoCmds = [];

  syncAutoCmdDelayCompat();
  saveConfig();
  ipcRenderer.send("run-server", { serverKey, cfg: CFG, botCmdMap });
}

function stopAll() {
  if (!confirm("Bạn có chắc muốn dừng tất cả bot?")) return;
  ipcRenderer.send("stop-all");
}

function stopOnly(serverKey) {
  ipcRenderer.send("stop-selected", { serverKey });
}

// ===== CHAT =====
function getChatInput(serverKey) {
  return document.getElementById(serverKey === "sky" ? "chatInputSky" : "chatInputSmp");
}

function getSelectedChatNames(serverKey) {
  return serverKey === "sky" ? Array.from(UI_SKY) : Array.from(UI_SMP);
}

function sendChat(serverKey = "smp") {
  const input = getChatInput(serverKey);
  const msg = (input?.value || "").trim();
  if (!msg) return;

  const names = getSelectedChatNames(serverKey);
  ipcRenderer.send("send-global-chat", { names, msg });

  chatHistory[serverKey].push(msg);
  if (chatHistory[serverKey].length > 200) chatHistory[serverKey].shift();
  historyIndex[serverKey] = chatHistory[serverKey].length;

  if (input) input.value = "";
}

function bindChatInput(serverKey) {
  const input = getChatInput(serverKey);
  if (!input || input.dataset.chatBound === "1") return;
  input.dataset.chatBound = "1";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      sendChat(serverKey);
      e.preventDefault();
      return;
    }

    if (e.key === "ArrowUp") {
      if (chatHistory[serverKey].length === 0) return;
      historyIndex[serverKey]--;
      if (historyIndex[serverKey] < 0) historyIndex[serverKey] = 0;
      input.value = chatHistory[serverKey][historyIndex[serverKey]] || "";
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      e.preventDefault();
      return;
    }

    if (e.key === "ArrowDown") {
      if (chatHistory[serverKey].length === 0) return;
      historyIndex[serverKey]++;
      if (historyIndex[serverKey] >= chatHistory[serverKey].length) {
        historyIndex[serverKey] = chatHistory[serverKey].length;
        input.value = "";
      } else {
        input.value = chatHistory[serverKey][historyIndex[serverKey]] || "";
      }
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      e.preventDefault();
    }
  });
}

// ===== CONSOLE =====
const MAX_LINES = 1200;

ipcRenderer.on("log", (e, payload) => {
  const { user, msg, server } = payload || {};
  const botName = String(user || "unknown");
  const boxes = getConsoleBoxesForLog(server);
  if (!boxes.length) return;

  const dedupeKey = `${server || ""}|${botName}|${String(msg ?? "").trim()}`;
  if (shouldDedupe(dedupeKey)) return;

  const time = nowHHMMSS();

  const serverTag =
    server === "smp"
      ? `<span style="color:#60a5fa"><b>[SMP]</b></span>`
      : server === "sky"
      ? `<span style="color:#34d399"><b>[SKY]</b></span>`
      : `<span style="color:#64748b"><b>[?]</b></span>`;

  const botTag = `<span style="color:#a78bfa"><b>[BOT:${escapeHtml(botName)}]</b></span>`;

  const html =
    `<span style="color:#64748b">[${time}]</span> ` +
    `${serverTag} ` +
    `${botTag}` +
    ` <span style="color:#64748b">:</span> ` +
    `${formatConsoleHtml(msg)}`;

  boxes.forEach((box) => {
    const serverKey = box.id === "logBoxSky" ? "sky" : "smp";
    const line = document.createElement("div");
    line.className = "logLine";
    line.innerHTML = html;
    box.appendChild(line);

    while (box.children.length > MAX_LINES) box.removeChild(box.firstChild);
    if (consolePinned[serverKey]) box.scrollTop = box.scrollHeight;
  });
});

ipcRenderer.on("bot-status", (e, { online = 0, total = 0 } = {}) => {
  const el = document.getElementById("botStatusText");
  if (el) el.textContent = `${online}/${total} bot`;
});

ipcRenderer.on("notify-kick", (e, { botName, reason } = {}) => {
  showKickToast(botName || "?", reason);
  playKickSound();
});

ipcRenderer.on("notify-all-online", (e, { total } = {}) => {
  if (total != null) showAllOnlineToast(total);
});

// ===== AutoCmd Toggle bind =====
function bindAutoCmdToggle() {
  const btn = document.getElementById("btnToggleAutoCmd");
  if (!btn) return;

  btn.addEventListener("click", () => {
    CFG.autoCmdEnabled = !CFG.autoCmdEnabled;
    setAutoCmdBtn(CFG.autoCmdEnabled);
    saveConfig();
    ipcRenderer.send("toggle-autocmd", CFG.autoCmdEnabled);
  });
}

// ===== Auto Start On Boot Toggle (Debian/Linux) =====
function bindAutoStartOnBootToggle() {
  const btn = document.getElementById("btnToggleAutoStartOnBoot");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    CFG.autoStartOnBoot = !CFG.autoStartOnBoot;
    setAutoStartOnBootBtn(CFG.autoStartOnBoot);
    saveConfig();
    const result = await ipcRenderer.invoke("toggle-auto-start-on-boot", CFG.autoStartOnBoot);
    if (result?.message) showSavedToast(result.message);
    if (result?.ok === false && result?.message) alert(result.message);
  });
}

function bindVersionDropdown() {
  const verEl = document.getElementById("mcVersion");
  if (!verEl) return;

  verEl.addEventListener("change", () => {
    CFG.mcVersion = normalizeMcVersion(verEl.value);
    saveConfig();
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  await loadConfig();

  document.getElementById("btnAddBotSmp")?.addEventListener("click", () => addBotTo("smp"));
  document.getElementById("btnSelectAllSmp")?.addEventListener("click", () => selectAll("smp"));
  document.getElementById("btnUnselectAllSmp")?.addEventListener("click", () => unselectAll("smp"));
  document.getElementById("btnRunSmp")?.addEventListener("click", () => runOnly("smp"));
  document.getElementById("btnStopSmp")?.addEventListener("click", () => stopOnly("smp"));
  document.getElementById("btnAddCmdSmp")?.addEventListener("click", () => addCmdTo("smp"));

  document.getElementById("btnAddBotSky")?.addEventListener("click", () => addBotTo("sky"));
  document.getElementById("btnSelectAllSky")?.addEventListener("click", () => selectAll("sky"));
  document.getElementById("btnUnselectAllSky")?.addEventListener("click", () => unselectAll("sky"));
  document.getElementById("btnRunSky")?.addEventListener("click", () => runOnly("sky"));
  document.getElementById("btnStopSky")?.addEventListener("click", () => stopOnly("sky"));
  document.getElementById("btnAddCmdSky")?.addEventListener("click", () => addCmdTo("sky"));

  document.getElementById("btnRunAll")?.addEventListener("click", runAll);
  document.getElementById("btnStopAll")?.addEventListener("click", stopAll);
  document.getElementById("btnSendChatSmp")?.addEventListener("click", () => sendChat("smp"));
  document.getElementById("btnSendChatSky")?.addEventListener("click", () => sendChat("sky"));

  document.getElementById("btnOpenDataFolder")?.addEventListener("click", async () => {
    await ipcRenderer.invoke("open-user-data-folder");
  });
  document.getElementById("btnClearConsole")?.addEventListener("click", () => clearConsole());
  document.getElementById("btnExportLog")?.addEventListener("click", () => exportLog());

  document.getElementById("btnExportConfig")?.addEventListener("click", async () => {
    const content = await ipcRenderer.invoke("export-config");
    if (content == null) return;
    const blob = new Blob([content], { type: "application/x-yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `data-${new Date().toISOString().slice(0, 10)}.yml`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const inputImport = document.getElementById("inputImportConfig");
  document.getElementById("btnImportConfig")?.addEventListener("click", () => inputImport?.click());
  inputImport?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsText(file, "utf8");
    });
    const result = await ipcRenderer.invoke("import-config", text);
    if (result?.ok) {
      await loadConfig();
      showSavedToast("Đã khôi phục config");
    } else {
      alert("Khôi phục thất bại: " + (result?.error || "Lỗi không xác định"));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "L") {
      e.preventDefault();
      clearConsole();
    }
  });

  bindAutoCmdToggle();
  bindAutoStartOnBootToggle();
  bindVersionDropdown();
  bindRealtimeNormalize();

  // Tự chạy tất cả bot khi mở panel (sau reboot) nếu bật trên Linux — chạy sau khi config đã load xong
  if (CFG.autoStartOnBoot && process.platform === "linux") {
    const hasBots = UI_SMP.size > 0 || UI_SKY.size > 0;
    if (hasBots) setTimeout(runAll, 2500);
  }

  bindChatInput("smp");
  bindChatInput("sky");

  document.getElementById("botNameSmp")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addBotTo("smp"); });
  document.getElementById("botNameSky")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addBotTo("sky"); });
  document.getElementById("cmdTextSmp")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addCmdTo("smp"); });
  document.getElementById("cmdTextSky")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addCmdTo("sky"); });
});
