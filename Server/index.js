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
      if (m) {
        const k = m[1].trim();
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
      }
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

function normalizeOAuthRedirectUri(u) {
  let raw = (u || '').toString().trim();
  if (!raw) return '';
  for (let i = 0; i < 3; i++) {
    const t = raw.trim();
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
      raw = t.slice(1, -1).trim();
      continue;
    }
    break;
  }
  raw = raw.replace(/`/g, '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) && !raw.startsWith('/')) {
    raw = `https://${raw.replace(/^\/+/, '')}`;
  }
  try {
    const url = new URL(raw);
    const host = (url.hostname || '').toLowerCase();
    if (host && host !== 'localhost' && host !== '127.0.0.1') url.protocol = 'https:';
    url.hash = '';
    if (url.pathname === '/') return url.toString().replace(/\/+$/, '');
    return url.toString();
  } catch {
    if (raw === '/') return '';
    if (/^https?:\/\/[^/]+\/?$/.test(raw)) return raw.replace(/\/+$/, '');
    return raw;
  }
}

function resolveGoogleRedirectUri(req) {
  const allowLocal = ((process.env.ALLOW_LOCALHOST_OAUTH || '') + '').trim().toLowerCase() === 'true';
  const envRedirect = normalizeOAuthRedirectUri((process.env.GOOGLE_REDIRECT_URI || '').toString().trim());
  const publicBase = normalizeOAuthRedirectUri((process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').toString().trim());
  const reqBase = normalizeOAuthRedirectUri(resolveRequestBaseUrl(req));
  const candidates = [
    envRedirect,
    publicBase ? `${publicBase}/auth/google/callback` : '',
    reqBase ? `${reqBase}/auth/google/callback` : '',
    'https://zapmro.com.br/auth/google/callback'
  ].filter(Boolean);
  for (const c of candidates) {
    let v = normalizeOAuthRedirectUri(c);
    v = v.replace(/\/auth\/google\/callback\/$/, '/auth/google/callback');
    if (!allowLocal && isLocalhostUrl(v)) continue;
    return v;
  }
  return normalizeOAuthRedirectUri(candidates[0] || 'https://zapmro.com.br/auth/google/callback').replace(/\/auth\/google\/callback\/$/, '/auth/google/callback');
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

['users','sessions','scheduled_messages','tags','contacts','auth_tokens','winback_campaigns','admin_audit'].forEach(f => db.ensure(f));
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

const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || '').toString().trim().toLowerCase();
const superAdminPassword = (process.env.SUPER_ADMIN_PASSWORD || '').toString();
if (superAdminEmail && superAdminPassword) {
  const existing = users.find(u => String(u.email || '').toLowerCase() === superAdminEmail);
  if (!existing) {
    users.push({
      id: uuid(),
      name: 'Admin Geral',
      email: superAdminEmail,
      password: bcryptjs.hashSync(superAdminPassword, 10),
      role: 'superadmin',
      createdAt: new Date().toISOString()
    });
    db.save('users', users);
    console.log('✅ Super admin user created');
  } else if (existing.role !== 'superadmin') {
    existing.role = 'superadmin';
    existing.updatedAt = new Date().toISOString();
    db.save('users', users);
  }
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
  try {
    const payload = verifyToken(token);
    const users = db.load('users');
    const user = users.find(u => u.id === payload?.id);
    if (!user) return null;
    return { id: user.id, email: user.email, role: user.role, name: user.name, disabled: !!user.disabled };
  } catch {
    return null;
  }
}

function requireAuth(req, res) {
  const user = auth(req);
  if (!user) { err(res, 'Unauthorized', 401); return null; }
  if (user.disabled) { err(res, 'Conta desativada', 403); return null; }
  return user;
}

function isAdminRole(u) {
  const r = (u?.role || '').toString();
  return r === 'admin' || r === 'superadmin';
}

function requireSuperAdmin(req, res) {
  const u = requireAuth(req, res); if (!u) return null;
  if ((u.role || '').toString() !== 'superadmin') { err(res, 'Forbidden', 403); return null; }
  return u;
}

function appendAdminAudit(actorId, action, meta) {
  const arr = db.load('admin_audit', []);
  arr.push({ id: uuid(), actorId, action: String(action || ''), meta: meta || null, ts: Date.now(), createdAt: new Date().toISOString() });
  if (arr.length > 2000) arr.splice(0, arr.length - 2000);
  db.save('admin_audit', arr);
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
  html(res, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Política de Privacidade - ZAPMRO</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2064%2064%27%3E%3Ccircle%20cx=%2732%27%20cy=%2732%27%20r=%2730%27%20fill=%27%2325d366%27/%3E%3Cpath%20fill=%27%23ffffff%27%20d=%27M42.5%2036.8c-1.1-.6-2.5-1.3-3.7-1.8-.4-.2-.9-.1-1.2.2l-2%202.4c-.3.3-.7.4-1.1.3-2.7-1.1-5.9-4.2-7-7-.1-.4%200-.8.3-1.1l2.4-2c.3-.3.4-.8.2-1.2-.5-1.2-1.2-2.6-1.8-3.7-.2-.4-.6-.7-1.1-.7H23c-.6%200-1.1.4-1.2%201-1.1%206.3%201%2012.6%205.9%2017.5%204.9%204.9%2011.2%207%2017.5%205.9.6-.1%201-.6%201-1.2v-3.1c0-.5-.3-.9-.7-1.1z%27/%3E%3C/svg%3E"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;line-height:1.5;color:#111}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px}p,li{color:#333}a{color:#128c7e}small{color:#666}</style></head><body><h1>Política de Privacidade</h1><small>Última atualização: ${new Date().toISOString().slice(0,10)}</small><p>Esta Política de Privacidade descreve como o ZAPMRO coleta e utiliza informações ao usar o sistema.</p><h2>Dados coletados</h2><ul><li>Dados de conta: nome e e-mail.</li><li>Dados operacionais: conversas e mensagens necessárias para funcionamento do CRM/automação.</li><li>Dados de integrações: quando você autoriza, tokens de acesso para sincronização (ex.: Google Contatos).</li></ul><h2>Uso das informações</h2><ul><li>Operar o painel e as funcionalidades de atendimento, automação e CRM.</li><li>Sincronizar contatos quando autorizado pelo usuário.</li><li>Melhorar estabilidade e segurança.</li></ul><h2>Compartilhamento</h2><p>Não vendemos seus dados. Podemos compartilhar somente quando necessário para provedores de infraestrutura e integrações (ex.: Google) conforme autorização.</p><h2>Segurança</h2><p>Adotamos medidas técnicas para proteger os dados armazenados e transmitidos.</p><h2>Contato</h2><p>Para dúvidas, entre em contato pelo site <a href="https://zapmro.com.br">zapmro.com.br</a>.</p></body></html>`);
});

route('GET', '/termosdoservico', (req, res) => {
  html(res, `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Termos de Serviço - ZAPMRO</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2064%2064%27%3E%3Ccircle%20cx=%2732%27%20cy=%2732%27%20r=%2730%27%20fill=%27%2325d366%27/%3E%3Cpath%20fill=%27%23ffffff%27%20d=%27M42.5%2036.8c-1.1-.6-2.5-1.3-3.7-1.8-.4-.2-.9-.1-1.2.2l-2%202.4c-.3.3-.7.4-1.1.3-2.7-1.1-5.9-4.2-7-7-.1-.4%200-.8.3-1.1l2.4-2c.3-.3.4-.8.2-1.2-.5-1.2-1.2-2.6-1.8-3.7-.2-.4-.6-.7-1.1-.7H23c-.6%200-1.1.4-1.2%201-1.1%206.3%201%2012.6%205.9%2017.5%204.9%204.9%2011.2%207%2017.5%205.9.6-.1%201-.6%201-1.2v-3.1c0-.5-.3-.9-.7-1.1z%27/%3E%3C/svg%3E"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;line-height:1.5;color:#111}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px}p,li{color:#333}a{color:#128c7e}small{color:#666}</style></head><body><h1>Termos de Serviço</h1><small>Última atualização: ${new Date().toISOString().slice(0,10)}</small><p>Ao usar o ZAPMRO, você concorda com estes Termos.</p><h2>Uso do serviço</h2><ul><li>Você é responsável pelas mensagens enviadas, contatos e conteúdos configurados.</li><li>Você deve respeitar as políticas do WhatsApp e demais plataformas integradas.</li></ul><h2>Conta</h2><p>Você deve manter suas credenciais seguras. O uso não autorizado deve ser comunicado.</p><h2>Integrações</h2><p>Ao conectar serviços externos (ex.: Google), você autoriza o acesso necessário para a funcionalidade solicitada (ex.: sincronização de contatos).</p><h2>Limitações</h2><p>O serviço é fornecido “como está”, podendo passar por melhorias e manutenções.</p><h2>Contato</h2><p>Mais informações em <a href="https://zapmro.com.br">zapmro.com.br</a>.</p></body></html>`);
});

function adminPageHtml() {
  return `<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ZAPMRO | Administrativo</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2064%2064%27%3E%3Ccircle%20cx=%2732%27%20cy=%2732%27%20r=%2730%27%20fill=%27%2325d366%27/%3E%3Cpath%20fill=%27%23ffffff%27%20d=%27M42.5%2036.8c-1.1-.6-2.5-1.3-3.7-1.8-.4-.2-.9-.1-1.2.2l-2%202.4c-.3.3-.7.4-1.1.3-2.7-1.1-5.9-4.2-7-7-.1-.4%200-.8.3-1.1l2.4-2c.3-.3.4-.8.2-1.2-.5-1.2-1.2-2.6-1.8-3.7-.2-.4-.6-.7-1.1-.7H23c-.6%200-1.1.4-1.2%201-1.1%206.3%201%2012.6%205.9%2017.5%204.9%204.9%2011.2%207%2017.5%205.9.6-.1%201-.6%201-1.2v-3.1c0-.5-.3-.9-.7-1.1z%27/%3E%3C/svg%3E">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    :root{--primary:#128c7e;--bg:#f0f2f5;--border:#e0e0e0;--dark:#111b21}
    *{box-sizing:border-box}
    html,body{height:100%}
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:#111b21}
    .wrap{min-height:100%;display:flex;flex-direction:column}
    .top{height:64px;background:#fff;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;padding:0 16px;position:sticky;top:0;z-index:10}
    .brand{font-weight:900;letter-spacing:.5px;display:flex;align-items:center;gap:10px}
    .brand i{color:var(--primary)}
    .sp{flex:1}
    .btn{border:1px solid var(--border);background:#fff;border-radius:12px;padding:10px 12px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
    .btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
    .btn.danger{background:#e74c3c;border-color:#e74c3c;color:#fff}
    .btn:active{transform:scale(.99)}
    .pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:6px 10px;font-weight:800;font-size:.82rem}
    .pill.ok{background:#e8f8f0;color:#1f8f55}
    .pill.bad{background:#fdf0f0;color:#c0392b}
    .pill.warn{background:#fef9e7;color:#b9770e}
    .content{flex:1;padding:16px;display:grid;grid-template-columns: 420px 1fr;gap:16px;min-height:0}
    .card{background:#fff;border:1px solid var(--border);border-radius:16px;overflow:hidden;min-height:0;display:flex;flex-direction:column}
    .card-h{padding:14px 16px;border-bottom:1px solid var(--border);font-weight:900;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .card-b{padding:14px 16px;overflow:auto;min-height:0}
    .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
    .stat{border:1px solid var(--border);border-radius:14px;padding:12px;background:#fff}
    .stat .k{font-size:.8rem;color:#667781;font-weight:800}
    .stat .v{font-size:1.3rem;font-weight:1000;margin-top:6px}
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:left;font-size:.9rem;vertical-align:middle}
    th{font-size:.78rem;color:#667781;text-transform:uppercase;letter-spacing:.6px}
    .row-actions{display:flex;gap:8px;flex-wrap:wrap}
    .input{width:100%;border:1px solid var(--border);border-radius:12px;padding:10px 12px;font-size:1rem;outline:none}
    .input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(18,140,126,.12)}
    .login{max-width:460px;margin:8vh auto 0;background:#fff;border-radius:18px;border:1px solid var(--border);box-shadow:0 20px 60px rgba(0,0,0,.08);overflow:hidden}
    .login .h{padding:16px;border-bottom:1px solid var(--border);font-weight:1000}
    .login .b{padding:16px;display:flex;flex-direction:column;gap:12px}
    .muted{color:#667781}
    .split{display:grid;grid-template-columns: 1fr 1fr;gap:12px}
    .viewer{display:grid;grid-template-columns: 340px 1fr;gap:12px;min-height:0}
    .list{border:1px solid var(--border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;min-height:0}
    .list .head{padding:10px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center}
    .list .items{flex:1;overflow:auto}
    .item{padding:10px;border-bottom:1px solid #f0f0f0;cursor:pointer}
    .item:hover{background:#f7f7f7}
    .item.active{background:#f0f2f5}
    .msgbox{border:1px solid var(--border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;min-height:0}
    .msgbox .head{padding:10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px}
    .msgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;background:#fff}
    .m{max-width:min(78%,720px);padding:10px 12px;border-radius:14px;border:1px solid #eef0f2;white-space:pre-wrap;overflow-wrap:break-word}
    .m.me{margin-left:auto;background:#dcf8c6}
    .m.them{margin-right:auto;background:#fff}
    .composer{padding:10px;border-top:1px solid var(--border);display:flex;gap:10px}
    .back{display:none}
    @media (max-width: 1024px){.content{grid-template-columns: 1fr}.grid4{grid-template-columns:repeat(2,1fr)}}
    @media (max-width: 768px){
      .grid4{grid-template-columns:1fr}
      .split{grid-template-columns:1fr}
      .viewer{grid-template-columns:1fr}
      body.viewer-open .viewer .list{display:none}
      body:not(.viewer-open) .viewer .msgbox{display:none}
      .back{display:inline-flex}
    }
  </style>
</head>
<body>
  <div class="wrap" id="appRoot" style="display:none">
    <div class="top">
      <div class="brand"><i class="fas fa-shield-halved"></i><span>Administrativo</span></div>
      <div class="sp"></div>
      <div id="mePill" class="pill warn" style="display:none"></div>
      <button class="btn" type="button" onclick="refreshAdmin()"><i class="fas fa-rotate"></i><span>Atualizar</span></button>
      <button class="btn danger" type="button" onclick="adminLogout()"><i class="fas fa-right-from-bracket"></i><span>Sair</span></button>
    </div>
    <div class="content">
      <div class="card">
        <div class="card-h"><span>Cadastros</span><span class="muted" id="totalsSmall"></span></div>
        <div class="card-b">
          <div class="grid4" style="margin-bottom:12px">
            <div class="stat"><div class="k">Usuários</div><div class="v" id="tUsers">0</div></div>
            <div class="stat"><div class="k">Sessões</div><div class="v" id="tSessions">0</div></div>
            <div class="stat"><div class="k">Conectadas</div><div class="v" id="tConnected">0</div></div>
            <div class="stat"><div class="k">Contatos</div><div class="v" id="tContacts">0</div></div>
          </div>
          <input class="input" id="userFilter" placeholder="Buscar por nome/email..." oninput="renderUsers()">
          <div style="height:10px"></div>
          <div style="overflow:auto">
            <table>
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th>Cadastro</th>
                  <th>Último acesso</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody id="usersTbody"></tbody>
            </table>
          </div>
          <div style="height:14px"></div>
          <div style="font-weight:1000; margin-bottom:8px">Histórico do administrativo</div>
          <div id="auditBox" class="muted" style="font-size:0.9rem; line-height:1.4">Carregando...</div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><span>WhatsApp (visualizar e agir)</span><span class="muted" id="selInfo">Selecione uma sessão</span></div>
        <div class="card-b" style="display:flex;flex-direction:column;gap:12px;min-height:0">
          <div class="split">
            <div>
              <div style="font-weight:900;margin-bottom:6px">Sessão</div>
              <select class="input" id="sessionSelect" onchange="selectSession(this.value)"></select>
            </div>
            <div>
              <div style="font-weight:900;margin-bottom:6px">Status</div>
              <div id="waStatusLine" class="pill warn">-</div>
            </div>
          </div>
          <div class="split">
            <div>
              <div style="font-weight:900;margin-bottom:6px">Número conectado</div>
              <div id="waNumber" class="muted">-</div>
            </div>
            <div>
              <div style="font-weight:900;margin-bottom:6px">Leads (histórico)</div>
              <div id="waLeads" class="muted">-</div>
            </div>
          </div>
          <div class="row-actions">
            <button class="btn" type="button" onclick="openQr()"><i class="fas fa-qrcode"></i><span>QR</span></button>
            <button class="btn" type="button" onclick="forceConnect()"><i class="fas fa-plug"></i><span>Forçar conectar</span></button>
            <button class="btn" type="button" onclick="disconnectWa()"><i class="fas fa-link-slash"></i><span>Desconectar</span></button>
            <button class="btn danger" type="button" onclick="resetWa()"><i class="fas fa-trash-can"></i><span>Reset</span></button>
          </div>
          <div class="viewer" style="flex:1;min-height:0">
            <div class="list">
              <div class="head">
                <i class="fas fa-magnifying-glass"></i>
                <input class="input" id="chatFilter" placeholder="Buscar chats..." oninput="renderChats()" style="padding:8px 10px">
              </div>
              <div class="items" id="chatItems"></div>
            </div>
            <div class="msgbox">
              <div class="head">
                <button class="btn back" type="button" onclick="backToList()"><i class="fas fa-arrow-left"></i><span>Voltar</span></button>
                <div style="font-weight:1000;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="chatTitle">Selecione um chat</div>
                <div class="sp"></div>
                <button class="btn" type="button" onclick="reloadMessages()"><i class="fas fa-rotate"></i><span>Atualizar</span></button>
              </div>
              <div class="msgs" id="msgs"></div>
              <div class="composer">
                <input class="input" id="msgInput" placeholder="Digite uma mensagem..." onkeydown="if(event.key==='Enter'){sendMsg()}">
                <button class="btn primary" type="button" onclick="sendMsg()"><i class="fas fa-paper-plane"></i><span>Enviar</span></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="login" id="loginRoot">
    <div class="h">Acesso Administrativo</div>
    <div class="b">
      <div class="muted" style="line-height:1.4">Use as credenciais do Admin Geral (SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD configurados no servidor).</div>
      <div>
        <div style="font-weight:900;margin-bottom:6px">Email</div>
        <input class="input" id="loginEmail" type="email" placeholder="email@dominio.com">
      </div>
      <div>
        <div style="font-weight:900;margin-bottom:6px">Senha</div>
        <input class="input" id="loginPass" type="password" placeholder="Sua senha">
      </div>
      <button class="btn primary" type="button" onclick="adminLogin()" style="justify-content:center"><i class="fas fa-right-to-bracket"></i><span>Entrar</span></button>
      <div id="loginErr" class="muted" style="color:#c0392b; font-weight:800; display:none"></div>
    </div>
  </div>

  <div id="qrModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:9999; padding:20px;">
    <div style="max-width: 420px; margin: 6vh auto 0; background: white; border-radius: 16px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.25);">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom: 10px;">
        <div style="font-weight:900; color:#111b21;">QR WhatsApp</div>
        <button class="btn" type="button" onclick="closeQr()" style="padding:8px 10px"><i class="fas fa-xmark"></i><span>Fechar</span></button>
      </div>
      <div id="qrLine" class="muted" style="margin-bottom:10px">Carregando...</div>
      <div style="background:#f7f7f7; border-radius: 14px; padding: 14px; display:flex; align-items:center; justify-content:center; min-height: 320px;">
        <img id="qrImg" src="" alt="QR Code" style="display:none; width: 280px; height: 280px; object-fit: contain; border-radius: 12px; background:white;">
        <div id="qrEmpty" class="muted" style="text-align:center">
          <div style="font-weight:900;color:#111b21;margin-bottom:6px">Aguardando QR...</div>
          <div style="font-size:.9rem">Clique em “Forçar conectar” se necessário.</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const ADMIN_TOKEN_KEY = 'zapmro_admin_token';
    const ADMIN_USER_KEY = 'zapmro_admin_user';
    let ADMIN_TOKEN = localStorage.getItem(ADMIN_TOKEN_KEY) || '';
    let OVERVIEW = null;
    let AUDIT = [];
    let SELECTED_SESSION = '';
    let CHATS = [];
    let SELECTED_CHAT = '';
    let QR_TIMER = null;

    function showLogin(err) {
      document.getElementById('appRoot').style.display = 'none';
      document.getElementById('loginRoot').style.display = 'block';
      const el = document.getElementById('loginErr');
      if (err) { el.textContent = err; el.style.display = 'block'; } else { el.style.display = 'none'; }
    }

    function showApp() {
      document.getElementById('loginRoot').style.display = 'none';
      document.getElementById('appRoot').style.display = 'flex';
    }

    async function adminLogin() {
      const email = (document.getElementById('loginEmail').value || '').trim();
      const password = (document.getElementById('loginPass').value || '').toString();
      if (!email || !password) return showLogin('Email e senha obrigatórios');
      try {
        const res = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email, password }) });
        const data = await res.json().catch(()=>({}));
        if (!res.ok || !data.token) return showLogin(data.error || 'Falha no login');
        if ((data.user?.role || '') !== 'superadmin') return showLogin('Este usuário não é Admin Geral');
        ADMIN_TOKEN = data.token;
        localStorage.setItem(ADMIN_TOKEN_KEY, ADMIN_TOKEN);
        localStorage.setItem(ADMIN_USER_KEY, JSON.stringify(data.user || {}));
        await refreshAdmin();
      } catch {
        showLogin('Falha no login');
      }
    }

    function adminLogout() {
      ADMIN_TOKEN = '';
      localStorage.removeItem(ADMIN_TOKEN_KEY);
      localStorage.removeItem(ADMIN_USER_KEY);
      OVERVIEW = null;
      SELECTED_SESSION = '';
      CHATS = [];
      SELECTED_CHAT = '';
      showLogin();
    }

    function authHeaders() {
      return { 'Authorization': 'Bearer ' + ADMIN_TOKEN };
    }

    function fmtDate(v) {
      const t = Date.parse(v || '');
      if (!t) return '-';
      return new Date(t).toLocaleString('pt-BR', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    }

    function pill(status) {
      const s = (status || '').toString();
      if (s === 'connected') return '<span class="pill ok">Conectado</span>';
      if (s === 'qr') return '<span class="pill warn">QR</span>';
      if (s === 'initializing' || s === 'connecting') return '<span class="pill warn">Conectando</span>';
      return '<span class="pill bad">Desconectado</span>';
    }

    async function refreshAdmin() {
      if (!ADMIN_TOKEN) return showLogin();
      try {
        const res = await fetch('/api/admin/overview', { headers: authHeaders() });
        const data = await res.json().catch(()=>({}));
        if (!res.ok || !data.ok) return showLogin(data.error || 'Sessão expirada');
        OVERVIEW = data;
        showApp();
        document.getElementById('tUsers').textContent = String(data.totals?.users ?? 0);
        document.getElementById('tSessions').textContent = String(data.totals?.sessions ?? 0);
        document.getElementById('tConnected').textContent = String(data.totals?.sessionsConnected ?? 0);
        document.getElementById('tContacts').textContent = String(data.totals?.contacts ?? 0);
        document.getElementById('totalsSmall').textContent = (data.totals?.historyChats ? ('Leads: ' + data.totals.historyChats) : '');
        renderUsers();
        renderSessionSelect();
        await loadAudit();
        renderAudit();
      } catch {
        showLogin('Falha ao carregar painel');
      }
    }

    async function loadAudit() {
      try {
        const res = await fetch('/api/admin/audit', { headers: authHeaders() });
        const data = await res.json().catch(()=>({}));
        if (!res.ok || !data.ok) { AUDIT = []; return; }
        AUDIT = Array.isArray(data.items) ? data.items : [];
      } catch {
        AUDIT = [];
      }
    }

    function renderAudit() {
      const el = document.getElementById('auditBox');
      if (!el) return;
      if (!AUDIT.length) { el.textContent = 'Sem ações registradas.'; return; }
      el.innerHTML = AUDIT.slice(0, 50).map(a => {
        const at = a?.createdAt ? fmtDate(a.createdAt) : (a?.ts ? fmtDate(new Date(Number(a.ts)).toISOString()) : '-');
        const act = (a?.action || '').toString();
        const meta = a?.meta ? JSON.stringify(a.meta) : '';
        return '<div style="padding:8px 0;border-bottom:1px solid #f0f0f0">' +
          '<div style="font-weight:900">' + esc(act || '-') + '</div>' +
          '<div class="muted" style="font-size:.82rem">' + esc(at) + (meta ? (' • ' + esc(meta)) : '') + '</div>' +
        '</div>';
      }).join('');
    }

    function renderUsers() {
      const q = (document.getElementById('userFilter').value || '').trim().toLowerCase();
      const tb = document.getElementById('usersTbody');
      const users = Array.isArray(OVERVIEW?.users) ? OVERVIEW.users : [];
      const sessions = Array.isArray(OVERVIEW?.sessions) ? OVERVIEW.sessions : [];
      const wa = OVERVIEW?.waBySession || {};
      const filtered = users.filter(u => (u.name||'').toLowerCase().includes(q) || (u.email||'').toLowerCase().includes(q));
      tb.innerHTML = filtered.map(u => {
        const ss = sessions.filter(s => s.userId === u.id);
        const connected = ss.filter(s => wa[s.id]?.connected).length;
        const st = u.disabled ? '<span class="pill bad">Desativado</span>' : (connected ? '<span class="pill ok">Ativo</span>' : '<span class="pill warn">Sem WA</span>');
        const btnDisable = u.disabled
          ? '<button class="btn" type="button" onclick="setUserDisabled(\\'' + u.id + '\\', false)"><i class="fas fa-toggle-on"></i><span>Ativar</span></button>'
          : '<button class="btn" type="button" onclick="setUserDisabled(\\'' + u.id + '\\', true)"><i class="fas fa-toggle-off"></i><span>Desativar</span></button>';
        const btnDelete = '<button class="btn danger" type="button" onclick="deleteUser(\\'' + u.id + '\\', \\'' + (u.email||'') + '\\')"><i class="fas fa-trash"></i><span>Apagar</span></button>';
        const btnPick = ss.length ? '<button class="btn primary" type="button" onclick="quickPickUser(\\'' + u.id + '\\')"><i class="fas fa-eye"></i><span>Ver</span></button>' : '';
        return '<tr>' +
          '<td><div style="font-weight:1000">' + esc(u.name || '-') + '</div><div class="muted" style="font-size:.85rem">' + esc(u.email || '-') + '</div></td>' +
          '<td>' + esc(fmtDate(u.createdAt)) + '</td>' +
          '<td>' + esc(fmtDate(u.lastLoginAt)) + '</td>' +
          '<td>' + st + '<div class="muted" style="font-size:.82rem;margin-top:4px">' + ss.length + ' sessão(ões) • ' + connected + ' conectada(s)</div></td>' +
          '<td><div class="row-actions">' + btnPick + btnDisable + btnDelete + '</div></td>' +
        '</tr>';
      }).join('');
    }

    function renderSessionSelect() {
      const sel = document.getElementById('sessionSelect');
      const sessions = Array.isArray(OVERVIEW?.sessions) ? OVERVIEW.sessions : [];
      sel.innerHTML = '<option value="">Selecione...</option>' + sessions.map(s => {
        const u = (OVERVIEW.users || []).find(x => x.id === s.userId) || {};
        const label = (u.email || u.name || s.userId || '').toString() + ' • ' + s.id;
        return '<option value="' + escAttr(s.id) + '">' + esc(label) + '</option>';
      }).join('');
      if (SELECTED_SESSION) sel.value = SELECTED_SESSION;
      if (SELECTED_SESSION) applySessionInfo();
    }

    function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',\"'\":'&#039;' }[c]))}
    function escAttr(s){return esc(s).replace(/\\s+/g,' ')}

    function quickPickUser(userId) {
      const sessions = Array.isArray(OVERVIEW?.sessions) ? OVERVIEW.sessions : [];
      const first = sessions.find(s => s.userId === userId);
      if (first) {
        document.getElementById('sessionSelect').value = first.id;
        selectSession(first.id);
      }
    }

    async function setUserDisabled(id, disabled) {
      if (!confirm((disabled ? 'Desativar' : 'Ativar') + ' este usuário?')) return;
      const res = await fetch('/api/admin/users/' + encodeURIComponent(id) + '/disable', { method:'POST', headers:{...authHeaders(),'content-type':'application/json'}, body: JSON.stringify({ disabled }) });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) return alert(data.error || 'Falha');
      await refreshAdmin();
    }

    async function deleteUser(id, email) {
      if (!confirm('Apagar o usuário ' + (email || id) + '?\\n\\nIsso remove sessões e dados associados.')) return;
      const res = await fetch('/api/admin/users/' + encodeURIComponent(id), { method:'DELETE', headers: authHeaders() });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) return alert(data.error || 'Falha');
      await refreshAdmin();
    }

    function selectSession(sessionId) {
      SELECTED_SESSION = sessionId || '';
      CHATS = [];
      SELECTED_CHAT = '';
      document.getElementById('chatItems').innerHTML = '';
      document.getElementById('msgs').innerHTML = '';
      document.getElementById('chatTitle').textContent = 'Selecione um chat';
      applySessionInfo();
      if (SELECTED_SESSION) loadChats();
    }

    function applySessionInfo() {
      const wa = OVERVIEW?.waBySession?.[SELECTED_SESSION] || null;
      const line = document.getElementById('waStatusLine');
      const num = document.getElementById('waNumber');
      const leads = document.getElementById('waLeads');
      const info = document.getElementById('selInfo');
      if (!SELECTED_SESSION) {
        line.className = 'pill warn'; line.textContent = '-';
        num.textContent = '-';
        leads.textContent = '-';
        info.textContent = 'Selecione uma sessão';
        return;
      }
      const status = (wa?.status || 'disconnected');
      line.outerHTML = '<div id="waStatusLine" class="' + (status==='connected'?'pill ok':status==='qr'||status==='initializing'?'pill warn':'pill bad') + '">' + esc(status) + '</div>';
      document.getElementById('waNumber').textContent = wa?.number || '-';
      document.getElementById('waLeads').textContent = String(wa?.historyChats ?? 0);
      info.textContent = SELECTED_SESSION;
    }

    async function loadChats() {
      try {
        const res = await fetch('/api/whatsapp/chats?sessionId=' + encodeURIComponent(SELECTED_SESSION), { headers: authHeaders() });
        const data = await res.json().catch(()=>[]);
        CHATS = Array.isArray(data) ? data : [];
        renderChats();
      } catch {
        CHATS = [];
        renderChats();
      }
    }

    function renderChats() {
      const q = (document.getElementById('chatFilter').value || '').trim().toLowerCase();
      const list = document.getElementById('chatItems');
      const filtered = (CHATS || []).filter(c => (c.name||'').toLowerCase().includes(q) || (c.id||'').toLowerCase().includes(q));
      list.innerHTML = filtered.map(c => {
        const active = (SELECTED_CHAT === c.id) ? ' active' : '';
        const unread = Number(c.unread||0);
        const badge = unread ? (' <span class="pill ok" style="padding:4px 8px;font-size:.75rem">+' + unread + '</span>') : '';
        const idEnc = encodeURIComponent(c.id || '');
        const titleEnc = encodeURIComponent(c.name || c.id || '');
        return '<div class="item' + active + '" onclick="openChat(\\'' + idEnc + '\\', \\'' + titleEnc + '\\')">' +
          '<div style="font-weight:1000;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.name||c.id) + badge + '</div>' +
          '<div class="muted" style="font-size:.82rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.lastMessage?.body || '') + '</div>' +
        '</div>';
      }).join('') || '<div class="muted" style="padding:12px">Nenhum chat</div>';
    }

    function openChat(chatId, title) {
      let chatIdRaw = (chatId || '').toString();
      let titleRaw = (title || '').toString();
      try { chatIdRaw = decodeURIComponent(chatIdRaw); } catch {}
      try { titleRaw = decodeURIComponent(titleRaw); } catch {}
      SELECTED_CHAT = chatIdRaw;
      document.getElementById('chatTitle').textContent = titleRaw || chatIdRaw;
      document.querySelectorAll('.item').forEach(el => el.classList.remove('active'));
      const items = Array.from(document.querySelectorAll('.item'));
      const idx = (CHATS||[]).findIndex(x => x.id === chatIdRaw);
      if (idx >= 0 && items[idx]) items[idx].classList.add('active');
      document.body.classList.add('viewer-open');
      reloadMessages();
    }

    function backToList() {
      document.body.classList.remove('viewer-open');
    }

    async function reloadMessages() {
      if (!SELECTED_SESSION || !SELECTED_CHAT) return;
      const box = document.getElementById('msgs');
      box.innerHTML = '<div class="muted">Carregando...</div>';
      try {
        const res = await fetch('/api/whatsapp/messages/' + encodeURIComponent(SELECTED_CHAT) + '?sessionId=' + encodeURIComponent(SELECTED_SESSION), { headers: authHeaders() });
        const data = await res.json().catch(()=>[]);
        const msgs = Array.isArray(data) ? data : [];
        box.innerHTML = msgs.map(m => '<div class="m ' + (m.fromMe ? 'me' : 'them') + '">' + esc(m.body || (m.media?.kind==='audio'?'[Áudio]':m.media?.kind==='image'?'[Imagem]':m.media?.kind==='video'?'[Vídeo]':m.media?.kind==='document'?'[Arquivo]':'') || '') + '</div>').join('') || '<div class="muted">Sem mensagens</div>';
        box.scrollTop = box.scrollHeight;
      } catch {
        box.innerHTML = '<div class="muted">Falha ao carregar</div>';
      }
    }

    async function sendMsg() {
      const inp = document.getElementById('msgInput');
      const text = (inp.value || '').trim();
      if (!text || !SELECTED_SESSION || !SELECTED_CHAT) return;
      inp.value = '';
      const res = await fetch('/api/whatsapp/send', { method:'POST', headers:{...authHeaders(),'content-type':'application/json'}, body: JSON.stringify({ sessionId: SELECTED_SESSION, to: SELECTED_CHAT, message: text }) });
      const data = await res.json().catch(()=>({}));
      if (!res.ok || !data.ok) alert(data.error || 'Falha ao enviar');
      await reloadMessages();
      await loadChats();
    }

    async function openQr() {
      if (!SELECTED_SESSION) return;
      document.getElementById('qrModal').style.display = 'block';
      if (QR_TIMER) { clearInterval(QR_TIMER); QR_TIMER = null; }
      const tick = async () => {
        try {
          const st = await fetch('/api/whatsapp/status/' + encodeURIComponent(SELECTED_SESSION), { headers: authHeaders() }).then(r=>r.json()).catch(()=>({}));
          const qr = await fetch('/api/whatsapp/qr/' + encodeURIComponent(SELECTED_SESSION), { headers: authHeaders() }).then(r=>r.json()).catch(()=>({}));
          document.getElementById('qrLine').textContent = (st.status === 'connected') ? 'Conectado!' : (st.status === 'qr' ? 'Escaneie o QR no celular' : 'Aguardando...');
          const has = !!qr.qr;
          const img = document.getElementById('qrImg');
          const empty = document.getElementById('qrEmpty');
          if (has) { img.src = qr.qr; img.style.display='block'; empty.style.display='none'; } else { img.style.display='none'; empty.style.display='block'; }
          await refreshAdmin();
        } catch {}
      };
      await tick();
      QR_TIMER = setInterval(tick, 1300);
    }

    function closeQr() {
      document.getElementById('qrModal').style.display = 'none';
      if (QR_TIMER) { clearInterval(QR_TIMER); QR_TIMER = null; }
    }

    async function forceConnect() {
      if (!SELECTED_SESSION) return;
      await fetch('/api/whatsapp/connect', { method:'POST', headers:{...authHeaders(),'content-type':'application/json'}, body: JSON.stringify({ sessionId: SELECTED_SESSION, force: true }) }).catch(()=>{});
      await refreshAdmin();
    }

    async function disconnectWa() {
      if (!SELECTED_SESSION) return;
      await fetch('/api/whatsapp/disconnect', { method:'POST', headers:{...authHeaders(),'content-type':'application/json'}, body: JSON.stringify({ sessionId: SELECTED_SESSION }) }).catch(()=>{});
      await refreshAdmin();
    }

    async function resetWa() {
      if (!SELECTED_SESSION) return;
      if (!confirm('Resetar sessão do WhatsApp? Vai pedir QR novamente.')) return;
      await fetch('/api/whatsapp/reset', { method:'POST', headers:{...authHeaders(),'content-type':'application/json'}, body: JSON.stringify({ sessionId: SELECTED_SESSION }) }).catch(()=>{});
      await refreshAdmin();
    }

    window.addEventListener('keydown', (e) => {
      if (e && e.key === 'Escape') closeQr();
    });

    if (ADMIN_TOKEN) refreshAdmin();
    else showLogin();
  </script>
</body>
</html>`;
}

route('GET', '/administrativo', (req, res) => {
  html(res, adminPageHtml());
});
route('GET', '/administrativo/', (req, res) => {
  html(res, adminPageHtml());
});
route('GET', '/administrativo.html', (req, res) => {
  html(res, adminPageHtml());
});

async function handleGoogleOAuthCallback(req, res) {
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
}

route('GET', '/auth/google/callback', handleGoogleOAuthCallback);
route('GET', '/auth/google/callback/', handleGoogleOAuthCallback);

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
  if (user.disabled) return err(res, 'Conta desativada', 403);
  if (password) {
    const stored = (user.password || '').toString();
    const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$');
    const ok = isBcrypt ? bcryptjs.compareSync(password, stored) : simpleHash(password) === stored;
    if (!ok) return err(res, 'Senha incorreta');
    if (!isBcrypt) {
      user.password = bcryptjs.hashSync(password, 10);
    }
  }
  user.lastLoginAt = new Date().toISOString();
  db.save('users', users);
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

function countHistoryChatsForSession(sessionId) {
  try {
    const dir = join(DATA, 'history');
    if (!existsSync(dir)) return 0;
    const prefix = `${String(sessionId || '')}_`;
    return readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

route('GET', '/api/admin/overview', (req, res) => {
  const u = requireSuperAdmin(req, res); if (!u) return;
  const users = db.load('users', []).map(x => ({
    id: x.id,
    name: x.name,
    email: x.email,
    role: x.role,
    disabled: !!x.disabled,
    createdAt: x.createdAt || null,
    lastLoginAt: x.lastLoginAt || null,
    updatedAt: x.updatedAt || null
  }));
  const sessions = db.load('sessions', []).map(s => ({
    id: s.id,
    userId: s.userId,
    status: (waStatus.get(s.id) || s.status || 'disconnected'),
    createdAt: s.createdAt || null
  }));
  const contacts = db.load('contacts', []);
  const contactsBySession = {};
  for (const c of contacts) {
    const sid = String(c?.sessionId || '');
    if (!sid) continue;
    contactsBySession[sid] = (contactsBySession[sid] || 0) + 1;
  }
  const waBySession = {};
  for (const s of sessions) {
    const client = waClients.get(s.id);
    const info = client?.info || null;
    const number = info?.wid?.user ? `+${String(info.wid.user)}` : null;
    const pushname = info?.pushname || null;
    waBySession[s.id] = {
      status: s.status,
      connected: !!info,
      number,
      pushname,
      historyChats: countHistoryChatsForSession(s.id),
      contacts: contactsBySession[s.id] || 0
    };
  }
  const totals = {
    users: users.length,
    sessions: sessions.length,
    sessionsConnected: sessions.filter(s => waBySession[s.id]?.connected).length,
    contacts: contacts.length,
    historyChats: Object.values(waBySession).reduce((a, v) => a + (Number(v?.historyChats || 0) || 0), 0)
  };
  appendAdminAudit(u.id, 'overview', { totals });
  json(res, { ok: true, totals, users, sessions, waBySession });
});

route('GET', '/api/admin/audit', (req, res) => {
  const u = requireSuperAdmin(req, res); if (!u) return;
  const items = db.load('admin_audit', []);
  const out = Array.isArray(items) ? items.slice(-200).reverse() : [];
  json(res, { ok: true, items: out });
});

route('POST', '/api/admin/users/:id/disable', (req, res) => {
  const u = requireSuperAdmin(req, res); if (!u) return;
  const targetId = req.params.id;
  const disabled = !!req.body?.disabled;
  const users = db.load('users', []);
  const me = users.find(x => x.id === targetId);
  if (!me) return err(res, 'Not found', 404);
  if (me.role === 'superadmin' && me.id === u.id && disabled) return err(res, 'Não é possível desativar o próprio superadmin', 400);
  me.disabled = disabled;
  me.updatedAt = new Date().toISOString();
  db.save('users', users);
  appendAdminAudit(u.id, 'user.disable', { userId: targetId, disabled });
  json(res, { ok: true });
});

route('DELETE', '/api/admin/users/:id', async (req, res) => {
  const u = requireSuperAdmin(req, res); if (!u) return;
  const targetId = req.params.id;
  if (targetId === u.id) return err(res, 'Não é possível apagar o próprio superadmin', 400);
  const users = db.load('users', []);
  const target = users.find(x => x.id === targetId);
  if (!target) return err(res, 'Not found', 404);
  const sessionsAll = db.load('sessions', []);
  const owned = sessionsAll.filter(s => s.userId === targetId).map(s => s.id);
  for (const sid of owned) {
    try { await stopWhatsApp(sid); } catch {}
    try { rmSync(join(WA_AUTH_DIR, `session-${sid}`), { recursive: true, force: true }); } catch {}
    try { rmSync(join(WA_MEDIA_DIR, waSafePart(sid)), { recursive: true, force: true }); } catch {}
    try { rmSync(join(CHAT_MEDIA_DIR, waSafePart(sid)), { recursive: true, force: true }); } catch {}
    try {
      const histDir = join(DATA, 'history');
      if (existsSync(histDir)) {
        for (const f of readdirSync(histDir)) {
          if (f.startsWith(`${sid}_`) && f.endsWith('.json')) {
            try { rmSync(join(histDir, f), { force: true }); } catch {}
          }
        }
      }
    } catch {}
  }
  const sessionsNext = sessionsAll.filter(s => s.userId !== targetId);
  db.save('sessions', sessionsNext);

  const contacts = db.load('contacts', []).filter(c => c.userId !== targetId && !owned.includes(String(c.sessionId || '')));
  db.save('contacts', contacts);

  const tags = db.load('tags', []).filter(t => !owned.includes(String(t.sessionId || '')));
  db.save('tags', tags);

  const scheduled = db.load('scheduled_messages', []).filter(s => !owned.includes(String(s.sessionId || '')));
  db.save('scheduled_messages', scheduled);

  const campaigns = db.load('winback_campaigns', []).filter(c => !owned.includes(String(c.sessionId || '')));
  db.save('winback_campaigns', campaigns);

  const flows = db.load('flows', {});
  for (const sid of owned) delete flows[sid];
  db.save('flows', flows);

  const aiCfg = db.load('ai_config', {});
  for (const sid of owned) delete aiCfg[sid];
  db.save('ai_config', aiCfg);

  const kanban = db.load('kanban', {});
  for (const sid of owned) delete kanban[sid];
  db.save('kanban', kanban);

  const aiStatus = db.load('ai_chat_status', {});
  for (const k of Object.keys(aiStatus || {})) {
    const sid = String(k.split(':')[0] || '');
    if (owned.includes(sid)) delete aiStatus[k];
  }
  db.save('ai_chat_status', aiStatus);

  const aiTrans = db.load('ai_transcripts', {});
  for (const sid of owned) delete aiTrans[sid];
  db.save('ai_transcripts', aiTrans);

  const assets = db.load('flow_assets', {});
  for (const sid of owned) delete assets[sid];
  db.save('flow_assets', assets);

  const runs = db.load('flow_runs', {});
  for (const sid of owned) delete runs[sid];
  db.save('flow_runs', runs);

  const tokens = db.load('auth_tokens', []).filter(t => t.userId !== targetId);
  db.save('auth_tokens', tokens);

  db.save('users', users.filter(x => x.id !== targetId));
  appendAdminAudit(u.id, 'user.delete', { userId: targetId, sessions: owned });
  json(res, { ok: true, removedSessions: owned.length });
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

function getUserPrefs(userId) {
  const all = db.load('user_prefs', {});
  const item = all?.[String(userId || '')] || {};
  return {
    googleAutoSaveContacts: !!item.googleAutoSaveContacts
  };
}

function saveUserPrefs(userId, patch) {
  const all = db.load('user_prefs', {});
  const key = String(userId || '');
  const prev = all?.[key] || {};
  all[key] = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  db.save('user_prefs', all);
  return getUserPrefs(userId);
}

function appendActivity(sessionId, actorUserId, type, title, meta) {
  try {
    const store = db.load('activity', {});
    const sid = String(sessionId || '');
    if (!sid) return;
    const arr = Array.isArray(store[sid]) ? store[sid] : [];
    const item = {
      id: uuid(),
      sessionId: sid,
      actorUserId: actorUserId ? String(actorUserId) : null,
      type: String(type || 'event'),
      title: String(title || ''),
      meta: meta || null,
      ts: Date.now(),
      createdAt: new Date().toISOString()
    };
    arr.push(item);
    if (arr.length > 300) arr.splice(0, arr.length - 300);
    store[sid] = arr;
    db.save('activity', store);
    if (io) io.to(sid).emit('activity', { sessionId: sid, item });
  } catch {}
}

function getSessionActivities(sessionId, limit) {
  const store = db.load('activity', {});
  const sid = String(sessionId || '');
  const arr = Array.isArray(store?.[sid]) ? store[sid] : [];
  const n = Math.max(1, Math.min(200, Number(limit || 50) || 50));
  return arr.slice(-n).reverse();
}

function appendWinbackLog(campaignId, sessionId, entry) {
  try {
    const store = db.load('winback_logs', {});
    const cid = String(campaignId || '');
    if (!cid) return;
    const arr = Array.isArray(store[cid]) ? store[cid] : [];
    const item = {
      id: uuid(),
      campaignId: cid,
      sessionId: String(sessionId || '') || null,
      ...entry,
      ts: Date.now(),
      createdAt: new Date().toISOString()
    };
    arr.push(item);
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    store[cid] = arr;
    db.save('winback_logs', store);
    if (io && sessionId) io.to(String(sessionId)).emit('winback-log', { sessionId: String(sessionId), campaignId: cid, item });
  } catch {}
}

function getWinbackLogs(campaignId, limit) {
  const store = db.load('winback_logs', {});
  const cid = String(campaignId || '');
  const arr = Array.isArray(store?.[cid]) ? store[cid] : [];
  const n = Math.max(1, Math.min(500, Number(limit || 200) || 200));
  return arr.slice(-n).reverse();
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

function googlePersonFromLocalContact(contact) {
  const name = (contact?.name || '').toString().trim();
  const email = (contact?.email || '').toString().trim();
  const digits = digitsOnly(contact?.number || '');
  const person = {};
  if (name) person.names = [{ displayName: name, unstructuredName: name }];
  if (email) person.emailAddresses = [{ value: email }];
  if (digits) person.phoneNumbers = [{ value: `+${digits}` }];
  return person;
}

async function googleFindContactByPhone(userId, digits) {
  const q = digitsOnly(digits || '');
  if (!q || q.length < 8) return null;
  const token = await getGoogleAccessToken(userId);
  const url = new URL('https://people.googleapis.com/v1/people:searchContacts');
  url.searchParams.set('query', q);
  url.searchParams.set('readMask', 'metadata,names,emailAddresses,phoneNumbers');
  url.searchParams.set('pageSize', '1');
  const resp = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return null;
  const results = Array.isArray(data?.results) ? data.results : [];
  const person = results?.[0]?.person || null;
  if (!person?.resourceName) return null;
  const sources = Array.isArray(person?.metadata?.sources) ? person.metadata.sources : [];
  const src = sources.find(s => (s?.type || '').toString() === 'CONTACT') || sources[0] || null;
  return { resourceName: person.resourceName, etag: src?.etag || person.etag || null };
}

async function googleCreateOrUpdateContact(userId, contact) {
  const token = await getGoogleAccessToken(userId);
  const digits = digitsOnly(contact?.number || '');
  const existing = await googleFindContactByPhone(userId, digits).catch(() => null);
  const person = googlePersonFromLocalContact(contact);
  if (existing?.resourceName && existing?.etag) {
    const url = new URL(`https://people.googleapis.com/v1/${encodeURIComponent(existing.resourceName)}:updateContact`);
    url.searchParams.set('updatePersonFields', 'names,emailAddresses,phoneNumbers');
    const body = {
      resourceName: existing.resourceName,
      etag: existing.etag,
      metadata: { sources: [{ type: 'CONTACT', etag: existing.etag }] },
      ...person
    };
    const resp = await fetch(url.toString(), { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true, kind: 'update', resourceName: data?.resourceName || existing.resourceName, etag: data?.etag || existing.etag };
  }
  const createUrl = new URL('https://people.googleapis.com/v1/people:createContact');
  const createResp = await fetch(createUrl.toString(), { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(person) });
  const createData = await createResp.json().catch(() => ({}));
  if (!createResp.ok) throw new Error(createData?.error?.message || 'Falha ao criar contato no Google');
  return { ok: true, kind: 'create', resourceName: createData?.resourceName || null, etag: createData?.etag || null };
}

route('GET', '/api/google/auth-url', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').toString().trim();
  const redirectUri = resolveGoogleRedirectUri(req);
  if (!clientId) return err(res, 'Google OAuth não configurado', 500);
  const state = signToken({ type: 'google_oauth', uid: u.id, returnTo: '/dashboard.html#contacts' });
  const scope = [
    'https://www.googleapis.com/auth/contacts',
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
  const prefs = getUserPrefs(u.id);
  json(res, { connected: !!item?.access_token, scope: item?.scope || null, updatedAt: item?.updatedAt || null, prefs });
});

route('GET', '/api/google/prefs', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  json(res, { ok: true, prefs: getUserPrefs(u.id) });
});

route('POST', '/api/google/prefs', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const googleAutoSaveContacts = !!req.body?.googleAutoSaveContacts;
  const prefs = saveUserPrefs(u.id, { googleAutoSaveContacts });
  json(res, { ok: true, prefs });
});

route('GET', '/api/dashboard/overview/:sessionId', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = req.params.sessionId;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sid);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const connected = (waStatus.get(sid) || sess.status || 'disconnected') === 'connected';
  const contactsTotal = db.load('contacts', []).filter(c => String(c?.sessionId || '') === String(sid)).length;
  const kanban = db.load('kanban', {})?.[sid] || null;
  const cols = Array.isArray(kanban?.columns) ? kanban.columns : [];
  const kanbanCounts = cols.map(c => ({
    id: String(c?.id || ''),
    name: String(c?.name || ''),
    color: String(c?.color || ''),
    count: Array.isArray(c?.chats) ? c.chats.length : 0
  }));
  const cfg = getAIConfig(sid);
  const aiEnabled = !!cfg?.enabled;
  const aiMode = (cfg?.mode || '').toString() || 'manual';

  let chats = [];
  let messagesToday = 0;
  let activeConversations = 0;
  let responseRate = 0;
  let waNumber = null;
  let waPushname = null;
  try {
    const client = waClients.get(sid);
    const info = client?.info || null;
    waNumber = info?.wid?.user ? `+${String(info.wid.user)}` : null;
    waPushname = info?.pushname || null;
    if (connected && client?.info) {
      const list = await client.getChats();
      const slice = list.slice(0, 200);
      chats = slice.map(c => ({
        id: c.id?._serialized,
        isGroup: !!c.isGroup,
        unread: Number(c.unreadCount || 0) || 0,
        timestamp: Number(c.timestamp || 0) || 0,
        lastFromMe: !!c.lastMessage?.fromMe
      })).filter(x => x.id && !x.isGroup);
    }
  } catch {}

  const nowSec = Math.floor(Date.now() / 1000);
  const dayKeyNow = dayKeyFromTs(nowSec);
  const last24h = chats.filter(c => c.timestamp && (nowSec - c.timestamp) <= 24 * 3600);
  activeConversations = last24h.length;
  const in24 = last24h.filter(c => !c.lastFromMe).length;
  const out24 = last24h.filter(c => c.lastFromMe).length;
  responseRate = (in24 + out24) ? Math.round((out24 / (in24 + out24)) * 100) : 0;

  try {
    const ranked = chats.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 60);
    let count = 0;
    for (const c of ranked) {
      const hist = getHistory(sid, c.id);
      const items = Array.isArray(hist) ? hist : [];
      for (let i = items.length - 1; i >= 0 && count < 5000; i--) {
        const m = items[i];
        if (!m) continue;
        if (dayKeyFromTs(m.timestamp || 0) !== dayKeyNow) break;
        if (!m.fromMe) messagesToday += 1;
        count += 1;
      }
      if (count >= 5000) break;
    }
  } catch {}

  const campaigns = db.load('winback_campaigns', []).filter(c => String(c?.sessionId || '') === String(sid) && (c.type || '') !== 'draft');
  const winbackActive = campaigns.filter(c => !!c.active);
  const winbackStats = {
    total: campaigns.length,
    active: winbackActive.length,
    recipients: campaigns.reduce((a, c) => a + (Array.isArray(c?.recipients) ? c.recipients.length : 0), 0),
    responded: campaigns.reduce((a, c) => a + (Array.isArray(c?.recipients) ? c.recipients.filter(r => r?.respondedAt).length : 0), 0)
  };

  let aiHighlights = [];
  try {
    const store = db.load('ai_transcripts', {});
    const chatsStore = store?.[sid] || {};
    const out = [];
    for (const [chatId, arr] of Object.entries(chatsStore)) {
      const items = Array.isArray(arr) ? arr : [];
      if (!items.length) continue;
      let lastTs = 0;
      let last = '';
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (!it) continue;
        const ts = Number(it?.ts || 0) || 0;
        if (ts > lastTs) lastTs = ts;
        if (!last) last = (it?.content || '').toString();
        if (lastTs && last) break;
      }
      if (!lastTs) continue;
      out.push({ chatId, lastTs, text: last.replace(/\s+/g, ' ').trim() });
    }
    out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    aiHighlights = out.slice(0, 8).map(x => ({ chatId: x.chatId, lastTs: x.lastTs, text: x.text.length > 140 ? x.text.slice(0, 140) + '…' : x.text }));
  } catch {}

  const slides = [];
  slides.push({
    kind: 'status',
    title: connected ? 'WhatsApp conectado' : 'WhatsApp desconectado',
    subtitle: waNumber ? `${waNumber}${waPushname ? ` • ${waPushname}` : ''}` : '',
    bullets: [
      `Conversas 24h: ${activeConversations}`,
      `Respostas 24h: ${responseRate}%`,
      `Contatos: ${contactsTotal}`
    ]
  });
  slides.push({
    kind: 'ai',
    title: 'IA Agente',
    subtitle: aiEnabled ? `Ativa • modo: ${aiMode}` : 'Desativada',
    bullets: [
      `Highlights: ${aiHighlights.length}`,
      `CRM colunas: ${kanbanCounts.length}`,
      `Winback ativo: ${winbackStats.active}`
    ]
  });
  if (winbackStats.total) {
    slides.push({
      kind: 'winback',
      title: 'Winback',
      subtitle: `Campanhas: ${winbackStats.total} • Ativas: ${winbackStats.active}`,
      bullets: [
        `Alvos: ${winbackStats.recipients}`,
        `Respostas: ${winbackStats.responded}`
      ]
    });
  }
  for (const h of aiHighlights.slice(0, 5)) {
    slides.push({
      kind: 'insight',
      title: 'Resumo IA',
      subtitle: String(h.chatId || ''),
      bullets: [String(h.text || '')]
    });
  }

  json(res, {
    ok: true,
    sessionId: sid,
    connected,
    waNumber,
    waPushname,
    messagesToday,
    contactsTotal,
    activeConversations,
    responseRate,
    ai: { enabled: aiEnabled, mode: aiMode },
    kanban: { columns: kanbanCounts },
    winback: winbackStats,
    slides
  });
});

route('GET', '/api/dashboard/activity/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = req.params.sessionId;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sid);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const qs = new URL(req.url, 'http://x').searchParams;
  const limit = qs.get('limit');
  json(res, { ok: true, sessionId: sid, items: getSessionActivities(sid, limit) });
});

route('POST', '/api/google/sync-contacts/:sessionId', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === req.params.sessionId);
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const token = await getGoogleAccessToken(u.id);
  const connections = [];
  let nextPageToken = '';
  for (let i = 0; i < 50; i++) {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers');
    url.searchParams.set('pageSize', '1000');
    if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
    const resp = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return err(res, data?.error?.message || 'Falha ao buscar contatos Google', 400);
    const page = Array.isArray(data?.connections) ? data.connections : [];
    connections.push(...page);
    nextPageToken = (data?.nextPageToken || '').toString();
    if (!nextPageToken) break;
  }
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
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  json(res, { status: waStatus.get(sid) || 'disconnected', qr: waLastQr.get(sid)?.qr || '' });
});

