// ═══════════════════════════════════════════════════════════════════════
//  ZAPMRO CLOUD v2.0 - Server (Node.js built-ins + optional packages)
//  Works with or without npm packages installed
// ═══════════════════════════════════════════════════════════════════════
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, rmSync, createReadStream, copyFileSync } from 'fs';
import { join, dirname, extname, resolve, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, randomBytes, createHash } from 'crypto';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zapmro-2024-secret';

// ── Optional package imports (graceful degradation) ──────────────────
let express, Server, Client, LocalAuth, qrcode, OpenAI, cron, multer, bcryptjs, jwt, createClient, uuid;
let MessageMedia;
let hasExpress = false, hasSocket = false, hasWA = false, hasOpenAI = false, hasCron = false;

try { 
  const exp = await import('express'); express = exp.default; hasExpress = true;
  console.log('✅ express loaded');
} catch {}

try { 
  const sio = await import('socket.io'); Server = sio.Server; hasSocket = true;
  console.log('✅ socket.io loaded');
} catch {}

try { 
  const wa = await import('whatsapp-web.js'); 
  const waMod = wa.default || wa;
  Client = wa.Client || waMod.Client;
  LocalAuth = waMod.LocalAuth;
  MessageMedia = waMod.MessageMedia;
  hasWA = true; console.log('✅ whatsapp-web.js loaded');
} catch {}

try { 
  const qr = await import('qrcode'); qrcode = qr.default; 
  console.log('✅ qrcode loaded');
} catch {}

try { 
  const oai = await import('openai'); OpenAI = oai.default;
  hasOpenAI = true; console.log('✅ openai loaded');
} catch {}

try { 
  const cn = await import('node-cron'); cron = cn.default;
  hasCron = true; console.log('✅ node-cron loaded');
} catch {}

try { 
  const bc = await import('bcryptjs'); bcryptjs = bc.default;
  console.log('✅ bcryptjs loaded');
} catch { bcryptjs = { hashSync: (p) => simpleHash(p), compareSync: (p,h) => simpleHash(p) === h }; }

try { 
  const j = await import('jsonwebtoken'); jwt = j.default;
  console.log('✅ jsonwebtoken loaded');
} catch { jwt = { sign: (p, s) => btoa(JSON.stringify(p)) + '.' + simpleHash(JSON.stringify(p)+s), verify: (t, s) => { try { return JSON.parse(atob(t.split('.')[0])); } catch { throw new Error('invalid'); } } }; }

try { 
  const sb = await import('@supabase/supabase-js'); createClient = sb.createClient;
  console.log('✅ supabase loaded');
} catch {}

try { 
  const u = await import('uuid'); uuid = u.v4;
  console.log('✅ uuid loaded');
} catch { uuid = () => randomBytes(16).toString('hex'); }

// ── Helpers ───────────────────────────────────────────────────────────
function simpleHash(str) {
  return createHmac('sha256', 'zapmro').update(str).digest('hex');
}

function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

function extractPhoneDigits(text) {
  const d = digitsOnly(text);
  if (d.length >= 10 && d.length <= 15) return d;
  return '';
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function randInt(min, max) {
  const a = Math.floor(Number(min || 0));
  const b = Math.floor(Number(max || 0));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return a;
  return a + Math.floor(Math.random() * (b - a + 1));
}

function aiDefaults() {
  return {
    enabled: false,
    provider: 'openai',
    mode: 'off',
    apiKey: '',
    model: 'gpt-4o-mini',
    prompt: '',
    important: '',
    keywordTrigger: '',
    delayMinMs: 1500,
    delayMaxMs: 3500,
    splitEnabled: true,
    splitMaxParts: 3,
    splitMinChars: 10,
    splitMaxChars: 60,
    partDelayMinMs: 600,
    partDelayMaxMs: 1600,
    allowAudio: true,
    allowImages: true
  };
}

function getAIConfig(sessionId) {
  const cfg = db.load('ai_config', {})[sessionId] || {};
  return { ...aiDefaults(), ...cfg };
}

function getAIStatusKey(sessionId, chatId) {
  return `${sessionId}:${chatId}`;
}

function getAIChatOverride(statuses, sessionId, chatId) {
  const v = statuses[getAIStatusKey(sessionId, chatId)];
  if (v === true || v === false) return v;
  return null;
}

function shouldAIRespond(config, override, msg) {
  if (!config?.enabled) return false;
  const mode = (config.mode || 'off').toString();
  if (override === false) return false;
  if (mode === 'global') return true;
  if (mode === 'per_chat') return override === true;
  if (mode === 'trigger') {
    const kw = (config.keywordTrigger || '').toString().trim();
    if (!kw) return false;
    return String(msg?.body || '').toLowerCase().includes(kw.toLowerCase());
  }
  return false;
}

function isAIArmed(config, override) {
  if (!config?.enabled) return false;
  const mode = (config.mode || 'off').toString();
  if (override === false) return false;
  if (mode === 'global') return true;
  if (mode === 'per_chat') return override === true;
  if (mode === 'trigger') return !!(config.keywordTrigger || '').toString().trim();
  return false;
}

function getAITranscriptStore() {
  return db.load('ai_transcripts', {});
}

function appendAITranscript(sessionId, chatId, role, content) {
  const text = (content ?? '').toString().trim();
  if (!text) return;
  const store = getAITranscriptStore();
  if (!store[sessionId]) store[sessionId] = {};
  if (!Array.isArray(store[sessionId][chatId])) store[sessionId][chatId] = [];
  store[sessionId][chatId].push({ role, content: text, ts: Date.now() });
  if (store[sessionId][chatId].length > 80) store[sessionId][chatId] = store[sessionId][chatId].slice(-80);
  db.save('ai_transcripts', store);
}

function getAITranscript(sessionId, chatId, limit = 30) {
  const store = getAITranscriptStore();
  const arr = (store?.[sessionId]?.[chatId]);
  if (!Array.isArray(arr)) return [];
  return arr.slice(-Math.max(0, limit));
}

function splitAIReply(text, config) {
  const raw = (text ?? '').toString().trim();
  if (!raw) return [];
  if (!config?.splitEnabled) return [raw];
  const maxParts = clampInt(config.splitMaxParts, 1, 8, 3);
  const minChars = clampInt(config.splitMinChars, 1, 500, 10);
  const maxChars = clampInt(config.splitMaxChars, minChars, 800, 60);
  const parts = [];
  let remaining = raw;
  while (remaining.length && parts.length < maxParts) {
    if (remaining.length <= maxChars) {
      parts.push(remaining.trim());
      remaining = '';
      break;
    }
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ']) {
      const idx = remaining.lastIndexOf(sep, maxChars);
      if (idx >= minChars) { cut = idx + sep.length - 1; break; }
    }
    if (cut < minChars) cut = maxChars;
    const piece = remaining.slice(0, cut).trim();
    remaining = remaining.slice(cut).trim();
    if (piece) parts.push(piece);
  }
  if (remaining && parts.length) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} ${remaining}`.trim();
  } else if (remaining) {
    parts.push(remaining);
  }
  return parts.filter(Boolean);
}

async function openaiTranscribeAudio(apiKey, buffer, mime) {
  const key = (apiKey || '').toString().trim();
  if (!key) throw new Error('OpenAI apiKey missing');
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const type = (mime || 'audio/webm').toString();
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([b], { type }), `audio.${waGuessExt(type, '') || 'webm'}`);
  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: form
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || 'Transcription failed');
  return (data?.text || '').toString();
}

function parseDotenv() {
  try {
    const envFile = join(ROOT, '.env');
    if (!existsSync(envFile)) return;
    readFileSync(envFile, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  } catch {}
}
parseDotenv();

function resolveDirValue(v) {
  const s = (v ?? '').toString().trim();
  if (!s) return '';
  return isAbsolute(s) ? s : resolve(ROOT, s);
}

function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function copyDirRecursive(src, dst) {
  if (!existsSync(src)) return;
  const st = statSync(src);
  if (st.isDirectory()) {
    if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      copyDirRecursive(join(src, name), join(dst, name));
    }
    return;
  }
  const parent = dirname(dst);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  copyFileSync(src, dst);
}

function maybeMigrateDir(src, dst) {
  try {
    if (!src || !dst) return;
    const a = resolve(src);
    const b = resolve(dst);
    if (a === b) return;
    if (!existsSync(a)) return;
    if (existsSync(b)) return;
    ensureDir(dirname(b));
    copyDirRecursive(a, b);
  } catch {}
}

function pickPersistBase() {
  const fromEnv = resolveDirValue(process.env.PERSIST_DIR);
  const candidates = [fromEnv];
  if (process.platform === 'linux' && !fromEnv) {
    candidates.push(resolve(ROOT, '..', 'kindred-connect-persist'));
  }
  candidates.push(join(ROOT, 'persist'));
  candidates.push(ROOT);
  for (const c of candidates.filter(Boolean)) {
    if (ensureDir(c)) return c;
  }
  return ROOT;
}

const PERSIST_BASE = pickPersistBase();
const DATA = resolveDirValue(process.env.DATA_DIR) || join(PERSIST_BASE, 'data');
const WA_AUTH_DIR = resolveDirValue(process.env.WA_AUTH_DIR) || join(PERSIST_BASE, '.wwebjs_auth');
const MEDIA_BASE = resolveDirValue(process.env.MEDIA_DIR) || join(PERSIST_BASE, 'media');
const WA_MEDIA_DIR = resolveDirValue(process.env.WA_MEDIA_DIR) || join(MEDIA_BASE, 'wa-media');
const CHAT_MEDIA_DIR = resolveDirValue(process.env.CHAT_MEDIA_DIR) || join(MEDIA_BASE, 'chat-media');

maybeMigrateDir(join(ROOT, 'data'), DATA);
maybeMigrateDir(join(ROOT, '.wwebjs_auth'), WA_AUTH_DIR);
maybeMigrateDir(join(ROOT, 'Public', 'wa-media'), WA_MEDIA_DIR);
maybeMigrateDir(join(ROOT, 'Public', 'chat-media'), CHAT_MEDIA_DIR);

ensureDir(DATA);
ensureDir(WA_AUTH_DIR);
ensureDir(WA_MEDIA_DIR);
ensureDir(CHAT_MEDIA_DIR);

function html(res, content, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(content);
}

function escapeHtmlServer(text) {
  const s = String(text ?? '');
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch] || ch));
}

function resolveRequestBaseUrl(req) {
  const xfProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const xfHost = (req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim();
  const host = (xfHost || (req.headers.host || '').toString().split(',')[0].trim()).trim();
  const proto = (xfProto || ((req.socket && req.socket.encrypted) ? 'https' : 'http')).trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function isLocalhostUrl(u) {
  const s = (u || '').toString();
  return /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(s);
}

function resolveGoogleRedirectUri(req) {
  const allowLocal = ((process.env.ALLOW_LOCALHOST_OAUTH || '') + '').trim().toLowerCase() === 'true';
  const envRedirect = (process.env.GOOGLE_REDIRECT_URI || '').toString().trim();
  const publicBase = (process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').toString().trim().replace(/\/+$/, '');
  const reqBase = resolveRequestBaseUrl(req).replace(/\/+$/, '');
  const candidates = [
    envRedirect,
    publicBase ? `${publicBase}/auth/google/callback` : '',
    reqBase ? `${reqBase}/auth/google/callback` : '',
    'https://zapmro.com.br/auth/google/callback'
  ].filter(Boolean);
  for (const c of candidates) {
    if (!allowLocal && isLocalhostUrl(c)) continue;
    return c;
  }
  return candidates[0] || 'https://zapmro.com.br/auth/google/callback';
}

// ── DB ────────────────────────────────────────────────────────────────
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const db = {
  load: (f, def = []) => {
    try {
      const fp = join(DATA, `${f}.json`);
      if (!existsSync(fp)) return def;
      return JSON.parse(readFileSync(fp, 'utf8')) || def;
    } catch { return def; }
  },
  save: (f, d) => {
    writeFileSync(join(DATA, `${f}.json`), JSON.stringify(d, null, 2));
  },
  ensure: (f, def) => {
    const fp = join(DATA, `${f}.json`);
    if (!existsSync(fp)) db.save(f, def !== undefined ? def : []);
  }
};

['users','sessions','scheduled_messages','tags','contacts','auth_tokens','winback_campaigns'].forEach(f => db.ensure(f));
['flows','ai_config','kanban','ai_chat_status','ai_transcripts','flow_assets','flow_runs'].forEach(f => db.ensure(f, {}));

// Create default admin
const users = db.load('users');
if (!users.find(u => u.email === (process.env.ADMIN_EMAIL || 'admin@zapmro.cloud'))) {
  users.push({
    id: uuid(), name: 'Admin',
    email: process.env.ADMIN_EMAIL || 'admin@zapmro.cloud',
    password: bcryptjs.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10),
    role: 'admin', createdAt: new Date().toISOString()
  });
  db.save('users', users);
  console.log('✅ Admin user created');
}

// ── JWT Helpers ───────────────────────────────────────────────────────
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── MIME types ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};

// ── WhatsApp State ────────────────────────────────────────────────────
const waClients = new Map();
const waStatus = new Map();
const waLastQr = new Map();
const waInitLocks = new Map();
const waPicCache = new Map();
const chatHistory = new Map();
const pendingAI = new Map();
const aiInFlight = new Map();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getPicCacheKey(sessionId, chatId) {
  return `${sessionId}:${chatId}`;
}

function getCachedPic(sessionId, chatId) {
  const key = getPicCacheKey(sessionId, chatId);
  const item = waPicCache.get(key);
  if (!item) return '';
  if (Date.now() - item.ts > 10 * 60 * 1000) return '';
  return item.url || '';
}

function setCachedPic(sessionId, chatId, url) {
  if (!url) return;
  const key = getPicCacheKey(sessionId, chatId);
  waPicCache.set(key, { url, ts: Date.now() });
}

function killBrowserProcessesForSession(sessionDir) {
  if (process.platform !== 'win32') return;
  const safe = sessionDir.replace(/'/g, "''");
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${safe}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
      { stdio: 'ignore' }
    );
  } catch {}
}

async function stopWhatsApp(sessionId) {
  const client = waClients.get(sessionId);
  if (!client) return;
  try { await client.destroy(); } catch {}
  try {
    const proc = client?.pupBrowser?.process?.();
    if (proc?.pid) {
      try { process.kill(proc.pid); } catch {}
    }
  } catch {}
  try {
    const sessionDir = join(WA_AUTH_DIR, `session-${sessionId}`);
    killBrowserProcessesForSession(sessionDir);
  } catch {}
  waClients.delete(sessionId);
  waLastQr.delete(sessionId);
  waStatus.set(sessionId, 'disconnected');
  await sleep(1200);
}

async function removeDirWithRetries(dirPath, retries = 10, delayMs = 400) {
  for (let i = 0; i <= retries; i++) {
    try {
      if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
      return;
    } catch (e) {
      const code = e?.code || '';
      if (i === retries || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw e;
      await sleep(delayMs);
    }
  }
}

async function resetWhatsAppAuth(sessionId) {
  waInitLocks.delete(sessionId);
  await stopWhatsApp(sessionId);
  const dirPath = join(WA_AUTH_DIR, `session-${sessionId}`);
  killBrowserProcessesForSession(dirPath);
  await removeDirWithRetries(dirPath, 20, 500);
  killBrowserProcessesForSession(dirPath);
  waStatus.set(sessionId, 'disconnected');
  waLastQr.delete(sessionId);
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (s) { s.status = 'disconnected'; db.save('sessions', sessions); }
}

// ── Request Body Parser ───────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart')) { resolve({}); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

async function readRawBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseMultipart(req, maxBytes = 25 * 1024 * 1024) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/boundary=([^;]+)/i);
  if (!m) throw new Error('Missing boundary');
  const boundary = m[1];
  const raw = await readRawBody(req, maxBytes);
  const str = raw.toString('latin1');
  const boundaryStr = `--${boundary}`;
  const parts = str.split(boundaryStr).slice(1, -1);
  const out = { fields: {}, files: [] };
  for (let part of parts) {
    part = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const headerStr = part.slice(0, idx);
    let bodyStr = part.slice(idx + 4);
    bodyStr = bodyStr.replace(/\r\n$/, '');
    const headers = {};
    headerStr.split('\r\n').forEach(line => {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    const disp = headers['content-disposition'] || '';
    const name = (disp.match(/name="([^"]+)"/i) || [])[1];
    if (!name) continue;
    const filename = (disp.match(/filename="([^"]*)"/i) || [])[1];
    const contentType = headers['content-type'] || 'application/octet-stream';
    if (filename !== undefined) {
      out.files.push({ field: name, filename, contentType, buffer: Buffer.from(bodyStr, 'latin1') });
    } else {
      out.fields[name] = Buffer.from(bodyStr, 'latin1').toString('utf8');
    }
  }
  return out;
}

// ── Router ────────────────────────────────────────────────────────────
const routes = { GET: {}, POST: {}, DELETE: {}, PUT: {} };

function route(method, path, handler) {
  routes[method][path] = handler;
}

function matchRoute(method, url) {
  const path = url.split('?')[0];
  const exact = routes[method][path];
  if (exact) return { handler: exact, params: {} };
  
  for (const [pattern, handler] of Object.entries(routes[method])) {
    if (!pattern.includes(':')) continue;
    const parts = pattern.split('/');
    const urlParts = path.split('/');
    if (parts.length !== urlParts.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = urlParts[i];
      else if (parts[i] !== urlParts[i]) { match = false; break; }
    }
    if (match) return { handler, params };
  }
  return null;
}

// ── Response Helpers ──────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

// ── Auth Middleware ───────────────────────────────────────────────────
function auth(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  try { return verifyToken(token); } catch { return null; }
}

function requireAuth(req, res) {
  const user = auth(req);
  if (!user) { err(res, 'Unauthorized', 401); return null; }
  return user;
}

// ── Static File Server ────────────────────────────────────────────────
function serveStatic(req, res) {
  const requestPath = req.url.split('?')[0] || '/';
  const relativePath = requestPath.startsWith('/') ? requestPath.slice(1) : requestPath;
  let filePath = relativePath ? join(ROOT, 'Public', relativePath) : join(ROOT, 'Public', 'index.html');
  try {
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
  } catch {}
  if (!existsSync(filePath)) {
    const indexPath = join(ROOT, 'Public', 'index.html');
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync(indexPath));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }
  serveFilePath(req, res, filePath);
}

function safePathFromUrl(baseDir, urlPath) {
  const raw = (urlPath || '').toString().replace(/^\/+/, '');
  const abs = resolve(baseDir, raw);
  const base = resolve(baseDir);
  const absNorm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const baseNorm = process.platform === 'win32' ? base.toLowerCase() : base;
  if (absNorm === baseNorm) return null;
  if (!absNorm.startsWith(baseNorm + sep)) return null;
  return abs;
}

function serveFilePath(req, res, filePath) {
  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  let st = null;
  try { st = statSync(filePath); } catch {}
  const size = Number(st?.size || 0);
  const range = (req.headers.range || '').toString();

  if (range && size > 0) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (!m) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    const start = Math.min(parseInt(m[1], 10), size - 1);
    const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : Math.min(start + 1024 * 1024 * 5 - 1, size - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'max-age=300'
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(size || 0),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'max-age=300'
  });
  createReadStream(filePath).pipe(res);
}

// ══════════════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════════════

// ── Health ────────────────────────────────────────────────────────────
route('GET', '/api/health', (req, res) => {
  json(res, { ok: true, version: '2.0', uptime: process.uptime(), packages: { express: hasExpress, socketio: hasSocket, whatsapp: hasWA } });
});

route('GET', '/politicadeprivacidade', (req, res) => {
  html(res, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Política de Privacidade - ZAPMRO</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;line-height:1.5;color:#111}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px}p,li{color:#333}a{color:#128c7e}small{color:#666}</style></head><body><h1>Política de Privacidade</h1><small>Última atualização: ${new Date().toISOString().slice(0,10)}</small><p>Esta Política de Privacidade descreve como o ZAPMRO coleta e utiliza informações ao usar o sistema.</p><h2>Dados coletados</h2><ul><li>Dados de conta: nome e e-mail.</li><li>Dados operacionais: conversas e mensagens necessárias para funcionamento do CRM/automação.</li><li>Dados de integrações: quando você autoriza, tokens de acesso para sincronização (ex.: Google Contatos).</li></ul><h2>Uso das informações</h2><ul><li>Operar o painel e as funcionalidades de atendimento, automação e CRM.</li><li>Sincronizar contatos quando autorizado pelo usuário.</li><li>Melhorar estabilidade e segurança.</li></ul><h2>Compartilhamento</h2><p>Não vendemos seus dados. Podemos compartilhar somente quando necessário para provedores de infraestrutura e integrações (ex.: Google) conforme autorização.</p><h2>Segurança</h2><p>Adotamos medidas técnicas para proteger os dados armazenados e transmitidos.</p><h2>Contato</h2><p>Para dúvidas, entre em contato pelo site <a href="https://zapmro.com.br">zapmro.com.br</a>.</p></body></html>`);
});

