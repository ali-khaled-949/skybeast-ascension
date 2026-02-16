import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const dbPath = process.env.DB_PATH || path.join(root, "server", "data.json");
const SESSION_COOKIE = "skybeast_session";
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_only_change_me";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const WS_BROADCAST_MS = Math.max(50, Number(process.env.WS_BROADCAST_MS || 90));
const WS_PING_MS = Math.max(10000, Number(process.env.WS_PING_MS || 20000));
const INSTANCE_ID = process.env.INSTANCE_ID || crypto.randomBytes(4).toString("hex");
const SETTINGS_SCHEMA_VERSION = 2;
const DEFAULT_CONTROL_BINDINGS = Object.freeze({
  moveUp: "KeyW",
  moveDown: "KeyS",
  moveLeft: "KeyA",
  moveRight: "KeyD",
  sprint: "ShiftLeft",
  jump: "Space",
  abilityQ: "KeyQ",
  abilityE: "KeyE",
  abilityF: "KeyF",
  attack: "KeyJ",
  respawn: "KeyR",
  minimap: "KeyM"
});
const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  masterVolume: 0,
  musicVolume: 0,
  sfxVolume: 0,
  muteMaster: true,
  muteMusic: true,
  muteSfx: true
});
const DEFAULT_USER_SETTINGS = Object.freeze({
  version: SETTINGS_SCHEMA_VERSION,
  quality: "ultra",
  reduceMotion: false,
  showMiniMap: false,
  advancedHud: true,
  autoSave: true,
  autoPerformance: true,
  highContrast: false,
  colorblindSafe: false,
  textScale: 1,
  audio: DEFAULT_AUDIO_SETTINGS,
  controls: DEFAULT_CONTROL_BINDINGS
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use((req, res, next) => {
  const secure = isSecureRequest(req);
  if (process.env.NODE_ENV === "production" && !secure) {
    const host = req.headers.host || "";
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  if (secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(express.static(root));

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(dbPath, "utf8"));
  } catch {
    return { users: {} };
  }
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function topLeaderboard(db) {
  return Object.values(db.users)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10)
    .map((u) => ({ name: u.name, score: u.score || 0, tier: u.tier || 1 }));
}

function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const json = Buffer.from(b64 + pad, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function toBase64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function signSession(payload) {
  const json = JSON.stringify(payload);
  const body = toBase64Url(json);
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || !payload.email || !payload.exp) return null;
    if (Date.now() >= Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function readSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return verifySession(cookies[SESSION_COOKIE] || "");
}

function setSessionCookie(res, { email, provider }) {
  const now = Date.now();
  const token = signSession({
    email,
    provider: provider || "local",
    iat: now,
    exp: now + SESSION_MAX_AGE_MS
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/"
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

function isGooglePayloadAllowed(payload) {
  if (!payload || !payload.email) return false;
  const iss = String(payload.iss || "");
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") return false;
  if (payload.exp && Date.now() / 1000 >= Number(payload.exp)) return false;
  if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) return false;
  return true;
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toNumber(v, fallback = 0) {
  const num = Number(v);
  return Number.isFinite(num) ? num : fallback;
}

function cloneDefaultSettings() {
  return {
    version: SETTINGS_SCHEMA_VERSION,
    quality: DEFAULT_USER_SETTINGS.quality,
    reduceMotion: DEFAULT_USER_SETTINGS.reduceMotion,
    showMiniMap: DEFAULT_USER_SETTINGS.showMiniMap,
    advancedHud: DEFAULT_USER_SETTINGS.advancedHud,
    autoSave: DEFAULT_USER_SETTINGS.autoSave,
    autoPerformance: DEFAULT_USER_SETTINGS.autoPerformance,
    highContrast: DEFAULT_USER_SETTINGS.highContrast,
    colorblindSafe: DEFAULT_USER_SETTINGS.colorblindSafe,
    textScale: DEFAULT_USER_SETTINGS.textScale,
    audio: { ...DEFAULT_AUDIO_SETTINGS },
    controls: { ...DEFAULT_CONTROL_BINDINGS }
  };
}

function migrateSettings(input) {
  const src = (input && typeof input === "object") ? { ...input } : {};
  const v = Number(src.version);
  const currentVersion = Number.isFinite(v) ? v : 1;
  const out = { ...src };

  if (currentVersion < 2) {
    if (typeof out.uiScale === "number" && (out.textScale == null)) {
      out.textScale = out.uiScale;
    }
    if (typeof out.colorBlindSafe === "boolean" && (out.colorblindSafe == null)) {
      out.colorblindSafe = out.colorBlindSafe;
    }
    if (out.audio && typeof out.audio === "object") {
      const audio = { ...out.audio };
      if (typeof audio.master === "number" && audio.masterVolume == null) audio.masterVolume = audio.master;
      if (typeof audio.music === "number" && audio.musicVolume == null) audio.musicVolume = audio.music;
      if (typeof audio.sfx === "number" && audio.sfxVolume == null) audio.sfxVolume = audio.sfx;
      out.audio = audio;
    }
  }

  out.version = SETTINGS_SCHEMA_VERSION;
  return out;
}

function sanitizeSettings(input, current = cloneDefaultSettings()) {
  const src = migrateSettings(input);
  const out = cloneDefaultSettings();
  const prev = current && typeof current === "object" ? migrateSettings(current) : cloneDefaultSettings();

  const safeQuality = ["medium", "high", "ultra"].includes(src.quality) ? src.quality : prev.quality;
  out.quality = ["medium", "high", "ultra"].includes(safeQuality) ? safeQuality : "ultra";
  out.reduceMotion = typeof src.reduceMotion === "boolean" ? src.reduceMotion : !!prev.reduceMotion;
  out.showMiniMap = typeof src.showMiniMap === "boolean" ? src.showMiniMap : !!prev.showMiniMap;
  out.advancedHud = typeof src.advancedHud === "boolean" ? src.advancedHud : !!prev.advancedHud;
  out.autoSave = typeof src.autoSave === "boolean" ? src.autoSave : !!prev.autoSave;
  out.autoPerformance = typeof src.autoPerformance === "boolean" ? src.autoPerformance : !!prev.autoPerformance;
  out.highContrast = typeof src.highContrast === "boolean" ? src.highContrast : !!prev.highContrast;
  out.colorblindSafe = typeof src.colorblindSafe === "boolean" ? src.colorblindSafe : !!prev.colorblindSafe;
  const textScale = Number(src.textScale ?? prev.textScale);
  out.textScale = [1, 1.15, 1.3].includes(textScale) ? textScale : 1;

  const audioSrc = src.audio && typeof src.audio === "object" ? src.audio : {};
  const audioPrev = prev.audio && typeof prev.audio === "object" ? prev.audio : {};
  out.audio = {
    masterVolume: clamp(toNumber(audioSrc.masterVolume, toNumber(audioPrev.masterVolume, DEFAULT_AUDIO_SETTINGS.masterVolume)), 0, 1),
    musicVolume: clamp(toNumber(audioSrc.musicVolume, toNumber(audioPrev.musicVolume, DEFAULT_AUDIO_SETTINGS.musicVolume)), 0, 1),
    sfxVolume: clamp(toNumber(audioSrc.sfxVolume, toNumber(audioPrev.sfxVolume, DEFAULT_AUDIO_SETTINGS.sfxVolume)), 0, 1),
    muteMaster: typeof audioSrc.muteMaster === "boolean" ? audioSrc.muteMaster : !!audioPrev.muteMaster,
    muteMusic: typeof audioSrc.muteMusic === "boolean" ? audioSrc.muteMusic : !!audioPrev.muteMusic,
    muteSfx: typeof audioSrc.muteSfx === "boolean" ? audioSrc.muteSfx : !!audioPrev.muteSfx
  };

  const controlsSrc = src.controls && typeof src.controls === "object" ? src.controls : {};
  const controlsPrev = prev.controls && typeof prev.controls === "object" ? prev.controls : {};
  out.controls = { ...DEFAULT_CONTROL_BINDINGS };
  for (const key of Object.keys(DEFAULT_CONTROL_BINDINGS)) {
    const candidate = controlsSrc[key] ?? controlsPrev[key];
    if (typeof candidate === "string" && candidate && candidate.length <= 24) {
      out.controls[key] = candidate;
    }
  }

  return out;
}

function cleanName(value, fallback = "Player") {
  const safe = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 32);
  return safe || fallback;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function ensureUser(db, email, name = "Player") {
  if (!db.users[email]) {
    db.users[email] = {
      name,
      email,
      tier: 1,
      xp: 0,
      xpToNext: 50,
      score: 0,
      subscribed: false,
      foodStats: { tree: 0, floor: 0 },
      quest: { progress: 0, target: 10, rewardXp: 180, rewardScore: 120 },
      settings: cloneDefaultSettings()
    };
  }
  if (!db.users[email].settings || typeof db.users[email].settings !== "object") {
    db.users[email].settings = cloneDefaultSettings();
  } else {
    db.users[email].settings = sanitizeSettings(db.users[email].settings, db.users[email].settings);
  }
  return db.users[email];
}

function safeWsName(value) {
  return cleanName(value, "Guest").slice(0, 24);
}

function safeWsEmail(value) {
  const email = normalizeEmail(value);
  if (!email || !email.includes("@")) return "guest@skybeast.local";
  return email.slice(0, 72);
}

function randomId() {
  return crypto.randomBytes(6).toString("hex");
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "skybeast",
    instanceId: INSTANCE_ID,
    uptimeSec: Math.floor(process.uptime()),
    playersOnline: players.size
  });
});

app.post("/api/signup", (req, res) => {
  const { name, email } = req.body || {};
  const safeName = cleanName(name, "Player");
  const safeEmail = normalizeEmail(email);
  if (!safeEmail || !safeEmail.includes("@")) return res.status(400).json({ ok: false });
  const db = loadDb();
  const user = ensureUser(db, safeEmail, safeName);
  user.name = safeName;
  user.authProvider = "local";
  saveDb(db);
  if (process.env.NODE_ENV === "production" && !isSecureRequest(req)) {
    return res.status(400).json({ ok: false, error: "https_required" });
  }
  setSessionCookie(res, { email: user.email, provider: "local" });
  res.json({ ok: true, user });
});

app.post("/api/google-login", (req, res) => {
  const { credential } = req.body || {};
  const payload = decodeJwtPayload(credential);
  if (!isGooglePayloadAllowed(payload)) {
    return res.status(400).json({ ok: false, error: "invalid_credential" });
  }
  const safeEmail = normalizeEmail(payload.email);
  if (!safeEmail) return res.status(400).json({ ok: false, error: "invalid_email" });
  const db = loadDb();
  const user = ensureUser(db, safeEmail, cleanName(payload.name, "Google Player"));
  user.name = cleanName(payload.name || user.name, "Google Player");
  user.avatar = payload.picture || user.avatar || "";
  user.authProvider = "google";
  saveDb(db);
  if (process.env.NODE_ENV === "production" && !isSecureRequest(req)) {
    return res.status(400).json({ ok: false, error: "https_required" });
  }
  setSessionCookie(res, { email: user.email, provider: "google" });
  res.json({ ok: true, user, leaderboard: topLeaderboard(db) });
});

app.get("/api/auth-config", (_req, res) => {
  res.json({
    ok: true,
    googleClientId: GOOGLE_CLIENT_ID || ""
  });
});

app.get("/api/session", (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ ok: false });
  const db = loadDb();
  const user = db.users[session.email];
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ ok: false });
  }
  res.json({
    ok: true,
    user: {
      name: user.name,
      email: user.email,
      authProvider: user.authProvider || session.provider || "local"
    }
  });
});