route('POST', '/api/whatsapp/disconnect', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId } = req.body;
  if (!sessionId) return err(res, 'sessionId required', 400);
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  await stopWhatsApp(sessionId);
  json(res, { ok: true });
});

route('POST', '/api/whatsapp/reset', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId } = req.body;
  if (!sessionId) return err(res, 'sessionId required');
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  try {
    await resetWhatsAppAuth(sessionId);
    json(res, { ok: true });
  } catch (e) {
    err(res, e?.message || 'Erro ao resetar sessão', 500);
  }
});

route('DELETE', '/api/session/:id', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = req.params.id;
  const sessionsAll = db.load('sessions');
  const s = sessionsAll.find(x => x.id === sid);
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  await stopWhatsApp(sid);
  db.save('sessions', sessionsAll.filter(s => s.id !== sid));
  json(res, { ok: true });
});

route('GET', '/api/whatsapp/status/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === req.params.sessionId);
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const status = waStatus.get(req.params.sessionId) || s.status || 'disconnected';
  json(res, { status, connected: status === 'connected' });
});

route('GET', '/api/whatsapp/resolve', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const sessionId = (qs.get('sessionId') || '').toString();
  const numberRaw = (qs.get('number') || qs.get('to') || '').toString();
  if (!sessionId || !numberRaw) return err(res, 'sessionId/number required', 400);
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const client = waClients.get(sessionId);
  if (!client?.info) return err(res, 'Session not connected', 400);
  const digits = digitsOnly(numberRaw);
  if (!digits || digits.length < 8) return err(res, 'Número inválido', 400);
  const waId = `${digits}@c.us`;
  let registered = null;
  try {
    if (typeof client.isRegisteredUser === 'function') {
      registered = await client.isRegisteredUser(waId);
    } else if (typeof client.getNumberId === 'function') {
      const r = await client.getNumberId(digits);
      registered = !!(r && (r._serialized || r.user || r));
    }
  } catch {}
  json(res, { ok: true, sessionId, number: digits, waId, registered });
});