route('GET', '/termosdoservico', (req, res) => {
  html(res, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Termos de Serviço - ZAPMRO</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;line-height:1.5;color:#111}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px}p,li{color:#333}a{color:#128c7e}small{color:#666}</style></head><body><h1>Termos de Serviço</h1><small>Última atualização: ${new Date().toISOString().slice(0,10)}</small><p>Ao usar o ZAPMRO, você concorda com estes Termos.</p><h2>Uso do serviço</h2><ul><li>Você é responsável pelas mensagens enviadas, contatos e conteúdos configurados.</li><li>Você deve respeitar as políticas do WhatsApp e demais plataformas integradas.</li></ul><h2>Conta</h2><p>Você deve manter suas credenciais seguras. O uso não autorizado deve ser comunicado.</p><h2>Integrações</h2><p>Ao conectar serviços externos (ex.: Google), você autoriza o acesso necessário para a funcionalidade solicitada (ex.: sincronização de contatos).</p><h2>Limitações</h2><p>O serviço é fornecido “como está”, podendo passar por melhorias e manutenções.</p><h2>Contato</h2><p>Mais informações em <a href="https://zapmro.com.br">zapmro.com.br</a>.</p></body></html>`);
});

route('GET', '/auth/google/callback', async (req, res) => {
  const qs = new URL(req.url, 'http://x').searchParams;
  const code = (qs.get('code') || '').toString();
  const state = (qs.get('state') || '').toString();
  if (!code || !state) return html(res, '<h1>Falha</h1><p>Parâmetros ausentes.</p>', 400);
  let payload = null;
  try { payload = verifyToken(state); } catch {}
  if (!payload || payload.type !== 'google_oauth' || !payload.uid) return html(res, '<h1>Falha</h1><p>State inválido.</p>', 400);

  const clientId = (process.env.GOOGLE_CLIENT_ID || '').toString().trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').toString().trim();
  const redirectUri = resolveGoogleRedirectUri(req);
  if (!clientId || !clientSecret) return html(res, '<h1>Falha</h1><p>Google OAuth não configurado no servidor.</p>', 500);

  try {
    const body = new URLSearchParams();
    body.set('code', code);
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
    body.set('redirect_uri', redirectUri);
    body.set('grant_type', 'authorization_code');
    const resp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return html(res, `<h1>Falha</h1><p>${escapeHtmlServer(data?.error_description || data?.error || 'Erro ao autenticar')}</p>`, 400);

    const tokens = db.load('auth_tokens', []);
    const now = Date.now();
    const expiresIn = Number(data.expires_in || 3600);
    const expiryTs = now + Math.max(60, expiresIn - 30) * 1000;
    const item = {
      type: 'google',
      userId: payload.uid,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      scope: data.scope,
      token_type: data.token_type,
      expiryTs,
      updatedAt: new Date().toISOString()
    };
    const idx = tokens.findIndex(t => t.type === 'google' && t.userId === payload.uid);
    if (idx >= 0) {
      const prev = tokens[idx] || {};
      tokens[idx] = { ...prev, ...item, refresh_token: item.refresh_token || prev.refresh_token };
    } else tokens.push(item);
    db.save('auth_tokens', tokens);

    const redirect = (payload.returnTo || '/dashboard.html').toString();
    html(res, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google conectado</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;"><h2>Google conectado com sucesso!</h2><p>Você já pode voltar para o sistema.</p><script>setTimeout(()=>{ location.href=${JSON.stringify(redirect)}; }, 700);</script></body></html>`);
  } catch (e) {
    html(res, `<h1>Falha</h1><p>${escapeHtmlServer(e?.message || 'Erro')}</p>`, 500);
  }
});

// ── Auth ─────────────────────────────────────────────────────────────
route('POST', '/api/auth/register', async (req, res) => {
  const { name, email, password, promoCode } = req.body;
  if (!email) return err(res, 'Email required');
  
  const validPromo = process.env.TEST_PROMO_CODE || 'ZAPMRO2026';
  if (promoCode && promoCode !== validPromo) return err(res, 'Código de acesso inválido');
  
  const users = db.load('users');
  if (users.find(u => u.email === email)) return err(res, 'Email já cadastrado');
  
  const user = {
    id: uuid(), name: name || email.split('@')[0], email,
    password: bcryptjs.hashSync(password || uuid(), 10),
    role: 'user', createdAt: new Date().toISOString()
  };
  users.push(user); db.save('users', users);
  json(res, { token: signToken({ id: user.id, email: user.email, role: user.role }), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

route('POST', '/api/auth/login', async (req, res) => {
  const { email, password, promoCode } = req.body;
  const users = db.load('users');
  const user = users.find(u => u.email === email);
  if (!user) return err(res, 'Usuário não encontrado');
  if (password) {
    const stored = (user.password || '').toString();
    const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');
    const ok = isBcrypt ? bcryptjs.compareSync(password, stored) : simpleHash(password) === stored;
    if (!ok) return err(res, 'Senha incorreta');
    if (!isBcrypt) {
      user.password = bcryptjs.hashSync(password, 10);
      db.save('users', users);
    }
  }
  json(res, { token: signToken({ id: user.id, email: user.email, role: user.role }), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

route('POST', '/api/auth/supabase', async (req, res) => {
  const { supabase_user } = req.body;
  if (!supabase_user?.email) return err(res, 'No user');
  let users = db.load('users');
  let user = users.find(u => u.email === supabase_user.email);
  if (!user) {
    user = { id: supabase_user.id || uuid(), name: supabase_user.user_metadata?.full_name || supabase_user.email.split('@')[0], email: supabase_user.email, password: bcryptjs.hashSync(uuid(), 10), role: 'user', createdAt: new Date().toISOString() };
    users.push(user); db.save('users', users);
  }
  json(res, { token: signToken({ id: user.id, email: user.email, role: user.role }), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

route('GET', '/api/me', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const user = db.load('users').find(x => x.id === u.id);
  if (!user) return err(res, 'Not found', 404);
  json(res, { id: user.id, name: user.name, email: user.email, role: user.role });
});

route('PUT', '/api/me', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const name = (req.body?.name || '').toString().trim();
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  if (!name) return err(res, 'Nome obrigatório', 400);
  if (!email || !email.includes('@')) return err(res, 'Email inválido', 400);
  const users = db.load('users');
  const me = users.find(x => x.id === u.id);
  if (!me) return err(res, 'Not found', 404);
  const exists = users.find(x => x.id !== me.id && String(x.email || '').toLowerCase() === email);
  if (exists) return err(res, 'Email já cadastrado', 409);
  me.name = name;
  me.email = email;
  me.updatedAt = new Date().toISOString();
  db.save('users', users);
  json(res, { ok: true, user: { id: me.id, name: me.name, email: me.email, role: me.role } });
});

route('POST', '/api/me/password', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const currentPassword = (req.body?.currentPassword || '').toString();
  const newPassword = (req.body?.newPassword || '').toString();
  if (!currentPassword) return err(res, 'Senha atual obrigatória', 400);
  if (!newPassword || newPassword.length < 6) return err(res, 'Nova senha muito curta', 400);
  const users = db.load('users');
  const me = users.find(x => x.id === u.id);
  if (!me) return err(res, 'Not found', 404);
  const stored = (me.password || '').toString();
  const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');
  const ok = isBcrypt ? bcryptjs.compareSync(currentPassword, stored) : simpleHash(currentPassword) === stored;
  if (!ok) return err(res, 'Senha atual incorreta', 401);
  me.password = bcryptjs.hashSync(newPassword, 10);
  me.updatedAt = new Date().toISOString();
  db.save('users', users);
  json(res, { ok: true });
});

function getGoogleTokenItem(userId) {
  const tokens = db.load('auth_tokens', []);
  const item = tokens.find(t => t.type === 'google' && t.userId === userId) || null;
  return item;
}

function saveGoogleTokenItem(userId, patch) {
  const tokens = db.load('auth_tokens', []);
  const idx = tokens.findIndex(t => t.type === 'google' && t.userId === userId);
  if (idx >= 0) tokens[idx] = { ...tokens[idx], ...patch, type: 'google', userId, updatedAt: new Date().toISOString() };
  else tokens.push({ ...patch, type: 'google', userId, updatedAt: new Date().toISOString() });
  db.save('auth_tokens', tokens);
}

async function getGoogleAccessToken(userId) {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').toString().trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').toString().trim();
  if (!clientId || !clientSecret) throw new Error('Google OAuth não configurado');
  const item = getGoogleTokenItem(userId);
  if (!item?.access_token) throw new Error('Google não conectado');
  const now = Date.now();
  if (item.expiryTs && now < Number(item.expiryTs) - 5_000) return item.access_token;
  if (!item.refresh_token) return item.access_token;
  const body = new URLSearchParams();
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  body.set('refresh_token', item.refresh_token);
  body.set('grant_type', 'refresh_token');
  const resp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error_description || data?.error || 'Falha ao renovar token');
  const expiresIn = Number(data.expires_in || 3600);
  const expiryTs = now + Math.max(60, expiresIn - 30) * 1000;
  saveGoogleTokenItem(userId, { access_token: data.access_token, expiryTs });
  return data.access_token;
}

route('GET', '/api/google/auth-url', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').toString().trim();
  const redirectUri = resolveGoogleRedirectUri(req);
  if (!clientId) return err(res, 'Google OAuth não configurado', 500);
  const state = signToken({ type: 'google_oauth', uid: u.id, returnTo: '/dashboard.html#contacts' });
  const scope = [
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/userinfo.profile'
  ].join(' ');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  json(res, { ok: true, url: url.toString(), redirectUri });
});

route('GET', '/api/google/status', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const item = getGoogleTokenItem(u.id);
  json(res, { connected: !!item?.access_token, scope: item?.scope || null, updatedAt: item?.updatedAt || null });
});

route('POST', '/api/google/sync-contacts/:sessionId', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === req.params.sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const token = await getGoogleAccessToken(u.id);
  const url = new URL('https://people.googleapis.com/v1/people/me/connections');
  url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers');
  url.searchParams.set('pageSize', '1000');
  const resp = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return err(res, data?.error?.message || 'Falha ao buscar contatos Google', 400);
  const connections = Array.isArray(data?.connections) ? data.connections : [];
  const contacts = db.load('contacts', []);
  let imported = 0;
  let updated = 0;
  for (const p of connections) {
    const displayName = (p?.names?.[0]?.displayName || '').toString().trim();
    const phoneRaw = (p?.phoneNumbers?.[0]?.value || '').toString();
    const digits = digitsOnly(phoneRaw);
    if (!digits || digits.length < 10) continue;
    const waId = `${digits}@c.us`;
    const email = (p?.emailAddresses?.[0]?.value || '').toString().trim();
    const resourceName = (p?.resourceName || '').toString();
    const idx = contacts.findIndex(c => c.sessionId === s.id && ((c.waId || c.id) === waId));
    if (idx >= 0) {
      const prev = contacts[idx];
      contacts[idx] = {
        ...prev,
        id: prev.id || waId,
        waId,
        number: digits,
        name: displayName || prev.name || '',
        email: email || prev.email || '',
        source: 'google',
        googleResourceName: resourceName || prev.googleResourceName || '',
        updatedAt: new Date().toISOString()
      };
      updated++;
    } else {
      contacts.push({
        id: waId,
        waId,
        sessionId: s.id,
        userId: s.userId,
        name: displayName || '',
        number: digits,
        email: email || '',
        note: '',
        source: 'google',
        googleResourceName: resourceName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      imported++;
    }
  }
  db.save('contacts', contacts);
  json(res, { ok: true, total: connections.length, imported, updated });
});

// ── Sessions ──────────────────────────────────────────────────────────
route('GET', '/api/active-sessions', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const all = db.load('sessions');
  const sessions = u.role === 'admin' ? all : all.filter(s => s.userId === u.id);
  json(res, sessions.map(s => ({ ...s, status: waStatus.get(s.id) || s.status || 'disconnected' })));
});

route('POST', '/api/create-session', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessionId = req.body.sessionId || uuid();
  const sessions = db.load('sessions');
  if (!sessions.find(s => s.id === sessionId)) {
    sessions.push({ id: sessionId, userId: u.id, status: 'initializing', createdAt: new Date().toISOString() });
    db.save('sessions', sessions);
  }
  json(res, { ok: true, sessionId });
});

route('POST', '/api/whatsapp/connect', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, force } = req.body;
  if (!sessionId) return err(res, 'sessionId required');
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  if (hasWA) {
    const status = waStatus.get(sessionId);
    const existing = waClients.get(sessionId);
    if (existing && status !== 'connected' && force) {
      await stopWhatsApp(sessionId);
    }
    if (!existing || force) initWhatsApp(sessionId, u.id);
  }
  json(res, { ok: true, sessionId, waAvailable: hasWA, status: waStatus.get(sessionId) || 'disconnected' });
});

route('GET', '/api/whatsapp/qr/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = req.params.sessionId;
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sid);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  json(res, { status: waStatus.get(sid) || 'disconnected', qr: waLastQr.get(sid)?.qr || '' });
});

route('POST', '/api/whatsapp/disconnect', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId } = req.body;
  await stopWhatsApp(sessionId);
  json(res, { ok: true });
});