app.post("/api/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/save-progress", (req, res) => {
  const {
    name,
    tier,
    xp,
    xpToNext,
    score,
    subscribed,
    foodStats,
    quest,
    settings
  } = req.body || {};
  const session = readSession(req);
  if (!session?.email) return res.status(401).json({ ok: false });
  const effectiveEmail = normalizeEmail(session.email);
  if (!effectiveEmail) return res.status(400).json({ ok: false });
  const db = loadDb();
  const user = ensureUser(db, effectiveEmail, cleanName(name, "Player"));
  user.name = cleanName(name || user.name, "Player");
  user.authProvider = user.authProvider || session?.provider || "local";

  const incomingTier = clamp(Math.floor(toNumber(tier, 1)), 1, 30);
  const incomingXpToNext = Math.max(50, Math.floor(toNumber(xpToNext, 50)));
  const incomingXp = clamp(toNumber(xp, 0), 0, incomingXpToNext);
  const incomingScore = Math.max(0, Math.floor(toNumber(score, 0)));

  const currentTier = clamp(Math.floor(toNumber(user.tier, 1)), 1, 30);
  const currentXp = Math.max(0, toNumber(user.xp, 0));
  const currentXpToNext = Math.max(50, Math.floor(toNumber(user.xpToNext, 50)));
  const currentScore = Math.max(0, Math.floor(toNumber(user.score, 0)));

  if (incomingTier > currentTier) {
    user.tier = incomingTier;
    user.xp = incomingXp;
    user.xpToNext = incomingXpToNext;
  } else if (incomingTier === currentTier) {
    user.tier = currentTier;
    user.xp = Math.max(currentXp, incomingXp);
    user.xpToNext = Math.max(currentXpToNext, incomingXpToNext);
  } else {
    user.tier = currentTier;
    user.xp = currentXp;
    user.xpToNext = currentXpToNext;
  }

  user.score = Math.max(currentScore, incomingScore);
  user.subscribed = !!subscribed;
  if (foodStats && typeof foodStats === "object") {
    user.foodStats = {
      tree: Math.max(user.foodStats?.tree || 0, Math.max(0, Math.floor(toNumber(foodStats.tree, 0)))),
      floor: Math.max(user.foodStats?.floor || 0, Math.max(0, Math.floor(toNumber(foodStats.floor, 0))))
    };
  }
  if (quest && typeof quest === "object") {
    user.quest = {
      progress: Math.max(0, Math.floor(toNumber(quest.progress, 0))),
      target: Math.max(user.quest?.target || 10, Math.max(10, Math.floor(toNumber(quest.target, 10)))),
      rewardXp: Math.max(user.quest?.rewardXp || 180, Math.max(60, Math.floor(toNumber(quest.rewardXp, 180)))),
      rewardScore: Math.max(user.quest?.rewardScore || 120, Math.max(40, Math.floor(toNumber(quest.rewardScore, 120))))
    };
  }
  user.settings = sanitizeSettings(settings, user.settings || cloneDefaultSettings());
  saveDb(db);
  res.json({ ok: true, leaderboard: topLeaderboard(db) });
});