route('GET', '/api/whatsapp/self/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === req.params.sessionId);
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return json(res, []);
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
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return json(res, []);
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
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return json(res, { pics: {} });
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
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);

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
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, to, message } = req.body;
  if (!sessionId || !to) return err(res, 'sessionId/to required', 400);
  const sessions = db.load('sessions');
  const s = sessions.find(x => x.id === sessionId);
  if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const client = waClients.get(sessionId);
  if (!client?.info) return err(res, 'Session not connected');
  const toStr = (to || '').toString().trim();
  const digits = digitsOnly(toStr);
  const toNorm = toStr.includes('@') ? toStr : (digits ? `${digits}@c.us` : toStr);
  if (!toNorm.includes('@')) return err(res, 'Destino inválido', 400);
  try {
    if (toNorm.endsWith('@c.us') && typeof client.isRegisteredUser === 'function') {
      const ok = await client.isRegisteredUser(toNorm);
      if (!ok) return err(res, 'Este número não possui WhatsApp', 400);
    }
  } catch {}
  try {
    await client.sendMessage(toNorm, message);
    let createdLocal = false;
    try {
      if (toNorm.endsWith('@c.us')) {
        const contacts = db.load('contacts', []);
        const existing = contacts.find(c => String(c?.sessionId || '') === String(sessionId) && String((c?.waId || c?.id || '')).toLowerCase() === String(toNorm).toLowerCase()) || null;
        if (!existing) {
          contacts.push({
            id: toNorm,
            waId: toNorm,
            sessionId,
            userId: s.userId,
            name: '',
            number: digits || null,
            email: '',
            note: '',
            source: 'wa',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          db.save('contacts', contacts);
          createdLocal = true;
        }
      }
    } catch {}
    try {
      const prefs = getUserPrefs(u.id);
      const tokenItem = getGoogleTokenItem(u.id);
      if (createdLocal && prefs.googleAutoSaveContacts && tokenItem?.access_token) {
        await googleCreateOrUpdateContact(u.id, { number: digits || null, name: '', email: '' });
      }
    } catch {}
    appendActivity(sessionId, u.id, 'wa.send', 'Mensagem enviada', { to: toNorm, hasText: !!String(message || '').trim() });
    json(res, { ok: true, to: toNorm });
  } catch (e) {
    err(res, e.message, 500);
  }
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
    if (!s || (s.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return json(res, { runs: [] });
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
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const config = db.load('ai_config', {});
  const cfg = config[req.params.sessionId] || { enabled: false, provider: 'openai', model: 'gpt-4o-mini' };
  const { apiKey, ...rest } = (cfg || {});
  json(res, { ...rest, apiKeySet: !!apiKey, apiKeyHint: (cfg?.apiKeyHint || null) });
});

route('POST', '/api/ai-config/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const qs = new URL(req.url, 'http://x').searchParams;
  const limitRaw = qs.get('limit');
  const offsetRaw = qs.get('offset');
  const q = (qs.get('q') || '').toString().trim().toLowerCase();
  const wantPaging = (limitRaw !== null) || (offsetRaw !== null) || !!q;
  const limit = Math.max(1, Math.min(5000, Number(limitRaw || 0) || 0));
  const offset = Math.max(0, Number(offsetRaw || 0) || 0);

  const contactsAll = db.load('contacts').filter(c => c.sessionId === req.params.sessionId);
  let contacts = contactsAll;
  if (q) {
    contacts = contactsAll.filter(c => {
      const name = (c?.name || '').toString().toLowerCase();
      const number = (c?.number || '').toString().toLowerCase();
      const waId = (c?.waId || c?.id || '').toString().toLowerCase();
      const note = (c?.note || '').toString().toLowerCase();
      const email = (c?.email || '').toString().toLowerCase();
      return name.includes(q) || number.includes(q) || waId.includes(q) || note.includes(q) || email.includes(q);
    });
  }
  let changed = false;
  for (const c of contactsAll) {
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
    const map = new Map(contactsAll.map(x => [x.id, x]));
    const merged = all.map(x => map.get(x.id) || x);
    db.save('contacts', merged);
  }
  if (!wantPaging) return json(res, contactsAll);
  const total = contacts.length;
  const items = (limit ? contacts.slice(offset, offset + limit) : contacts.slice(offset));
  json(res, { ok: true, total, offset, limit: limit || null, items });
});

route('POST', '/api/contacts/:sessionId', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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
  const birthDateRaw = (req.body.birthDate || req.body.birthday || '').toString().trim();
  let birthDate = null;
  if (birthDateRaw) {
    const m = birthDateRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return err(res, 'Data de nascimento inválida (use AAAA-MM-DD)', 400);
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
    if (!Number.isFinite(dt.getTime()) || (dt.getUTCFullYear() !== y) || (dt.getUTCMonth() !== (mo - 1)) || (dt.getUTCDate() !== d)) {
      return err(res, 'Data de nascimento inválida', 400);
    }
    birthDate = `${m[1]}-${m[2]}-${m[3]}`;
  }
  const nowIso = new Date().toISOString();
  const existing = contacts.find(c => c.id === id) || null;
  const contact = {
    ...req.body,
    waId: waId || req.body.waId,
    number: number || null,
    birthDate,
    sessionId: req.params.sessionId,
    userId: sess.userId,
    id,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso
  };
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx >= 0) contacts[idx] = contact; else contacts.push(contact);
  db.save('contacts', contacts);
  let googleSync = null;
  try {
    const prefs = getUserPrefs(u.id);
    const tokenItem = getGoogleTokenItem(u.id);
    if (prefs.googleAutoSaveContacts && tokenItem?.access_token) {
      googleSync = await googleCreateOrUpdateContact(u.id, contact);
    }
  } catch (e) {
    googleSync = { ok: false, error: (e?.message || 'Falha ao salvar no Google').toString() };
  }
  appendActivity(req.params.sessionId, u.id, 'contact.save', 'Contato salvo', { waId: contact.waId || contact.id || null, name: contact.name || '' });
  json(res, { ...contact, googleSync });
});