route('POST', '/api/whatsapp/reset', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId } = req.body;
  if (!sessionId) return err(res, 'sessionId required');
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  try {
    await resetWhatsAppAuth(sessionId);
    json(res, { ok: true });
  } catch (e) {
    err(res, e?.message || 'Erro ao resetar sessão', 500);
  }
});

route('DELETE', '/api/session/:id', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  await stopWhatsApp(req.params.id);
  let sessions = db.load('sessions');
  sessions = sessions.filter(s => s.id !== req.params.id);
  db.save('sessions', sessions);
  json(res, { ok: true });
});

route('GET', '/api/whatsapp/status/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === req.params.sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const status = waStatus.get(req.params.sessionId) || s.status || 'disconnected';
  json(res, { status, connected: status === 'connected' });
});

route('GET', '/api/whatsapp/self/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === req.params.sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const client = waClients.get(req.params.sessionId);
  const info = client?.info || null;
  const connected = !!info;
  const wid = info?.wid?._serialized || info?.wid?.user || null;
  const number = info?.wid?.user ? `+${String(info.wid.user)}` : null;
  const pushname = info?.pushname || null;
  json(res, { connected, wid, number, pushname });
});

// ── WhatsApp Operations ───────────────────────────────────────────────
route('GET', '/api/whatsapp/chats', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const sessionId = qs.get('sessionId');
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return json(res, []);
  const client = waClients.get(sessionId);
  if (!client?.info) return json(res, []);
  try {
    const chats = await client.getChats();
    const slice = chats.slice(0, 200);
    const result = slice.map(c => {
      const chatName = c.name || c.formattedTitle || c.id?.user || 'U';
      const cached = getCachedPic(sessionId, c.id?._serialized);
      return {
        id: c.id?._serialized,
        name: chatName,
        number: c.isGroup ? null : (c.id?.user || null),
        pic: cached || `https://ui-avatars.com/api/?name=${encodeURIComponent(chatName)}&background=128c7e&color=fff`,
        isGroup: !!c.isGroup,
        unread: c.unreadCount || 0,
        timestamp: c.timestamp,
        lastMessage: c.lastMessage ? { body: c.lastMessage.body, fromMe: c.lastMessage.fromMe } : null
      };
    }).filter(x => x.id);

    await Promise.allSettled(result.slice(0, 30).map(async (item) => {
      try {
        const pic = await client.getProfilePicUrl(item.id);
        if (pic) {
          item.pic = pic;
          setCachedPic(sessionId, item.id, pic);
        }
      } catch {}
    }));

    json(res, result);
  } catch (e) {
    console.error('getChats error:', e?.message || e);
    json(res, []);
  }
});

route('GET', '/api/whatsapp/chat-info/:chatId', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const sessionId = qs.get('sessionId');
  let chatId = req.params.chatId || '';
  try { chatId = decodeURIComponent(chatId); } catch {}
  if (!sessionId) return err(res, 'sessionId required', 400);
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const client = waClients.get(sessionId);
  if (!client?.info) return err(res, 'Session not connected', 400);

  try {
    let chat = null;
    try { chat = await client.getChatById(chatId); } catch {}
    const isGroup = !!chat?.isGroup || String(chatId).includes('@g.us');

    let number = null;
    let name = null;
    let pushname = null;
    if (!isGroup) {
      try {
        const m = String(chatId).match(/^(\d+)@/);
        const fromIdNumber = m ? m[1] : null;
        let contact = await client.getContactById(chatId);
        if ((!contact || (!contact?.number && !contact?.name && !contact?.pushname)) && fromIdNumber && String(chatId).includes('@lid')) {
          try { contact = await client.getContactById(`${fromIdNumber}@c.us`); } catch {}
        }
        number = contact?.number || fromIdNumber || null;
        name = contact?.name || null;
        pushname = contact?.pushname || null;
      } catch {}
      if (!number) {
        const m = String(chatId).match(/^(\d+)@/);
        number = m ? m[1] : null;
      }
    }

    const title = (chat?.name || chat?.formattedTitle || null);
    const displayName = (title || name || pushname || number || chatId).toString();
    let phoneNumber = number ? digitsOnly(number) : '';
    const waIdDigits = digitsOnly(String(chatId).match(/^(\d+)@/)?.[1] || '');
    const looksLikeLid = String(chatId).includes('@lid') && waIdDigits && phoneNumber === waIdDigits;
    if (!phoneNumber || looksLikeLid) {
      phoneNumber = extractPhoneDigits(title) || extractPhoneDigits(displayName) || '';
    }

    let pic = getCachedPic(sessionId, chatId) || null;
    if (!pic) {
      try {
        const p = await client.getProfilePicUrl(chatId);
        if (p) { pic = p; setCachedPic(sessionId, chatId, p); }
      } catch {}
    }

    json(res, {
      id: chatId,
      isGroup,
      name: displayName,
      number: phoneNumber || null,
      title,
      contactName: name,
      pushname,
      pic
    });
  } catch (e) {
    err(res, e?.message || 'Erro ao carregar chat', 500);
  }
});

