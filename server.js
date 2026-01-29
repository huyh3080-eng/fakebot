const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const mineflayer = require("mineflayer");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// Serve only specific static files (logo, etc.)
app.get("/logo.png", (req, res) => {
  res.sendFile(path.join(__dirname, "logo.png"));
});

// Serve web.html as the default route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "web.html"));
});

// Data file path
const yamlPath = path.join(__dirname, "data.yml");

// Global state
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
};

let activeBots = {};
let desiredBots = new Set();
let autoCmdRuntimeEnabled = true;
let runtimeBotCmdMap = {};
let isQuitting = false;

// Bot to server mapping
let botServerMap = {};

// WebSocket clients
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
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

function sendLogs(user, msg, player = "") {
  const server = botServerMap?.[user] || "";
  broadcast("log", { user, msg, server, player });
}

function loadCfg() {
  try {
    if (fs.existsSync(yamlPath)) {
      const raw = yaml.load(fs.readFileSync(yamlPath, "utf8")) || {};
      
      // Load servers structure from file
      if (raw.servers && (raw.servers.smp || raw.servers.sky)) {
        CFG.servers = {
          smp: {
            accounts: raw.servers.smp?.accounts || [],
            selectedBots: raw.servers.smp?.selectedBots || [],
            autoCmds: raw.servers.smp?.autoCmds || []
          },
          sky: {
            accounts: raw.servers.sky?.accounts || [],
            selectedBots: raw.servers.sky?.selectedBots || [],
            autoCmds: raw.servers.sky?.autoCmds || []
          }
        };
      }
      
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
    }
  } catch (e) {
    console.error("loadCfg error:", e);
  }
}

function saveCfg() {
  try {
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

function spawnBot(name, serverKey) {
  if (!name) return;
  if (activeBots[name]) return;
  if (!desiredBots.has(name)) return;

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
  botServerMap[name] = serverKey;

  const bot = mineflayer.createBot(botOpts);
  bot._panelMeta = { autoCmdTimers: [], autoCmdRunning: false };

  let quitTimer = null;

  bot.once("spawn", () => {
    activeBots[name] = bot;
    sendLogs(name, `§a✔ Đã vào server! §8(Ver: ${mcVersion || "AUTO"})`);
    runAutoCmdOncePerSpawn(bot, name, CFG);

    const timeOnMs = randInt(CFG.minOn, CFG.maxOn) * 1000;
    quitTimer = setTimeout(() => {
      if (activeBots[name]) {
        try { bot.quit(); } catch {}
      }
    }, timeOnMs);
  });

  bot.on("messagestr", (message, position, jsonMsg) => {
    try {
      if (position && String(position) !== "chat") return;
      const msgStr = String(message ?? "");
      sendLogs(name, msgStr);
    } catch {}
  });

  bot.on("message", (m) => {
    try {
      sendLogs(name, m.toAnsi());
    } catch {
      try { sendLogs(name, m.toAnsi()); } catch {}
    }
  });

  bot.on("kicked", (reason) => {
    let text = "";
    try {
      text = reason?.value?.text?.value ?? reason?.text ?? (typeof reason === "string" ? reason : JSON.stringify(reason));
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
    delete botServerMap[name];

    if (isQuitting) return;

    if (desiredBots.has(name)) {
      const timeOffMs = randInt(CFG.minOff, CFG.maxOff) * 1000;
      sendLogs(name, `§7Nghỉ ${Math.round(timeOffMs / 1000)}s...`);

      setTimeout(() => {
        if (desiredBots.has(name)) spawnBot(name, botServerMap[name]);
      }, timeOffMs);
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

app.post("/api/config", (req, res) => {
  const newCfg = req.body;
  
  // Update servers structure
  if (newCfg.servers) {
    if (newCfg.servers.smp) {
      CFG.servers.smp.accounts = newCfg.servers.smp.accounts || [];
      CFG.servers.smp.selectedBots = newCfg.servers.smp.selectedBots || [];
      CFG.servers.smp.autoCmds = newCfg.servers.smp.autoCmds || [];
    }
    if (newCfg.servers.sky) {
      CFG.servers.sky.accounts = newCfg.servers.sky.accounts || [];
      CFG.servers.sky.selectedBots = newCfg.servers.sky.selectedBots || [];
      CFG.servers.sky.autoCmds = newCfg.servers.sky.autoCmds || [];
    }
  }
  
  // Update other fields
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
  
  saveCfg();
  res.json({ success: true });
});

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
  
  runtimeBotCmdMap = botCmdMap || {};

  const selected = [...CFG.servers.smp.selectedBots, ...CFG.servers.sky.selectedBots];
  desiredBots = new Set(selected);

  // Mark bots with their server
  CFG.servers.smp.selectedBots.forEach(name => {
    botServerMap[name] = "smp";
    sendLogs(name, `§a⏳ Đang khởi động bot SMP...`);
    setTimeout(() => spawnBot(name, "smp"), randInt(0, 2000));
  });
  
  CFG.servers.sky.selectedBots.forEach(name => {
    botServerMap[name] = "sky";
    sendLogs(name, `§a⏳ Đang khởi động bot Skyblock...`);
    setTimeout(() => spawnBot(name, "sky"), randInt(0, 2000));
  });

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
  selected.forEach(name => {
    desiredBots.add(name);
    botServerMap[name] = serverKey;
    sendLogs(name, `§a⏳ Đang khởi động bot ${serverKey.toUpperCase()}...`);
    setTimeout(() => spawnBot(name, serverKey), randInt(0, 2000));
  });

  res.json({ success: true, count: selected.length });
});

app.post("/api/stop-all", (req, res) => {
  desiredBots.clear();
  Object.values(activeBots).forEach((bot) => {
    try { bot.quit(); } catch {}
  });
  sendLogs("System", "§cĐã dừng tất cả bot");
  res.json({ success: true });
});

app.post("/api/stop-selected", (req, res) => {
  const { names } = req.body || {};
  if (Array.isArray(names)) {
    names.forEach(name => desiredBots.delete(name));
  }
  sendLogs("System", "§cĐã dừng bot đã chọn");
  res.json({ success: true });
});

app.post("/api/bot/chat", (req, res) => {
  const { message } = req.body || {};
  Object.values(activeBots).forEach((bot) => {
    try { bot.chat(message); } catch {}
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