// ── Scheduled ─────────────────────────────────────────────────────────
route('GET', '/api/scheduled/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return json(res, []);
  json(res, db.load('scheduled_messages').filter(s => s.sessionId === req.params.sessionId));
});

route('POST', '/api/scheduled', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId } = req.body || {};
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const scheduled = db.load('scheduled_messages');
  const item = { ...req.body, id: req.body.id || uuid(), sent: false, createdAt: new Date().toISOString() };
  scheduled.push(item); db.save('scheduled_messages', scheduled); json(res, item);
});

route('POST', '/api/scheduled/group-bulk', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, targets, payloadType, message, flowId, startTime } = req.body || {};
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
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

route('POST', '/api/scheduled/birthday-bulk', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, contactIds, message, timeOfDay } = req.body || {};
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const ids = Array.isArray(contactIds) ? contactIds.map(x => (x || '').toString()).filter(Boolean) : [];
  if (!ids.length) return err(res, 'Selecione pelo menos 1 contato', 400);
  const template = (message || '').toString();
  if (!template.trim()) return err(res, 'Mensagem vazia', 400);
  const tod = (timeOfDay || '09:00').toString().trim();
  const m = tod.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return err(res, 'Horário inválido (use HH:MM)', 400);
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  const contactsAll = db.load('contacts', []).filter(c => c.sessionId === sessionId);
  const byId = new Map(contactsAll.map(c => [(c.waId || c.id), c]));
  const now = new Date();
  const nowTs = now.getTime();
  const scheduled = db.load('scheduled_messages');
  let created = 0;
  for (const cid of ids) {
    const c = byId.get(cid) || null;
    const bd = (c?.birthDate || '').toString();
    const mm2 = bd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!mm2) continue;
    const month = Number(mm2[2]) - 1;
    const day = Number(mm2[3]);
    const year = now.getFullYear();
    let dt = new Date(year, month, day, hh, mm, 0, 0);
    if (!Number.isFinite(dt.getTime())) continue;
    if (dt.getTime() <= nowTs + 60_000) dt = new Date(year + 1, month, day, hh, mm, 0, 0);
    const ts = Math.floor(dt.getTime() / 1000);
    const to = (c?.waId || c?.id || '').toString();
    if (!to) continue;
    scheduled.push({
      id: uuid(),
      sessionId,
      kind: 'birthday',
      payloadType: 'text',
      message: template,
      to,
      scheduledTime: ts,
      sent: false,
      createdAt: new Date().toISOString()
    });
    created += 1;
  }
  db.save('scheduled_messages', scheduled);
  json(res, { ok: true, created });
});