route('GET', '/api/whatsapp/groups', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const sessionId = qs.get('sessionId');
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return json(res, []);
  const client = waClients.get(sessionId);
  if (!client?.info) return json(res, []);
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => !!c.isGroup).slice(0, 400).map(c => ({
      id: c.id?._serialized,
      name: c.name || c.id?.user || 'Grupo',
      isGroup: true,
      timestamp: c.timestamp
    })).filter(x => x.id);
    json(res, groups);
  } catch {
    json(res, []);
  }
});

route('GET', '/api/whatsapp/profile-pics', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const sessionId = qs.get('sessionId');
  const chatIdsParam = qs.get('chatIds') || '';
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return json(res, { pics: {} });
  const client = waClients.get(sessionId);
  if (!client?.info) return json(res, { pics: {} });
  const ids = chatIdsParam.split(',').map(x => x.trim()).filter(Boolean).slice(0, 60);
  const pics = {};
  const toFetch = [];
  for (const id of ids) {
    const cached = getCachedPic(sessionId, id);
    if (cached) pics[id] = cached;
    else toFetch.push(id);
  }
  await Promise.allSettled(toFetch.slice(0, 15).map(async (id) => {
    try {
      const pic = await client.getProfilePicUrl(id);
      if (pic) {
        setCachedPic(sessionId, id, pic);
        pics[id] = pic;
      }
    } catch {}
  }));
  json(res, { pics });
});

route('GET', '/api/whatsapp/messages/:chatId', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const sessionId = qs.get('sessionId');
  let chatId = req.params.chatId || '';
  try { chatId = decodeURIComponent(chatId); } catch {}
  if (!sessionId) return err(res, 'sessionId required', 400);

  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);

  const client = waClients.get(sessionId);
  if (!client?.info) return json(res, []);

  const history = getHistory(sessionId, chatId);
  if (!history.length) {
    try {
      let chat = null;
      try { chat = await client.getChatById(chatId); } catch {}
      if (!chat) {
        try {
          const chats = await client.getChats();
          chat = chats.find(c => c?.id?._serialized === chatId) || null;
        } catch {}
      }
      if (chat) {
        const messages = await chat.fetchMessages({ limit: 100 });
        const existingIds = new Set(getHistory(sessionId, chatId).map(m => m?.id).filter(Boolean));
        let mediaDownloaded = 0;
        for (const msg of messages) {
          const id = msg?.id?.id || msg?.id?._serialized || '';
          if (id && existingIds.has(id)) continue;
          const body = (msg?.body || msg?._data?.caption || '').toString();
          const item = {
            id: id || uuid(),
            body,
            fromMe: !!msg?.fromMe,
            timestamp: Number(msg?.timestamp || 0) || Math.floor(Date.now() / 1000),
            type: (msg?.type || '').toString()
          };
          if (msg?.hasMedia && hasWA && MessageMedia && mediaDownloaded < 50) {
            try {
              const media = await msg.downloadMedia();
              if (media?.data) {
                item.media = saveWAMediaToPublic(sessionId, chatId, item.id, media);
                mediaDownloaded += 1;
                if (!item.body) item.body = (item.media?.filename || '').toString();
              }
            } catch {}
          }
          addToHistory(sessionId, chatId, item);
        }
        if (!messages.length && chat?.lastMessage) {
          const lm = chat.lastMessage;
          const id = lm?.id?.id || lm?.id?._serialized || '';
          const body = (lm?.body || lm?._data?.caption || '').toString();
          if (body || (lm?.type || '')) {
            addToHistory(sessionId, chatId, {
              id: id || uuid(),
              body,
              fromMe: !!lm?.fromMe,
              timestamp: Number(lm?.timestamp || 0) || Math.floor(Date.now() / 1000),
              type: (lm?.type || '').toString()
            });
          }
        }
        return json(res, getHistory(sessionId, chatId).slice(-200));
      }
    } catch (e) {
      console.error('fetchMessages error:', sessionId, chatId, e?.message || e);
    }
  }

  try {
    let chat = null;
    try { chat = await client.getChatById(chatId); } catch {}
    if (!chat) {
      try {
        const chats = await client.getChats();
        chat = chats.find(c => c?.id?._serialized === chatId) || null;
      } catch {}
    }
    if (chat && hasWA && MessageMedia) {
      const hist = getHistory(sessionId, chatId);
      const idToIndex = new Map();
      for (let i = 0; i < hist.length; i++) {
        const id = hist[i]?.id;
        if (id) idToIndex.set(String(id), i);
      }
      const messages = await chat.fetchMessages({ limit: 60 });
      let mediaDownloaded = 0;
      let updated = false;
      for (const msg of messages) {
        if (!msg?.hasMedia) continue;
        if (mediaDownloaded >= 25) break;
        const id = msg?.id?.id || msg?.id?._serialized || '';
        if (!id) continue;
        const idx = idToIndex.get(String(id));
        if (idx !== undefined && hist[idx]?.media?.url) continue;
        try {
          const media = await msg.downloadMedia();
          if (!media?.data) continue;
          const saved = saveWAMediaToPublic(sessionId, chatId, id, media);
          const body = (msg?.body || msg?._data?.caption || '').toString();
          const patch = {
            id,
            body: body || (saved?.filename || '').toString() || (hist[idx]?.body || '').toString(),
            fromMe: !!msg?.fromMe,
            timestamp: Number(msg?.timestamp || 0) || Math.floor(Date.now() / 1000),
            type: (msg?.type || '').toString(),
            media: saved
          };
          if (idx !== undefined) {
            hist[idx] = { ...hist[idx], ...patch };
          } else {
            idToIndex.set(String(id), hist.length);
            hist.push(patch);
          }
          mediaDownloaded += 1;
          updated = true;
        } catch {}
      }
      if (updated) persistHistory(sessionId, chatId, hist);
    }
  } catch {}

  json(res, getHistory(sessionId, chatId).slice(-200));
});

route('POST', '/api/whatsapp/send', async (req, res) => {
  const { sessionId, to, message } = req.body;
  const client = waClients.get(sessionId);
  if (!client?.info) return err(res, 'Session not connected');
  try { await client.sendMessage(to, message); json(res, { ok: true }); }
  catch (e) { err(res, e.message, 500); }
});

route('POST', '/api/whatsapp/send-media', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('multipart/form-data')) return err(res, 'Invalid content type', 400);
  try {
    const { files, fields } = await parseMultipart(req, 30 * 1024 * 1024);
    const file = files?.[0];
    const sessionId = (fields?.sessionId || '').toString();
    const to = (fields?.to || '').toString();
    const caption = (fields?.caption || '').toString();
    const sendAsVoice = String(fields?.sendAsVoice || '').toLowerCase() === 'true';
    if (!sessionId || !to) return err(res, 'sessionId/to required', 400);
    if (!file?.buffer?.length) return err(res, 'File required', 400);

    const sessions = db.load('sessions');
    const s = sessions.find(x => x.id === sessionId);
    if (!s || (s.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
    const client = waClients.get(sessionId);
    if (!client?.info) return err(res, 'Session not connected', 400);
    if (!hasWA || !MessageMedia) return err(res, 'Media not supported', 400);

    const original = (file.filename || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const mime = (file.contentType || 'application/octet-stream').split(';')[0].trim();
    const ext = waGuessExt(mime, original) || (extname(original) || '');
    const safeSession = waSafePart(sessionId);
    const safeChat = waSafePart(to);
    const fileId = uuid();
    const rel = join('chat-media', safeSession, safeChat, `${waSafePart(fileId)}${ext}`).replace(/\\/g, '/');
    const abs = join(CHAT_MEDIA_DIR, safeSession, safeChat, `${waSafePart(fileId)}${ext}`);
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(abs, file.buffer);

    const media = MessageMedia.fromFilePath(abs);
    const options = {};
    if (caption.trim()) options.caption = caption.trim();
    if (sendAsVoice) options.sendAudioAsVoice = true;
    let sent = null;
    try {
      sent = await client.sendMessage(to, media, options);
    } catch (e) {
      if (sendAsVoice) {
        const options2 = {};
        if (caption.trim()) options2.caption = caption.trim();
        sent = await client.sendMessage(to, media, options2);
      } else {
        throw e;
      }
    }

    const msgData = {
      id: sent?.id?.id || sent?.id?._serialized || fileId,
      body: caption || original,
      fromMe: true,
      timestamp: sent?.timestamp || Math.floor(Date.now() / 1000),
      type: sent?.type || (mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : 'document'),
      media: { url: '/' + rel, mime, filename: original, size: file.buffer.length, kind: waKindFromMime(mime) }
    };
    addToHistory(sessionId, to, msgData);
    if (io) io.to(sessionId).emit('new-message', { sessionId, chatId: to, message: msgData });
    json(res, { ok: true, message: msgData });
  } catch (e) {
    err(res, e?.message || 'Falha ao enviar mídia', 500);
  }
});

route('GET', '/api/whatsapp/contacts', async (req, res) => {
  const qs = new URL(req.url, 'http://x').searchParams;
  const client = waClients.get(qs.get('sessionId'));
  if (!client?.info) return json(res, []);
  try {
    const contacts = await client.getContacts();
    json(res, contacts.filter(c => !c.isGroup && c.number).slice(0, 200).map(c => ({ id: c.id._serialized, name: c.name || c.pushname || c.number, number: c.number })));
  } catch { json(res, []); }
});

// ── Flows ─────────────────────────────────────────────────────────────
route('GET', '/api/flows/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const flows = db.load('flows', {});
  json(res, flows[req.params.sessionId] || []);
});

route('POST', '/api/flows/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const flows = db.load('flows', {});
  if (!flows[req.params.sessionId]) flows[req.params.sessionId] = [];
  const flow = { ...req.body, id: req.body.id || uuid(), createdAt: new Date().toISOString() };
  const idx = flows[req.params.sessionId].findIndex(f => f.id === flow.id);
  if (idx >= 0) flows[req.params.sessionId][idx] = flow;
  else flows[req.params.sessionId].push(flow);
  db.save('flows', flows); json(res, flow);
});

route('POST', '/api/flows/start', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, chatId, flowId } = req.body || {};
  if (!sessionId || !chatId || !flowId) return err(res, 'sessionId/chatId/flowId required', 400);
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const client = waClients.get(sessionId);
  if (!client?.info) return err(res, 'Session not connected', 400);

  const store = getFlowRunsStore();
  const runs = getChatRuns(store, sessionId, chatId).filter(r => r.status !== 'done');
  if (runs.length) return err(res, 'Já existe um fluxo em andamento neste chat', 409);

  try {
    await startFlowById(sessionId, chatId, flowId, client);
    const store2 = getFlowRunsStore();
    const runs2 = getChatRuns(store2, sessionId, chatId).filter(r => r.status !== 'done');
    json(res, { ok: true, started: runs2.length > 0 });
  } catch (e) {
    err(res, e?.message || 'Falha ao iniciar fluxo', 500);
  }
});

route('DELETE', '/api/flows/:sessionId/:flowId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const flows = db.load('flows', {});
  if (flows[req.params.sessionId]) flows[req.params.sessionId] = flows[req.params.sessionId].filter(f => f.id !== req.params.flowId);
  db.save('flows', flows); json(res, { ok: true });
});

route('GET', '/api/flows/runs/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessionId = req.params.sessionId;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return json(res, { runs: [] });
  const qs = new URL(req.url, 'http://x').searchParams;
  const chatId = (qs.get('chatId') || '').toString();
  const store = getFlowRunsStore();
  const flows = db.load('flows', {})[sessionId] || [];
  const runs = chatId ? getChatRuns(store, sessionId, chatId) : [];
  const out = runs.map(r => {
    const f = flows.find(x => x.id === r.flowId);
    let node = null;
    if (f && Array.isArray(f.nodes) && r.nodeId) node = f.nodes.find(n => n.id === r.nodeId) || null;
    return {
      id: r.id,
      flowId: r.flowId,
      flowName: f?.name || r.flowId,
      status: r.status,
      nodeId: r.nodeId || null,
      nodeType: node?.type || null,
      wait: r.wait || null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    };
  });
  json(res, { runs: out });
});