app.get("/api/progress", (req, res) => {
  const session = readSession(req);
  if (!session?.email) return res.status(401).json({ ok: false });
  const email = normalizeEmail(session.email);
  const db = loadDb();
  const progress = db.users[email]
    ? {
        ...db.users[email],
        settings: sanitizeSettings(db.users[email].settings, db.users[email].settings || cloneDefaultSettings())
      }
    : null;
  res.json({
    ok: true,
    progress,
    leaderboard: topLeaderboard(db)
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const players = new Map();

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on("connection", (ws, req) => {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/ws", `http://${host}`);
  const id = randomId();
  const name = safeWsName(url.searchParams.get("name"));
  const email = safeWsEmail(url.searchParams.get("email"));
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  players.set(id, { id, name, email, x: 180, y: 200, tier: 1, score: 0 });
  ws.playerId = id;
  ws.send(JSON.stringify({ type: "welcome", id }));
  broadcast({ type: "presence", count: players.size });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "state") {
      const p = players.get(id);
      if (!p) return;
      p.x = Number(msg.x) || p.x;
      p.y = Number(msg.y) || p.y;
      p.tier = Number(msg.tier) || p.tier;
      p.score = Math.max(0, Math.floor(Number(msg.score) || p.score || 0));
      p.name = msg.name || p.name;
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ type: "presence", count: players.size });
  });
});

setInterval(() => {
  const snapshot = {};
  for (const [id, p] of players.entries()) {
    snapshot[id] = p;
  }
  broadcast({ type: "state", players: snapshot });
}, WS_BROADCAST_MS);

const wsHeartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, WS_PING_MS);

wss.on("close", () => {
  clearInterval(wsHeartbeat);
});

const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`SkyBeast server running on http://${HOST}:${PORT}`);
});