route('DELETE', '/api/scheduled/:id', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  let items = db.load('scheduled_messages');
  const found = items.find(x => x.id === req.params.id);
  if (!found) return json(res, { ok: true });
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === found.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  items = items.filter(x => x.id !== req.params.id);
  db.save('scheduled_messages', items);
  json(res, { ok: true });
});

// ── WinBack ───────────────────────────────────────────────────────────
route('GET', '/api/winback/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  json(res, db.load('winback_campaigns').filter(c => c.sessionId === req.params.sessionId));
});

route('GET', '/api/winback/logs/:id', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const campaigns = db.load('winback_campaigns', []);
  const found = campaigns.find(x => x.id === req.params.id) || null;
  if (!found) return json(res, { ok: true, items: [] });
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === found.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const qs = new URL(req.url, 'http://x').searchParams;
  const limit = qs.get('limit');
  json(res, { ok: true, campaignId: found.id, sessionId: found.sessionId, items: getWinbackLogs(found.id, limit) });
});

route('POST', '/api/winback', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessionId = (req.body?.sessionId || '').toString();
  if (!sessionId) return err(res, 'sessionId required', 400);
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const campaigns = db.load('winback_campaigns', []);
  const existing = campaigns.find(c => c.id === req.body.id) || null;
  const nowIso = new Date().toISOString();
  const recipientsRaw = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
  const uniq = new Map();
  const existingByChat = new Map(Array.isArray(existing?.recipients) ? existing.recipients.map(r => [String(r?.chatId || r?.id || ''), r]) : []);
  for (const r of recipientsRaw) {
    const chatId = (r?.chatId || r?.id || r || '').toString();
    if (!chatId) continue;
    if (uniq.has(chatId)) continue;
    const prev = existingByChat.get(chatId) || null;
    uniq.set(chatId, {
      chatId,
      name: (r?.name || '').toString(),
      addedAt: r?.addedAt || nowIso,
      firstSentAt: r?.firstSentAt || null,
      lastSentAt: r?.lastSentAt || null,
      sentCount: Number(r?.sentCount || 0),
      respondedAt: r?.respondedAt || null,
      anchorSec: Number(r?.anchorSec ?? prev?.anchorSec ?? 0) || 0,
      nextSendAt: Number(r?.nextSendAt ?? prev?.nextSendAt ?? 0) || 0
    });
  }
  const recipients = Array.from(uniq.values()).slice(0, 100);
  if (recipients.length > 100) return err(res, 'Máximo 100 contatos por Winback', 400);
  const startedAt = existing?.startedAt || req.body?.startedAt || null;
  const durationDays = Number(req.body?.durationDays || existing?.durationDays || 7);
  if (startedAt) {
    const startTs = Date.parse(startedAt) || 0;
    const windowEnd = startTs ? (startTs + Math.max(1, durationDays) * 24 * 3600 * 1000) : 0;
    if (windowEnd && Date.now() < windowEnd) {
      const prev = new Set((existing?.recipients || []).map(x => (x?.chatId || '').toString()).filter(Boolean));
      for (const r of recipients) {
        if (!prev.has(r.chatId)) return err(res, 'Não é possível adicionar novos contatos após iniciar (aguarde 7 dias)', 400);
      }
    }
  }
  const campaign = {
    ...existing,
    ...req.body,
    id: req.body.id || uuid(),
    sessionId,
    userId: sess.userId,
    name: (req.body?.name || existing?.name || 'Winback').toString(),
    message: (req.body?.message || existing?.message || '').toString(),
    recipients,
    intervalHours: Number(req.body?.intervalHours || existing?.intervalHours || 4),
    durationDays,
    maxRecipients: 100,
    active: !!req.body?.active,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso
  };
  const idx = campaigns.findIndex(c => c.id === campaign.id);
  if (idx >= 0) campaigns[idx] = campaign; else campaigns.push(campaign);
  db.save('winback_campaigns', campaigns); json(res, campaign);
});