route('DELETE', '/api/flows/runs/:sessionId/:runId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessionId = req.params.sessionId;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const qs = new URL(req.url, 'http://x').searchParams;
  const chatId = (qs.get('chatId') || '').toString();
  if (!chatId) return err(res, 'chatId required', 400);
  const store = getFlowRunsStore();
  const runs = getChatRuns(store, sessionId, chatId).filter(r => r.id !== req.params.runId);
  setChatRuns(store, sessionId, chatId, runs);
  saveFlowRunsStore(store);
  json(res, { ok: true });
});

route('GET', '/api/flows/:sessionId/assets', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const assets = db.load('flow_assets', {})[req.params.sessionId] || [];
  json(res, { assets });
});

route('POST', '/api/flows/:sessionId/assets', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('multipart/form-data')) return err(res, 'Invalid content type', 400);
  try {
    const { files } = await parseMultipart(req, 30 * 1024 * 1024);
    const file = files?.[0];
    if (!file?.buffer?.length) return err(res, 'File required', 400);
    const original = (file.filename || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const mime = (file.contentType || 'application/octet-stream').split(';')[0].trim();
    const ext = (extname(original) || '').toLowerCase();
    const mimeToExt = {
      'audio/ogg': '.ogg',
      'audio/opus': '.ogg',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'application/pdf': '.pdf'
    };
    const safeExt = ext && ext.length <= 8 ? ext : (mimeToExt[mime] || '');
    const assetId = uuid();
    const dir = join(ROOT, 'Public', 'uploads', 'flows', req.params.sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filename = `${assetId}${safeExt}`;
    const absPath = join(dir, filename);
    writeFileSync(absPath, file.buffer);
    const url = `/uploads/flows/${req.params.sessionId}/${filename}`;
    const asset = { id: assetId, url, mime, originalName: original, size: file.buffer.length, createdAt: new Date().toISOString() };
    const all = db.load('flow_assets', {});
    if (!all[req.params.sessionId]) all[req.params.sessionId] = [];
    all[req.params.sessionId] = [asset, ...all[req.params.sessionId]].slice(0, 300);
    db.save('flow_assets', all);
    json(res, { asset });
  } catch (e) {
    err(res, e?.message || 'Upload failed', 500);
  }
});

// ── AI Config ─────────────────────────────────────────────────────────
route('GET', '/api/ai-config/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const config = db.load('ai_config', {});
  const cfg = config[req.params.sessionId] || { enabled: false, provider: 'openai', model: 'gpt-4o-mini' };
  const { apiKey, ...rest } = (cfg || {});
  json(res, { ...rest, apiKeySet: !!apiKey, apiKeyHint: (cfg?.apiKeyHint || null) });
});

route('POST', '/api/ai-config/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const config = db.load('ai_config', {});
  const prev = config[req.params.sessionId] || {};
  const body = req.body || {};
  const next = { ...prev, ...body, updatedAt: new Date().toISOString() };
  if (typeof body.apiKey === 'string') {
    const k = body.apiKey.trim();
    if (k) {
      next.apiKey = k;
      next.apiKeyHint = k.slice(-4);
    } else {
      delete next.apiKey;
      delete next.apiKeyHint;
    }
  }
  config[req.params.sessionId] = next;
  db.save('ai_config', config); json(res, { ok: true });
});

route('POST', '/api/ai-chat-status', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, chatId, enabled } = req.body;
  const statuses = db.load('ai_chat_status', {});
  const key = `${sessionId}:${chatId}`;
  if (enabled === null || enabled === undefined) delete statuses[key];
  else statuses[key] = enabled === true;
  db.save('ai_chat_status', statuses); json(res, { ok: true });
});

route('GET', '/api/ai-chat-status/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const qs = new URL(req.url, 'http://x').searchParams;
  const chatId = (qs.get('chatId') || '').toString();
  const statuses = db.load('ai_chat_status', {});
  const cfg = getAIConfig(req.params.sessionId);
  if (chatId) {
    const override = getAIChatOverride(statuses, req.params.sessionId, chatId);
    const armed = isAIArmed(cfg, override);
    return json(res, { chatId, override, armed, mode: cfg.mode, enabled: !!cfg.enabled });
  }
  const out = {};
  const prefix = `${req.params.sessionId}:`;
  for (const [k, v] of Object.entries(statuses || {})) {
    if (!k.startsWith(prefix)) continue;
    out[k.slice(prefix.length)] = v;
  }
  json(res, { statuses: out, mode: cfg.mode, enabled: !!cfg.enabled });
});

route('GET', '/api/ai/summary/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const store = db.load('ai_transcripts', {});
  const chats = store?.[req.params.sessionId] || {};
  const kanban = db.load('kanban', {})?.[req.params.sessionId] || null;
  const tagByChat = new Map();
  const cols = Array.isArray(kanban?.columns) ? kanban.columns : [];
  for (const col of cols) {
    const ids = Array.isArray(col?.chats) ? col.chats : [];
    for (const id of ids) {
      const k = String(id);
      if (!tagByChat.has(k)) tagByChat.set(k, (col?.name || '').toString());
    }
  }
  const statuses = db.load('ai_chat_status', {});
  const cfg = getAIConfig(req.params.sessionId);
  const out = [];
  for (const [chatId, arr] of Object.entries(chats)) {
    const items = Array.isArray(arr) ? arr : [];
    if (!items.length) continue;
    let userCount = 0;
    let aiCount = 0;
    let lastTs = 0;
    let lastUser = '';
    let lastAi = '';
    for (const it of items) {
      if (it?.role === 'assistant') { aiCount++; lastAi = (it?.content || '').toString(); }
      else { userCount++; lastUser = (it?.content || '').toString(); }
      lastTs = Math.max(lastTs, Number(it?.ts || 0));
    }
    const override = getAIChatOverride(statuses, req.params.sessionId, chatId);
    const armed = isAIArmed(cfg, override);
    const display = (() => {
      const m = String(chatId).match(/^(\d+)@/);
      return m?.[1] ? `+${m[1]}` : String(chatId);
    })();
    const snippet = (lastAi || lastUser || '').replace(/\s+/g, ' ').trim();
    out.push({
      chatId,
      display,
      tag: tagByChat.get(String(chatId)) || null,
      lastTs,
      userCount,
      aiCount,
      snippet: snippet.length > 140 ? snippet.slice(0, 140) + '…' : snippet,
      override,
      armed
    });
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  json(res, { ok: true, sessionId: req.params.sessionId, mode: cfg.mode, enabled: !!cfg.enabled, chats: out.slice(0, 200) });
});

// ── Kanban ────────────────────────────────────────────────────────────
route('GET', '/api/kanban/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const kanban = db.load('kanban', {});
  json(res, kanban[req.params.sessionId] || { columns: [
    { id: 'lead', name: 'Lead', color: '#3498db', chats: [] },
    { id: 'attending', name: 'Em Atendimento', color: '#f39c12', chats: [] },
    { id: 'negotiating', name: 'Negociando', color: '#9b59b6', chats: [] },
    { id: 'closed', name: 'Venda Fechada', color: '#27ae60', chats: [] },
    { id: 'lost', name: 'Perdido', color: '#e74c3c', chats: [] }
  ]});
});

route('POST', '/api/kanban/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const kanban = db.load('kanban', {});
  kanban[req.params.sessionId] = req.body; db.save('kanban', kanban); json(res, { ok: true });
});

route('POST', '/api/kanban/:sessionId/move', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { chatId, fromColumn, toColumn } = req.body;
  const kanban = db.load('kanban', {});
  const data = kanban[req.params.sessionId];
  if (!data) return err(res, 'Not found', 404);
  const from = data.columns.find(c => c.id === fromColumn);
  const to = data.columns.find(c => c.id === toColumn);
  if (!from || !to) return err(res, 'Invalid column');
  from.chats = from.chats.filter(c => c !== chatId);
  if (!to.chats.includes(chatId)) to.chats.push(chatId);
  kanban[req.params.sessionId] = data; db.save('kanban', kanban); json(res, { ok: true });
});

// ── Tags ──────────────────────────────────────────────────────────────
route('GET', '/api/tags/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  json(res, db.load('tags').filter(t => t.sessionId === req.params.sessionId));
});

route('POST', '/api/tags/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const tags = db.load('tags');
  const tag = { ...req.body, id: req.body.id || uuid(), sessionId: req.params.sessionId };
  const idx = tags.findIndex(t => t.id === tag.id);
  if (idx >= 0) tags[idx] = tag; else tags.push(tag);
  db.save('tags', tags); json(res, tag);
});

// ── Contacts ──────────────────────────────────────────────────────────
route('GET', '/api/contacts/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const contacts = db.load('contacts').filter(c => c.sessionId === req.params.sessionId);
  let changed = false;
  for (const c of contacts) {
    const waId = (c?.waId || c?.id || '').toString();
    const waDigits = digitsOnly(waId.match(/^(\d+)@/)?.[1] || '');
    let num = digitsOnly(c?.number);
    if ((!num || (waDigits && num === waDigits)) && waId.includes('@lid')) {
      const fromName = extractPhoneDigits(c?.name);
      if (fromName && (!waDigits || fromName !== waDigits)) {
        c.number = fromName;
        c.updatedAt = new Date().toISOString();
        num = fromName;
        changed = true;
      }
    }
    if (!num && waId.includes('@c.us') && waDigits) {
      c.number = waDigits;
      c.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) {
    const all = db.load('contacts');
    const map = new Map(contacts.map(x => [x.id, x]));
    const merged = all.map(x => map.get(x.id) || x);
    db.save('contacts', merged);
  }
  json(res, contacts);
});

route('POST', '/api/contacts/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const contacts = db.load('contacts');
  const id = req.body.id || req.body.waId || uuid();
  const waId = (req.body.waId || req.body.id || id || '').toString();
  const waDigits = digitsOnly(waId.match(/^(\d+)@/)?.[1] || '');
  let number = digitsOnly(req.body.number);
  if (!number && waId.includes('@c.us') && waDigits) number = waDigits;
  if ((!number || (waDigits && number === waDigits)) && waId.includes('@lid')) {
    const fromName = extractPhoneDigits(req.body.name);
    if (fromName && (!waDigits || fromName !== waDigits)) number = fromName;
  }
  const contact = { ...req.body, waId: waId || req.body.waId, number: number || null, sessionId: req.params.sessionId, id, updatedAt: new Date().toISOString() };
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx >= 0) contacts[idx] = contact; else contacts.push(contact);
  db.save('contacts', contacts); json(res, contact);
});

// ── Scheduled ─────────────────────────────────────────────────────────
route('GET', '/api/scheduled/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return json(res, []);
  json(res, db.load('scheduled_messages').filter(s => s.sessionId === req.params.sessionId));
});

route('POST', '/api/scheduled', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId } = req.body || {};
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const scheduled = db.load('scheduled_messages');
  const item = { ...req.body, id: req.body.id || uuid(), sent: false, createdAt: new Date().toISOString() };
  scheduled.push(item); db.save('scheduled_messages', scheduled); json(res, item);
});

route('POST', '/api/scheduled/group-bulk', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, targets, payloadType, message, flowId, startTime } = req.body || {};
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  const ids = Array.isArray(targets) ? targets.map(x => (x || '').toString()).filter(Boolean) : [];
  if (!ids.length) return err(res, 'Selecione pelo menos 1 grupo');
  const st = Number(startTime || 0);
  if (!st || !Number.isFinite(st)) return err(res, 'startTime inválido');
  const kind = 'group_bulk';
  const minDelay = 40;
  const maxDelay = 180;
  if (payloadType === 'flow' && !flowId) return err(res, 'flowId requerido');
  if ((payloadType || 'text') !== 'flow' && !(message || '').toString().trim()) return err(res, 'Mensagem vazia');
  const item = {
    id: uuid(),
    sessionId,
    kind,
    payloadType: payloadType === 'flow' ? 'flow' : 'text',
    message: payloadType === 'flow' ? undefined : (message || '').toString(),
    flowId: payloadType === 'flow' ? flowId : undefined,
    targets: ids,
    startTime: st,
    nextIndex: 0,
    nextSendTime: st,
    minDelay,
    maxDelay,
    endTimeLatest: st + (ids.length * maxDelay),
    sent: false,
    createdAt: new Date().toISOString()
  };
  const scheduled = db.load('scheduled_messages');
  scheduled.push(item);
  db.save('scheduled_messages', scheduled);
  json(res, item);
});

route('DELETE', '/api/scheduled/:id', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  let items = db.load('scheduled_messages');
  const found = items.find(x => x.id === req.params.id);
  if (!found) return json(res, { ok: true });
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === found.sessionId);
  if (!sess || (sess.userId !== u.id && u.role !== 'admin')) return err(res, 'Forbidden', 403);
  items = items.filter(x => x.id !== req.params.id);
  db.save('scheduled_messages', items);
  json(res, { ok: true });
});

// ── WinBack ───────────────────────────────────────────────────────────
route('GET', '/api/winback/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  json(res, db.load('winback_campaigns').filter(c => c.sessionId === req.params.sessionId));
});

route('POST', '/api/winback', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const campaigns = db.load('winback_campaigns');
  const campaign = { ...req.body, id: req.body.id || uuid(), createdAt: new Date().toISOString() };
  const idx = campaigns.findIndex(c => c.id === campaign.id);
  if (idx >= 0) campaigns[idx] = campaign; else campaigns.push(campaign);
  db.save('winback_campaigns', campaigns); json(res, campaign);
});

route('DELETE', '/api/winback/:id', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  let c = db.load('winback_campaigns');
  db.save('winback_campaigns', c.filter(x => x.id !== req.params.id)); json(res, { ok: true });
});

// ── Stats ─────────────────────────────────────────────────────────────
route('GET', '/api/stats/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = req.params.sessionId;
  const scheduled = db.load('scheduled_messages').filter(s => s.sessionId === sid);
  const campaigns = db.load('winback_campaigns').filter(c => c.sessionId === sid);
  const flows = db.load('flows', {})[sid] || [];
  json(res, { scheduledTotal: scheduled.length, scheduledSent: scheduled.filter(s => s.sent).length, campaignsTotal: campaigns.length, campaignsActive: campaigns.filter(c => c.active).length, flowsTotal: flows.length, flowsActive: flows.filter(f => f.active).length, isConnected: waStatus.get(sid) === 'connected' });
});

route('POST', '/api/send-bulk', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, contacts, message, interval = 3000 } = req.body;
  const client = waClients.get(sessionId);
  if (!client?.info) return err(res, 'Not connected');
  json(res, { ok: true, total: contacts.length });
  (async () => {
    for (const c of contacts) {
      try { await client.sendMessage(c.id || c, message); await new Promise(r => setTimeout(r, interval + Math.random() * 2000)); } catch {}
    }
  })();
});

// ── Generic DB ────────────────────────────────────────────────────────
route('GET', '/api/db/:file', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  json(res, db.load(req.params.file));
});
route('POST', '/api/db/:file', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  db.save(req.params.file, req.body); json(res, { ok: true });
});

// ══════════════════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════════════
const httpServer = createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // API routes
  if (url.startsWith('/api/')) {
    const match = matchRoute(req.method, url);
    if (match) {
      req.params = match.params;
      req.body = await parseBody(req);
      try { await match.handler(req, res); }
      catch (e) { console.error('Route error:', e); err(res, e.message, 500); }
      return;
    }
    err(res, 'Not found', 404); return;
  }

  if (url.startsWith('/wa-media/')) {
    const rel = url.slice('/wa-media/'.length);
    const abs = safePathFromUrl(WA_MEDIA_DIR, rel);
    if (!abs || !existsSync(abs) || (statSync(abs)?.isDirectory?.() ?? false)) { res.writeHead(404); res.end('Not found'); return; }
    serveFilePath(req, res, abs);
    return;
  }

  if (url.startsWith('/chat-media/')) {
    const rel = url.slice('/chat-media/'.length);
    const abs = safePathFromUrl(CHAT_MEDIA_DIR, rel);
    if (!abs || !existsSync(abs) || (statSync(abs)?.isDirectory?.() ?? false)) { res.writeHead(404); res.end('Not found'); return; }
    serveFilePath(req, res, abs);
    return;
  }

  // Static files
  serveStatic(req, res);
});

// ══════════════════════════════════════════════════════════════════════
//  SOCKET.IO (if available)
// ══════════════════════════════════════════════════════════════════════
let io = null;
if (hasSocket) {
  io = new Server(httpServer, { cors: { origin: '*' }, maxHttpBufferSize: 1e8 });
  io.on('connection', (socket) => {
    socket.on('join', id => socket.join(id));
    socket.on('bind-session', id => socket.join(id));
    socket.on('get-chats', async ({ sessionId }) => {
      const client = waClients.get(sessionId);
      if (!client?.info) return socket.emit('chats-loaded', []);
      try {
        const chats = await client.getChats();
        socket.emit('chats-loaded', chats.slice(0, 60).map(c => ({ id: c.id._serialized, name: c.name || c.id.user, isGroup: c.isGroup, unread: c.unreadCount || 0, timestamp: c.timestamp })));
      } catch { socket.emit('chats-loaded', []); }
    });
    socket.on('get-chat-history', ({ sessionId, chatId }) => {
      socket.emit('chat-history', { chatId, history: getHistory(sessionId, chatId) });
    });
    socket.on('send-message', async ({ sessionId, chatId, content }) => {
      const client = waClients.get(sessionId);
      if (client?.info) try { await client.sendMessage(chatId, content); } catch {}
    });
    socket.on('get-kanban-columns', ({ sessionId }) => {
      const kanban = db.load('kanban', {});
      socket.emit('kanban-columns', kanban[sessionId]?.columns || []);
    });
    socket.on('save-ai-config', ({ sessionId, config }) => {
      const aiConfig = db.load('ai_config', {});
      aiConfig[sessionId] = { ...aiConfig[sessionId], ...config };
      db.save('ai_config', aiConfig);
    });
    socket.on('get-ai-config', ({ sessionId }) => {
      const config = db.load('ai_config', {});
      socket.emit('ai-config-data', config[sessionId] || { enabled: false });
    });
  });
  console.log('✅ Socket.IO initialized');
} else {
  // Minimal WebSocket fallback using Node's http upgrade
  console.log('⚠️  Socket.IO not available - using polling fallback');
}

// ══════════════════════════════════════════════════════════════════════
//  WHATSAPP
// ══════════════════════════════════════════════════════════════════════
function addToHistory(sessionId, chatId, msg) {
  const key = `${sessionId}:${chatId}`;
  if (!chatHistory.has(key)) chatHistory.set(key, []);
  const hist = chatHistory.get(key);
  const msgId = msg?.id;
  if (msgId) {
    for (let i = hist.length - 1; i >= 0 && i >= hist.length - 60; i--) {
      if (hist[i]?.id === msgId) return;
    }
  }
  hist.push(msg);
  if (hist.length > 100) hist.shift();
  const histDir = join(DATA, 'history');
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
  const fp = join(histDir, `${sessionId}_${chatId.replace(/\W/g, '_')}.json`);
  try {
    let existing = existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : [];
    if (msgId) {
      for (let i = existing.length - 1; i >= 0 && i >= existing.length - 120; i--) {
        if (existing[i]?.id === msgId) return;
      }
    }
    existing.push(msg);
    if (existing.length > 500) existing = existing.slice(-500);
    writeFileSync(fp, JSON.stringify(existing, null, 2));
  } catch {}
}

function getHistory(sessionId, chatId) {
  const key = `${sessionId}:${chatId}`;
  if (chatHistory.has(key)) return chatHistory.get(key);
  const fp = join(DATA, 'history', `${sessionId}_${chatId.replace(/\W/g, '_')}.json`);
  if (existsSync(fp)) {
    try { const d = JSON.parse(readFileSync(fp, 'utf8')); chatHistory.set(key, d); return d; } catch {}
  }
  return [];
}

function persistHistory(sessionId, chatId, hist) {
  const key = `${sessionId}:${chatId}`;
  const next = Array.isArray(hist) ? hist.slice(-500) : [];
  chatHistory.set(key, next);
  const histDir = join(DATA, 'history');
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
  const fp = join(histDir, `${sessionId}_${chatId.replace(/\W/g, '_')}.json`);
  try { writeFileSync(fp, JSON.stringify(next, null, 2)); } catch {}
}

function waSafePart(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'x';
}
function waGuessExt(mime, fallbackName) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  const fb = extname(String(fallbackName || '')).toLowerCase();
  if (fb) return fb;
  if (m === 'audio/webm') return '.webm';
  if (m === 'video/webm') return '.webm';
  if (m === 'audio/opus') return '.opus';
  if (m === 'audio/ogg') return '.ogg';
  if (m === 'audio/mpeg') return '.mp3';
  if (m === 'audio/mp4') return '.m4a';
  if (m === 'audio/wav') return '.wav';
  if (m === 'image/jpeg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'video/mp4') return '.mp4';
  if (m === 'application/pdf') return '.pdf';
  if (m.startsWith('text/')) return '.txt';
  return '';
}
function waKindFromMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}
function saveWAMediaToPublic(sessionId, chatId, msgId, media) {
  const mime = (media?.mimetype || '').toString();
  const filename = (media?.filename || '').toString();
  const ext = waGuessExt(mime, filename);
  const safeSession = waSafePart(sessionId);
  const safeChat = waSafePart(chatId);
  const safeMsg = waSafePart(msgId);
  const baseName = safeMsg + (ext || '');
  const rel = join('wa-media', safeSession, safeChat, baseName).replace(/\\/g, '/');
  const abs = join(WA_MEDIA_DIR, safeSession, safeChat, baseName);
  const dir = dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const buf = Buffer.from((media?.data || '').toString(), 'base64');
  writeFileSync(abs, buf);
  return { url: '/' + rel, mime, filename: filename || baseName, size: buf.length, kind: waKindFromMime(mime) };
}

async function initWhatsApp(sessionId, userId) {
  if (!hasWA) return;
  if (waInitLocks.has(sessionId)) return;
  if (waClients.has(sessionId)) return;
  const lock = (async () => {
    console.log(`🔄 Init WA session: ${sessionId}`);
    waStatus.set(sessionId, 'initializing');
    if (!Client || !LocalAuth) {
      waStatus.set(sessionId, 'error');
      const payload = { sessionId, error: 'WhatsApp-Web.js não carregou LocalAuth/Client (verifique a instalação do pacote)' };
      if (io) {
        io.to(userId).emit('wa-error', payload);
        io.to(sessionId).emit('wa-error', payload);
      }
      return;
    }
    const headlessEnv = (process.env.WA_HEADLESS ?? '').toString().trim().toLowerCase();
    const headless = headlessEnv ? !(headlessEnv === 'false' || headlessEnv === '0' || headlessEnv === 'no') : true;
    const executablePath = (process.env.WA_CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
    const puppeteerOpts = { headless, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
    if (executablePath) puppeteerOpts.executablePath = executablePath;
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: WA_AUTH_DIR, rmMaxRetries: 50 }),
      puppeteer: puppeteerOpts
    });
    client.on('qr', async (qr) => {
      waStatus.set(sessionId, 'qr');
      const qrImg = qrcode ? await qrcode.toDataURL(qr) : '';
      if (qrImg) waLastQr.set(sessionId, { qr: qrImg, ts: Date.now() });
      if (io) io.to(sessionId).emit('qr', { sessionId, qr: qrImg });
    });
    client.on('ready', () => {
      waStatus.set(sessionId, 'connected');
      waLastQr.delete(sessionId);
      if (io) io.to(sessionId).emit('ready', { sessionId });
      const sessions = db.load('sessions');
      const s = sessions.find(x => x.id === sessionId);
      if (s) { s.status = 'connected'; db.save('sessions', sessions); }
    });
    client.on('disconnected', (reason) => {
      waStatus.set(sessionId, 'disconnected');
      waClients.delete(sessionId);
      waLastQr.delete(sessionId);
      if (io) io.to(sessionId).emit('disconnected', { sessionId, reason });
    });
  client.on('message', async (msg) => {
    const chatId = msg.from;
    const msgData = { id: msg.id.id, body: msg.body, fromMe: false, timestamp: msg.timestamp, type: msg.type };
    if (msg.hasMedia && hasWA && MessageMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media?.data) {
          msgData.media = saveWAMediaToPublic(sessionId, chatId, msg.id.id, media);
          if (!msgData.body) msgData.body = (msgData.media?.filename || '').toString();
        }
      } catch {}
    }
    addToHistory(sessionId, chatId, msgData);
    if (io) io.to(sessionId).emit('new-message', { sessionId, chatId, message: msgData });
    if (!msg.fromMe) {
      handleFlows(sessionId, chatId, msg, client, userId).catch(() => {});
      handleAIDebounced(sessionId, userId, chatId, msg, client);
    }
  });
  client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    const msgData = { id: msg.id.id, body: msg.body, fromMe: true, timestamp: msg.timestamp, type: msg.type };
    if (msg.hasMedia && hasWA && MessageMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media?.data) {
          msgData.media = saveWAMediaToPublic(sessionId, msg.to, msg.id.id, media);
          if (!msgData.body) msgData.body = (msgData.media?.filename || '').toString();
        }
      } catch {}
    }
    addToHistory(sessionId, msg.to, msgData);
    if (io) io.to(sessionId).emit('new-message', { sessionId, chatId: msg.to, message: msgData });
  });
    client.initialize().catch(e => { 
      console.error('WA init error:', e?.message || e);
      waStatus.set(sessionId, 'error');
      waClients.delete(sessionId);
      waLastQr.delete(sessionId);
      if (io) {
        const payload = { sessionId, error: e?.message || 'Falha ao inicializar WhatsApp' };
        io.to(sessionId).emit('wa-error', payload);
      }
    });
    waClients.set(sessionId, client);
  })().finally(() => waInitLocks.delete(sessionId));
  waInitLocks.set(sessionId, lock);
}