route('DELETE', '/api/winback/:id', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  let c = db.load('winback_campaigns', []);
  const found = c.find(x => x.id === req.params.id) || null;
  if (!found) return json(res, { ok: true });
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === found.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  db.save('winback_campaigns', c.filter(x => x.id !== req.params.id)); json(res, { ok: true });
});

route('POST', '/api/winback/start/:id', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const campaigns = db.load('winback_campaigns', []);
  const idx = campaigns.findIndex(x => x.id === req.params.id);
  if (idx < 0) return err(res, 'Not found', 404);
  const found = campaigns[idx];
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === found.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  found.active = true;
  if (!found.startedAt) found.startedAt = new Date().toISOString();
  found.updatedAt = new Date().toISOString();
  campaigns[idx] = found;
  db.save('winback_campaigns', campaigns);
  appendWinbackLog(found.id, found.sessionId, { status: 'start', title: 'Winback iniciado' });
  json(res, { ok: true, campaign: found });
});

route('POST', '/api/winback/stop/:id', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const campaigns = db.load('winback_campaigns', []);
  const idx = campaigns.findIndex(x => x.id === req.params.id);
  if (idx < 0) return err(res, 'Not found', 404);
  const found = campaigns[idx];
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === found.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  found.active = false;
  found.updatedAt = new Date().toISOString();
  campaigns[idx] = found;
  db.save('winback_campaigns', campaigns);
  appendWinbackLog(found.id, found.sessionId, { status: 'stop', title: 'Winback pausado' });
  json(res, { ok: true, campaign: found });
});

route('GET', '/api/winback/draft/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === req.params.sessionId);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const id = `draft_${req.params.sessionId}`;
  const campaigns = db.load('winback_campaigns', []);
  const found = campaigns.find(x => x.id === id) || null;
  json(res, found || { id, sessionId: req.params.sessionId, type: 'draft', recipients: [], active: false });
});

route('POST', '/api/winback/draft/add', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, chatId } = req.body || {};
  const sid = (sessionId || '').toString();
  const cid = (chatId || '').toString();
  if (!sid || !cid) return err(res, 'sessionId/chatId required', 400);
  const sessions = db.load('sessions');
  const sess = sessions.find(x => x.id === sid);
  if (!sess || (sess.userId !== u.id && !isAdminRole(u))) return err(res, 'Forbidden', 403);
  const contacts = db.load('contacts', []).filter(c => c.sessionId === sid);
  const contact = contacts.find(c => (c.waId || c.id) === cid) || null;
  const name = (req.body?.name || contact?.name || '').toString();
  const nowIso = new Date().toISOString();
  const id = `draft_${sid}`;
  const campaigns = db.load('winback_campaigns', []);
  let draft = campaigns.find(x => x.id === id) || { id, sessionId: sid, userId: sess.userId, type: 'draft', name: 'Rascunho', message: '', recipients: [], active: false, createdAt: nowIso };
  const rec = Array.isArray(draft.recipients) ? draft.recipients : [];
  if (!rec.find(r => (r?.chatId || r?.id || '') === cid)) rec.push({ chatId: cid, name, addedAt: nowIso, firstSentAt: null, lastSentAt: null, sentCount: 0, respondedAt: null, anchorSec: 0, nextSendAt: 0 });
  draft.recipients = rec.slice(0, 100);
  draft.updatedAt = nowIso;
  const idx = campaigns.findIndex(x => x.id === id);
  if (idx >= 0) campaigns[idx] = draft; else campaigns.push(draft);
  db.save('winback_campaigns', campaigns);

  const kanban = db.load('kanban', {});
  const board = kanban[sid] || null;
  if (board && Array.isArray(board.columns)) {
    let col = board.columns.find(x => x.id === 'winback');
    if (!col) {
      col = { id: 'winback', name: 'Winback', color: '#8e44ad', chats: [] };
      board.columns.push(col);
    }
    if (!Array.isArray(col.chats)) col.chats = [];
    if (!col.chats.includes(cid)) col.chats.push(cid);
    kanban[sid] = board;
    db.save('kanban', kanban);
  }

  json(res, { ok: true, draft });
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

  const match = matchRoute(req.method, url);
  if (match) {
    req.params = match.params;
    req.body = (req.method === 'GET' || req.method === 'HEAD') ? {} : await parseBody(req);
    try { await match.handler(req, res); }
    catch (e) { console.error('Route error:', e); err(res, e.message, 500); }
    return;
  }

  // API not found
  if (url.startsWith('/api/')) { err(res, 'Not found', 404); return; }

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