function getFlowRunsStore() {
  return db.load('flow_runs', {});
}
function saveFlowRunsStore(store) {
  db.save('flow_runs', store);
}
function getChatRuns(store, sessionId, chatId) {
  if (!store[sessionId]) store[sessionId] = {};
  if (!store[sessionId][chatId]) store[sessionId][chatId] = [];
  return store[sessionId][chatId];
}
function setChatRuns(store, sessionId, chatId, runs) {
  if (!store[sessionId]) store[sessionId] = {};
  store[sessionId][chatId] = runs;
}
function getNextNodeId(flow, fromNodeId, fromPort = 'next') {
  const e = (flow.edges || []).find(x => x.from === fromNodeId && x.fromPort === fromPort);
  return e?.to || null;
}
function getNode(flow, nodeId) {
  return (flow.nodes || []).find(n => n.id === nodeId) || null;
}
function getStartNode(flow) {
  return (flow.nodes || []).find(n => n.type === 'start') || null;
}
function dayKeyFromTs(tsSec) {
  const ms = Number(tsSec || 0) * 1000;
  const d = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}
function isFirstInboundMessageOfDay(sessionId, chatId, tsSec) {
  const key = dayKeyFromTs(tsSec);
  const hist = getHistory(sessionId, chatId);
  let inbound = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (!h) continue;
    if (h.fromMe) continue;
    if (dayKeyFromTs(h.timestamp || 0) !== key) continue;
    inbound += 1;
    if (inbound > 1) return false;
  }
  return inbound === 1;
}
function matchStartTrigger(startNode, sessionId, chatId, msg) {
  const d = startNode?.data || {};
  const t = d.trigger || 'keyword';
  if (t === 'manual') return false;
  if (t === 'any') return true;
  if (t === 'first_message') return getHistory(sessionId, chatId).length === 1;
  if (t === 'first_message_day') return isFirstInboundMessageOfDay(sessionId, chatId, msg?.timestamp || Math.floor(Date.now() / 1000));
  if (t === 'keyword') {
    const kw = (d.keyword || '').trim().toLowerCase();
    if (!kw) return false;
    return (msg.body || '').toLowerCase().includes(kw);
  }
  return false;
}
function matchWait(wait, msg) {
  if (!wait) return false;
  if (wait.mode === 'any') return true;
  if (wait.mode === 'contains') {
    const needle = (wait.text || '').trim().toLowerCase();
    if (!needle) return true;
    return (msg.body || '').toLowerCase().includes(needle);
  }
  return false;
}

async function executeVisualRun(sessionId, chatId, flow, client, run) {
  const assets = db.load('flow_assets', {})[sessionId] || [];
  const assetMap = new Map(assets.map(a => [a.id, a]));
  let steps = 0;
  while (run.nodeId && steps < 80) {
    steps += 1;
    const node = getNode(flow, run.nodeId);
    if (!node) { run.status = 'done'; run.nodeId = null; break; }
    const d = node.data || {};
    if (node.type === 'start') {
      run.nodeId = getNextNodeId(flow, node.id, 'next');
      continue;
    }
    if (node.type === 'delay') {
      const sec = Math.max(0, Number(d.seconds || 0));
      if (sec) await new Promise(r => setTimeout(r, sec * 1000));
      run.nodeId = getNextNodeId(flow, node.id, 'next');
      continue;
    }
    if (node.type === 'send_text') {
      const sec = Math.max(0, Number(d.delaySec || 0));
      if (sec) await new Promise(r => setTimeout(r, sec * 1000));
      const text = (d.text || '').toString();
      if (text.trim()) {
        try { await client.sendMessage(chatId, text); } catch {}
      }
      run.nodeId = getNextNodeId(flow, node.id, 'next');
      continue;
    }
    if (node.type === 'send_media') {
      const sec = Math.max(0, Number(d.delaySec || 0));
      if (sec) await new Promise(r => setTimeout(r, sec * 1000));
      const record = Math.max(0, Number(d.recordSec || 0));
      if (record) await new Promise(r => setTimeout(r, record * 1000));
      const assetId = (d.assetId || '').toString();
      const asset = assetMap.get(assetId);
      if (asset && hasWA && MessageMedia) {
        try {
          const abs = join(ROOT, 'Public', asset.url.replace(/^\//, ''));
          if (existsSync(abs)) {
            const media = MessageMedia.fromFilePath(abs);
            const options = {};
            const caption = (d.caption || '').toString();
            if (caption.trim()) options.caption = caption;
            if (d.sendAsVoice) options.sendAudioAsVoice = true;
            await client.sendMessage(chatId, media, options);
          }
        } catch {}
      }
      run.nodeId = getNextNodeId(flow, node.id, 'next');
      continue;
    }
    if (node.type === 'wait_reply') {
      const mode = d.mode === 'contains' ? 'contains' : 'any';
      const followupEnabled = d.followupEnabled !== false;
      const timeoutSec = Math.max(0, Number(d.timeoutSec || 0));
      const now = Math.floor(Date.now() / 1000);
      const receivedNext = getNextNodeId(flow, node.id, 'received');
      const timeoutNext = getNextNodeId(flow, node.id, 'timeout');
      if (!receivedNext && !(followupEnabled && timeoutSec && timeoutNext)) {
        run.status = 'done';
        run.nodeId = null;
        run.wait = null;
        break;
      }
      run.status = 'waiting';
      run.wait = {
        mode,
        text: (d.text || '').toString(),
        followupEnabled,
        waitUntil: (followupEnabled && timeoutSec && timeoutNext) ? now + timeoutSec : null,
        receivedNext,
        timeoutNext
      };
      run.nodeId = null;
      return run;
    }
    if (node.type === 'run_flow') {
      const flowId = (d.flowId || '').toString().trim();
      if (flowId) {
        try { await executeNestedFlow(sessionId, chatId, flowId, client, 0); } catch {}
      }
      run.nodeId = getNextNodeId(flow, node.id, 'next');
      continue;
    }
    if (node.type === 'end') {
      run.status = 'done';
      run.nodeId = null;
      break;
    }
    run.nodeId = getNextNodeId(flow, node.id, 'next');
  }
  if (steps >= 80) { run.status = 'done'; run.nodeId = null; run.wait = null; }
  if (!run.nodeId && run.status !== 'waiting') { run.status = 'done'; run.wait = null; }
  return run;
}

async function executeNestedFlow(sessionId, chatId, flowId, client, depth) {
  if (depth >= 2) return;
  const flowsAll = db.load('flows', {})[sessionId] || [];
  const flow = flowsAll.find(f => f.id === flowId);
  if (!flow || !flow.active) return;
  if (Array.isArray(flow.nodes) && Array.isArray(flow.edges)) {
    const start = getStartNode(flow);
    if (!start) return;
    const startNext = getNextNodeId(flow, start.id, 'next');
    if (!startNext) return;
    const run = { id: uuid(), flowId: flow.id, status: 'running', nodeId: startNext, wait: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await executeVisualRun(sessionId, chatId, flow, client, run);
  } else {
    for (const step of (flow.steps || [])) {
      if (step.delay) await new Promise(r => setTimeout(r, step.delay * 1000));
      if (step.type === 'message' && step.content) {
        try { await client.sendMessage(chatId, step.content); } catch {}
      }
    }
  }
}

async function startFlowById(sessionId, chatId, flowId, client) {
  const flowsAll = db.load('flows', {})[sessionId] || [];
  const flow = flowsAll.find(f => f.id === flowId);
  if (!flow || !flow.active) return;

  if (Array.isArray(flow.nodes) && Array.isArray(flow.edges)) {
    const store0 = getFlowRunsStore();
    const existing0 = getChatRuns(store0, sessionId, chatId).filter(r => r.status !== 'done');
    if (existing0.length) return;
    const start = getStartNode(flow);
    if (!start) return;
    const startNext = getNextNodeId(flow, start.id, 'next');
    if (!startNext) return;
    const run = { id: uuid(), flowId: flow.id, status: 'running', nodeId: startNext, wait: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const store = getFlowRunsStore();
    const runs = getChatRuns(store, sessionId, chatId);
    runs.push(run);
    saveFlowRunsStore(store);
    const updated = await executeVisualRun(sessionId, chatId, flow, client, run);
    const store2 = getFlowRunsStore();
    const runs2 = getChatRuns(store2, sessionId, chatId);
    const idx = runs2.findIndex(r => r.id === run.id);
    if (idx >= 0) {
      if (updated.status === 'done') runs2.splice(idx, 1);
      else runs2[idx] = updated;
    }
    saveFlowRunsStore(store2);
    return;
  }

  for (const step of (flow.steps || [])) {
    if (step.delay) await new Promise(r => setTimeout(r, step.delay * 1000));
    if (step.type === 'message' && step.content) {
      try { await client.sendMessage(chatId, step.content); } catch {}
    }
  }
}

async function handleFlows(sessionId, chatId, msg, client, userId) {
  const store = getFlowRunsStore();
  const runs = getChatRuns(store, sessionId, chatId);
  const flowsAll = db.load('flows', {})[sessionId] || [];

  let consumedByWait = false;
  const waiting = runs.filter(r => r.status === 'waiting' && r.wait);
  for (const run of waiting) {
    const flow = flowsAll.find(f => f.id === run.flowId);
    if (!flow || !flow.active || !Array.isArray(flow.nodes)) continue;
    if (matchWait(run.wait, msg)) {
      consumedByWait = true;
      if (!run.wait.receivedNext) {
        run.status = 'done';
        run.nodeId = null;
        run.wait = null;
      } else {
        run.status = 'running';
        run.nodeId = run.wait.receivedNext;
        run.wait = null;
        run.updatedAt = new Date().toISOString();
        await executeVisualRun(sessionId, chatId, flow, client, run);
        run.updatedAt = new Date().toISOString();
      }
    }
  }
  const nextRuns = runs.filter(r => r.status !== 'done');
  setChatRuns(store, sessionId, chatId, nextRuns);
  saveFlowRunsStore(store);
  if (consumedByWait) return;
  if (nextRuns.length) return;

  const candidates = [];
  const ts = msg?.timestamp || Math.floor(Date.now() / 1000);

  function scoreTrigger(t) {
    if (t === 'keyword') return 3;
    if (t === 'first_message_day') return 2;
    if (t === 'first_message') return 1;
    if (t === 'any') return 0;
    return -1;
  }

  for (const flow of flowsAll.filter(f => f.active)) {
    if (Array.isArray(flow.nodes) && Array.isArray(flow.edges)) {
      const start = getStartNode(flow);
      if (!start) continue;
      const t = (start?.data?.trigger || 'keyword').toString();
      if (t === 'manual') continue;
      let ok = false;
      let kwLen = 0;
      if (t === 'keyword') {
        const kw = (start?.data?.keyword || '').toString().trim().toLowerCase();
        if (kw && (msg.body || '').toLowerCase().includes(kw)) { ok = true; kwLen = kw.length; }
      } else if (t === 'first_message') {
        ok = getHistory(sessionId, chatId).length === 1;
      } else if (t === 'first_message_day') {
        ok = isFirstInboundMessageOfDay(sessionId, chatId, ts);
      } else if (t === 'any') {
        ok = true;
      }
      if (!ok) continue;
      candidates.push({ flow, kind: 'visual', score: scoreTrigger(t), kwLen });
      continue;
    }

    const t = (flow.trigger || 'keyword').toString();
    if (t === 'manual') continue;
    let ok = false;
    let kwLen = 0;
    if (t === 'keyword') {
      const kw = (flow.keyword || '').toString().trim().toLowerCase();
      if (kw && (msg.body || '').toLowerCase().includes(kw)) { ok = true; kwLen = kw.length; }
    } else if (t === 'first_message') {
      ok = getHistory(sessionId, chatId).length === 1;
    } else if (t === 'first_message_day') {
      ok = isFirstInboundMessageOfDay(sessionId, chatId, ts);
    } else if (t === 'any') {
      ok = true;
    }
    if (!ok) continue;
    candidates.push({ flow, kind: 'legacy', score: scoreTrigger(t), kwLen });
  }

  if (!candidates.length) return;
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.kwLen !== a.kwLen) return b.kwLen - a.kwLen;
    const at = Date.parse(a.flow?.createdAt || '') || 0;
    const bt = Date.parse(b.flow?.createdAt || '') || 0;
    if (at && bt && at !== bt) return at - bt;
    return String(a.flow?.id || '').localeCompare(String(b.flow?.id || ''));
  });

  const chosen = candidates[0];
  if (chosen.kind === 'visual') {
    const start = getStartNode(chosen.flow);
    const startNext = start ? getNextNodeId(chosen.flow, start.id, 'next') : null;
    if (!startNext) return;
    const run = { id: uuid(), flowId: chosen.flow.id, status: 'running', nodeId: startNext, wait: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const store2 = getFlowRunsStore();
    const runs2 = getChatRuns(store2, sessionId, chatId);
    runs2.push(run);
    saveFlowRunsStore(store2);
    const updated = await executeVisualRun(sessionId, chatId, chosen.flow, client, run);
    const store3 = getFlowRunsStore();
    const runs3 = getChatRuns(store3, sessionId, chatId);
    const idx = runs3.findIndex(r => r.id === run.id);
    if (idx >= 0) {
      if (updated.status === 'done') runs3.splice(idx, 1);
      else runs3[idx] = updated;
    }
    saveFlowRunsStore(store3);
    return;
  }

  for (const step of (chosen.flow.steps || [])) {
    if (step.delay) await new Promise(r => setTimeout(r, step.delay * 1000));
    if (step.type === 'message' && step.content) {
      try { await client.sendMessage(chatId, step.content); } catch {}
    }
  }
}

async function processFlowRunTimeouts() {
  const store = getFlowRunsStore();
  let changed = false;
  const now = Math.floor(Date.now() / 1000);
  const flowsAll = db.load('flows', {});
  for (const [sessionId, chats] of Object.entries(store)) {
    const flows = flowsAll[sessionId] || [];
    for (const [chatId, runs] of Object.entries(chats || {})) {
      for (const run of (runs || [])) {
        if (run.status !== 'waiting' || !run.wait || !run.wait.waitUntil) continue;
        if (now < run.wait.waitUntil) continue;
        const flow = flows.find(f => f.id === run.flowId);
        if (!flow || !flow.active || !Array.isArray(flow.nodes)) { run.status = 'done'; run.wait = null; changed = true; continue; }
        const client = waClients.get(sessionId);
        if (!client?.info) continue;
        if (!run.wait.timeoutNext) {
          run.status = 'done';
          run.nodeId = null;
          run.wait = null;
          run.updatedAt = new Date().toISOString();
          changed = true;
        } else {
          run.status = 'running';
          run.nodeId = run.wait.timeoutNext;
          run.wait = null;
          run.updatedAt = new Date().toISOString();
          await executeVisualRun(sessionId, chatId, flow, client, run);
          run.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      chats[chatId] = (chats[chatId] || []).filter(r => r.status !== 'done');
      if (!chats[chatId].length) delete chats[chatId];
    }
  }
  if (changed) saveFlowRunsStore(store);
}

setInterval(() => { processFlowRunTimeouts().catch(() => {}); }, 2500);

function handleAIDebounced(sessionId, userId, chatId, msg, client) {
  const key = `${sessionId}:${chatId}`;
  if (pendingAI.has(key)) clearTimeout(pendingAI.get(key));
  const t = setTimeout(() => { pendingAI.delete(key); handleAI(sessionId, userId, chatId, msg, client); }, 2000);
  pendingAI.set(key, t);
}

async function handleAI(sessionId, userId, chatId, msg, client) {
  if (!hasOpenAI) return;
  const key = `${sessionId}:${chatId}`;
  if (aiInFlight.has(key)) return;
  const config = getAIConfig(sessionId);
  const chatStatuses = db.load('ai_chat_status', {});
  const override = getAIChatOverride(chatStatuses, sessionId, chatId);
  if (!shouldAIRespond(config, override, msg)) return;
  if (!config.apiKey && !process.env.OPENAI_API_KEY) return;
  if (msg?.type && ['e2e_notification', 'notification_template'].includes(String(msg.type))) return;
  aiInFlight.set(key, true);
  try {
    const apiKey = (config.apiKey || process.env.OPENAI_API_KEY || '').toString();
    const openai = new OpenAI({ apiKey });

    let userText = (msg?.body || '').toString().trim();
    let imageDataUrl = '';

    if (msg?.hasMedia && hasWA && MessageMedia) {
      try {
        const media = await msg.downloadMedia();
        const mime = (media?.mimetype || '').toString();
        const dataB64 = (media?.data || '').toString();
        if (mime.startsWith('audio/') && config.allowAudio) {
          const buf = Buffer.from(dataB64, 'base64');
          const tr = await openaiTranscribeAudio(apiKey, buf, mime).catch(() => '');
          if (tr.trim()) userText = userText ? `${userText}\n\n[ÁUDIO TRANSCRITO]\n${tr.trim()}` : tr.trim();
          else userText = userText ? `${userText}\n\n[Áudio recebido]` : '[Áudio recebido]';
        } else if (mime.startsWith('image/') && config.allowImages) {
          imageDataUrl = `data:${mime};base64,${dataB64}`;
          if (!userText) userText = '[Imagem recebida]';
        } else if (mime.startsWith('video/')) {
          userText = userText ? `${userText}\n\n[Vídeo recebido]` : '[Vídeo recebido]';
        } else if (dataB64) {
          userText = userText ? `${userText}\n\n[Arquivo recebido]` : '[Arquivo recebido]';
        }
      } catch {}
    }

    if (!userText) userText = '[Mensagem recebida]';

    appendAITranscript(sessionId, chatId, 'user', userText);

    const internal = [
      'Você é um atendente humano profissional no WhatsApp. Nunca diga que é IA.',
      'Seja objetivo, cordial e proativo. Faça no máximo 1 pergunta por vez.',
      'Evite repetir perguntas já respondidas; use o histórico.',
      'Quando faltar informação essencial, pergunte de forma natural.',
      'Se o usuário pedir para falar com humano, pare e responda confirmando.',
      'Não invente dados. Se não souber, peça esclarecimento.',
      'Responda em português do Brasil.'
    ].join('\n');

    const important = (config.important || '').toString().trim();
    const systemPrompt = ((config.prompt || '').toString().trim() || 'Você é um assistente comercial profissional.');
    const system = `${systemPrompt}\n\n[INFORMAÇÕES IMPORTANTES]\n${important || '(nenhuma)'}\n\n[REGRAS INTERNAS]\n${internal}`;

    const memory = getAITranscript(sessionId, chatId, 24).map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: x.content }));
    const waHist = getHistory(sessionId, chatId).slice(-14).map(m => ({ role: m.fromMe ? 'assistant' : 'user', content: (m.body || '').toString() })).filter(m => m.content);

    const messages = [{ role: 'system', content: system }, ...memory, ...waHist];

    if (imageDataUrl) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: 'user', content: userText });
    }

    const delay = randInt(clampInt(config.delayMinMs, 0, 300000, 1500), clampInt(config.delayMaxMs, 0, 300000, 3500));
    if (delay) await sleep(delay);

    const response = await openai.chat.completions.create({
      model: (config.model || 'gpt-4o-mini').toString(),
      messages,
      max_tokens: 500
    });

    const reply = (response?.choices?.[0]?.message?.content || '').toString().trim();
    if (!reply) return;

    const parts = splitAIReply(reply, config);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      await client.sendMessage(chatId, part);
      appendAITranscript(sessionId, chatId, 'assistant', part);
      if (io) io.to(sessionId).emit('ai-replied', { sessionId, chatId, reply: part, part: i + 1, total: parts.length });
      if (i < parts.length - 1) await sleep(randInt(clampInt(config.partDelayMinMs, 0, 60000, 600), clampInt(config.partDelayMaxMs, 0, 60000, 1600)));
    }
  } catch (e) {
    console.error('AI error:', e?.message || e);
  } finally {
    aiInFlight.delete(key);
  }
}