function markWinbackResponded(sessionId, chatId) {
  try {
    const campaigns = db.load('winback_campaigns', []);
    let changed = false;
    for (const c of campaigns) {
      if (!c || !c.active) continue;
      if ((c.sessionId || '') !== sessionId) continue;
      const recipients = Array.isArray(c.recipients) ? c.recipients : [];
      const r = recipients.find(x => (x?.chatId || x?.id || '') === chatId) || null;
      if (!r || r.respondedAt) continue;
      r.respondedAt = new Date().toISOString();
      c.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) db.save('winback_campaigns', campaigns);
  } catch {}
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
      appendActivity(sessionId, userId, 'wa.qr', 'QR gerado (aguardando leitura)', null);
    });
    client.on('ready', () => {
      waStatus.set(sessionId, 'connected');
      waLastQr.delete(sessionId);
      if (io) io.to(sessionId).emit('ready', { sessionId });
      const sessions = db.load('sessions');
      const s = sessions.find(x => x.id === sessionId);
      if (s) { s.status = 'connected'; db.save('sessions', sessions); }
      appendActivity(sessionId, userId, 'wa.ready', 'WhatsApp conectado', null);
    });
    client.on('disconnected', (reason) => {
      waStatus.set(sessionId, 'disconnected');
      waClients.delete(sessionId);
      waLastQr.delete(sessionId);
      if (io) io.to(sessionId).emit('disconnected', { sessionId, reason });
      appendActivity(sessionId, userId, 'wa.disconnected', 'WhatsApp desconectado', { reason: String(reason || '') });
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
    appendActivity(sessionId, userId, 'wa.inbound', 'Nova mensagem recebida', { chatId, type: msgData.type });
    if (!msg.fromMe) {
      markWinbackResponded(sessionId, chatId);
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
    appendActivity(sessionId, userId, 'wa.outbound', 'Mensagem enviada', { chatId: msg.to, type: msgData.type });
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

  function renderTemplateForChat(sessionId, chatId, template) {
    const t = (template ?? '').toString();
    if (!t) return '';
    const contacts = db.load('contacts', []).filter(c => c.sessionId === sessionId);
    const found = contacts.find(c => (c.waId || c.id) === chatId) || null;
    const full = ((found?.name || '').toString().trim()) || '';
    const first = full.split(/\s+/).filter(Boolean)[0] || full;
    return t
      .replace(/\[\s*username\s*\]/gi, full || first || '')
      .replace(/\{\{\s*name\s*\}\}/gi, full || first || '')
      .replace(/\{\{\s*first_name\s*\}\}/gi, first || full || '');
  }

  async function sendScheduledPayload(item, client, chatId) {
    const payloadType = item.payloadType || (item.flowId ? 'flow' : 'text');
    if (payloadType === 'flow') {
      const flowId = item.flowId;
      if (flowId) await startFlowById(item.sessionId, chatId, flowId, client);
      return;
    }
    const message = renderTemplateForChat(item.sessionId, chatId, (item.message ?? item.msg ?? '').toString());
    if (!message.trim()) return;
    try { await client.sendMessage(chatId, message); } catch {}
  }

  function normalizeWinbackCampaign(c) {
    const campaign = c || {};
    const intervalHours = Number(campaign.intervalHours || 4);
    const durationDays = Number(campaign.durationDays || 7);
    const maxRecipients = Number(campaign.maxRecipients || 100);
    const recipients = Array.isArray(campaign.recipients) ? campaign.recipients : [];
    const uniq = new Map();
    for (const r of recipients) {
      const chatId = (r?.chatId || r?.id || r || '').toString();
      if (!chatId) continue;
      if (uniq.has(chatId)) continue;
      uniq.set(chatId, {
        chatId,
        name: (r?.name || '').toString(),
        addedAt: r?.addedAt || null,
        firstSentAt: r?.firstSentAt || null,
        lastSentAt: r?.lastSentAt || null,
        sentCount: Number(r?.sentCount || 0),
        respondedAt: r?.respondedAt || null,
        anchorSec: Number(r?.anchorSec || 0) || 0,
        nextSendAt: Number(r?.nextSendAt || 0) || 0
      });
    }
    return {
      ...campaign,
      intervalHours: Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 4,
      durationDays: Number.isFinite(durationDays) && durationDays > 0 ? durationDays : 7,
      maxRecipients: Number.isFinite(maxRecipients) && maxRecipients > 0 ? maxRecipients : 100,
      recipients: Array.from(uniq.values())
    };
  }

  async function tickWinback(nowSec) {
    const campaigns = db.load('winback_campaigns', []);
    let changed = false;
    for (let i = 0; i < campaigns.length; i++) {
      let c = normalizeWinbackCampaign(campaigns[i]);
      if (!c.active) continue;
      const sessionId = (c.sessionId || '').toString();
      if (!sessionId) continue;
      const client = waClients.get(sessionId);
      if (!client?.info) continue;
      const startedAt = Date.parse(c.startedAt || '') || 0;
      const startSec = startedAt ? Math.floor(startedAt / 1000) : 0;
      const durationSec = Math.floor((Number(c.durationDays || 7) * 24 * 3600));
      if (!startSec) {
        c.startedAt = new Date().toISOString();
        changed = true;
        appendWinbackLog(c.id, sessionId, { status: 'start', title: 'Winback iniciado (cron)' });
      }
      const startSec2 = startSec || nowSec;
      const endSec = startSec2 + durationSec;
      if (nowSec >= endSec) {
        c.active = false;
        c.endedAt = new Date().toISOString();
        campaigns[i] = c;
        changed = true;
        appendWinbackLog(c.id, sessionId, { status: 'end', title: 'Winback finalizado' });
        continue;
      }
      const intervalSec = Math.floor((Number(c.intervalHours || 4) * 3600));
      const template = (c.message || '').toString();
      if (!template.trim()) continue;
      const recipients = Array.isArray(c.recipients) ? c.recipients : [];
      const spreadWindowSec = Math.min(1800, Math.max(300, recipients.length * 12));
      const graceSec = 5 * 60;
      const maxPerTick = 3;

      const stable = recipients.slice().sort((a, b) => String(a?.chatId || '').localeCompare(String(b?.chatId || '')));
      for (let idx = 0; idx < stable.length; idx++) {
        const r = stable[idx];
        if (r.respondedAt) continue;
        const chatId = (r.chatId || '').toString();
        if (!chatId) continue;
        if (!Number(r.anchorSec || 0)) {
          r.anchorSec = startSec2 + randInt(30, spreadWindowSec);
          r.nextSendAt = Number(r.nextSendAt || 0) || r.anchorSec;
          changed = true;
        }
        if (!Number(r.nextSendAt || 0)) {
          r.nextSendAt = r.anchorSec;
          changed = true;
        }
      }

      const due = recipients
        .filter(r => r && !r.respondedAt && (Number(r.nextSendAt || 0) || 0) > 0)
        .sort((a, b) => (Number(a.nextSendAt || 0) || 0) - (Number(b.nextSendAt || 0) || 0));

      let sentThisTick = 0;
      for (const r of due) {
        if (sentThisTick >= maxPerTick) break;
        const chatId = (r.chatId || '').toString();
        if (!chatId) continue;
        const nextAt = Number(r.nextSendAt || 0) || 0;
        if (!nextAt || nowSec < nextAt) break;
        if (nowSec > (nextAt + graceSec)) {
          const k = Math.floor((nowSec - r.anchorSec) / intervalSec) + 1;
          r.nextSendAt = r.anchorSec + (k * intervalSec);
          changed = true;
          appendWinbackLog(c.id, sessionId, { status: 'skip', chatId, title: 'Envio perdido (reagendado)', scheduledAt: nextAt });
          continue;
        }
        const msg = renderTemplateForChat(sessionId, chatId, template);
        if (!msg.trim()) continue;
        try {
          await client.sendMessage(chatId, msg);
          appendWinbackLog(c.id, sessionId, { status: 'sent', chatId, title: 'Mensagem enviada', scheduledAt: nextAt, preview: msg.slice(0, 120) });
        } catch (e) {
          appendWinbackLog(c.id, sessionId, { status: 'fail', chatId, title: 'Falha ao enviar', scheduledAt: nextAt, error: (e?.message || 'Erro').toString() });
          const k = Math.floor((nowSec - r.anchorSec) / intervalSec) + 1;
          r.nextSendAt = r.anchorSec + (k * intervalSec);
          changed = true;
          continue;
        }
        const nowIso = new Date().toISOString();
        if (!r.firstSentAt) r.firstSentAt = nowIso;
        r.lastSentAt = nowIso;
        r.sentCount = Number(r.sentCount || 0) + 1;
        const k2 = Math.floor((nowSec - r.anchorSec) / intervalSec) + 1;
        r.nextSendAt = r.anchorSec + (k2 * intervalSec);
        changed = true;
        sentThisTick += 1;
      }
      campaigns[i] = c;
    }
    if (changed) db.save('winback_campaigns', campaigns);
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
    await tickWinback(now);
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