// ── Scheduled messages cron ───────────────────────────────────────────
if (hasCron) {
  function randInt(min, max) {
    const a = Math.floor(Number(min || 0));
    const b = Math.floor(Number(max || 0));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return a;
    return a + Math.floor(Math.random() * (b - a + 1));
  }

  async function sendScheduledPayload(item, client, chatId) {
    const payloadType = item.payloadType || (item.flowId ? 'flow' : 'text');
    if (payloadType === 'flow') {
      const flowId = item.flowId;
      if (flowId) await startFlowById(item.sessionId, chatId, flowId, client);
      return;
    }
    const message = (item.message ?? item.msg ?? '').toString();
    if (!message.trim()) return;
    try { await client.sendMessage(chatId, message); } catch {}
  }

  cron.schedule('*/10 * * * * *', async () => {
    const now = Math.floor(Date.now() / 1000);
    const scheduled = db.load('scheduled_messages');
    let changed = false;

    for (const s of scheduled) {
      if (s.sent) continue;
      const client = waClients.get(s.sessionId);
      if (!client?.info) continue;

      if (s.kind === 'group_bulk') {
        const targets = Array.isArray(s.targets) ? s.targets : [];
        if (!targets.length) { s.sent = true; s.sentAt = new Date().toISOString(); changed = true; continue; }
        const nextIdx = Number.isFinite(Number(s.nextIndex)) ? Number(s.nextIndex) : 0;
        const nextSend = Number.isFinite(Number(s.nextSendTime)) ? Number(s.nextSendTime) : Number(s.startTime || 0);
        if (!nextSend || now < nextSend) continue;
        if (nextIdx >= targets.length) {
          s.sent = true;
          s.sentAt = new Date().toISOString();
          s.completedAt = s.sentAt;
          changed = true;
          if (io) io.to(s.sessionId).emit('scheduled-sent', s);
          continue;
        }
        const chatId = targets[nextIdx];
        await sendScheduledPayload(s, client, chatId);
        s.nextIndex = nextIdx + 1;
        s.lastSentTo = chatId;
        s.lastSentAt = new Date().toISOString();
        if (s.nextIndex >= targets.length) {
          s.sent = true;
          s.sentAt = s.lastSentAt;
          s.completedAt = s.sentAt;
          changed = true;
          if (io) io.to(s.sessionId).emit('scheduled-sent', s);
          continue;
        }
        const minDelay = Number.isFinite(Number(s.minDelay)) ? Number(s.minDelay) : 40;
        const maxDelay = Number.isFinite(Number(s.maxDelay)) ? Number(s.maxDelay) : 180;
        s.nextSendTime = now + randInt(Math.max(40, minDelay), Math.max(Math.max(40, minDelay), maxDelay));
        changed = true;
        continue;
      }

      const when = Number(s.scheduledTime || s.startTime || 0);
      if (!when || when > now) continue;
      const to = s.to || s.targetId || s.chatId || s.target;
      if (!to) { s.sent = true; s.sentAt = new Date().toISOString(); changed = true; continue; }
      await sendScheduledPayload(s, client, to);
      s.sent = true;
      s.sentAt = new Date().toISOString();
      changed = true;
      if (io) io.to(s.sessionId).emit('scheduled-sent', s);
    }

    if (changed) db.save('scheduled_messages', scheduled);
  });
  console.log('✅ Cron scheduler initialized');
}

// ── Restore sessions on startup ───────────────────────────────────────
async function restoreSessions() {
  const flag = ((process.env.WA_RESTORE_SESSIONS || '') + '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'no') return;
  if (!hasWA) return;
  const authPath = WA_AUTH_DIR;
  if (!existsSync(authPath)) return;
  const sessions = db.load('sessions');
  for (const session of sessions) {
    const sessionPath = join(authPath, `session-${session.id}`);
    if (!existsSync(sessionPath)) continue;
    if (!['connected', 'initializing', 'qr'].includes(session.status)) continue;
    try {
      killBrowserProcessesForSession(sessionPath);
    } catch {}
    console.log(`🔄 Restoring: ${session.id}`);
    await initWhatsApp(session.id, session.userId);
  }
}

// ── Start ─────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 ZAPMRO CLOUD v2.0 → http://localhost:${PORT}`);
  console.log(`📦 Packages: express=${hasExpress} socket=${hasSocket} whatsapp=${hasWA} ai=${hasOpenAI}`);
  console.log(`🔑 Admin: ${process.env.ADMIN_EMAIL || 'admin@zapmro.cloud'}`);
  console.log(`🔒 Promo: ${process.env.TEST_PROMO_CODE || 'ZAPMRO2026'}\n`);
  await restoreSessions();
});

export default httpServer;
