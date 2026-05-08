// ═══════════════════════════════════════════════════════════════════════
//  ZAPMRO CLOUD v2.0 - Server (Node.js built-ins + optional packages)
//  Works with or without npm packages installed
// ═══════════════════════════════════════════════════════════════════════
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, randomBytes, createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zapmro-2024-secret';

// ── Optional package imports (graceful degradation) ──────────────────
let express, Server, Client, LocalAuth, qrcode, OpenAI, cron, multer, bcryptjs, jwt, createClient, uuid;
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
  Client = wa.Client; LocalAuth = wa.LocalAuth;
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

// ── DB ────────────────────────────────────────────────────────────────
const DATA = join(ROOT, 'data');
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

['users','sessions','scheduled_messages','tags','contacts','winback_campaigns'].forEach(f => db.ensure(f));
['flows','ai_config','kanban','ai_chat_status'].forEach(f => db.ensure(f, {}));

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
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};

// ── WhatsApp State ────────────────────────────────────────────────────
const waClients = new Map();
const waStatus = new Map();
const chatHistory = new Map();
const pendingAI = new Map();

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
  let filePath = join(ROOT, 'Public', requestPath);
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
  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=300' });
  res.end(readFileSync(filePath));
}

// ══════════════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════════════

// ── Health ────────────────────────────────────────────────────────────
route('GET', '/api/health', (req, res) => {
  json(res, { ok: true, version: '2.0', uptime: process.uptime(), packages: { express: hasExpress, socketio: hasSocket, whatsapp: hasWA } });
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
  if (password && !bcryptjs.compareSync(password, user.password)) return err(res, 'Senha incorreta');
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

// ── Sessions ──────────────────────────────────────────────────────────
route('GET', '/api/active-sessions', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sessions = db.load('sessions').filter(s => s.userId === u.id);
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
  if (hasWA) initWhatsApp(sessionId, u.id);
  json(res, { ok: true, sessionId });
});

route('POST', '/api/whatsapp/connect', async (req, res) => {
  const { sessionId, userId } = req.body;
  if (!sessionId) return err(res, 'sessionId required');
  if (hasWA) initWhatsApp(sessionId, userId || sessionId);
  json(res, { ok: true, sessionId, waAvailable: hasWA });
});

route('POST', '/api/whatsapp/disconnect', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId } = req.body;
  const client = waClients.get(sessionId);
  if (client) { try { await client.destroy(); } catch {} waClients.delete(sessionId); }
  waStatus.set(sessionId, 'disconnected');
  json(res, { ok: true });
});

route('DELETE', '/api/session/:id', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const client = waClients.get(req.params.id);
  if (client) { try { await client.destroy(); } catch {} waClients.delete(req.params.id); }
  let sessions = db.load('sessions');
  sessions = sessions.filter(s => s.id !== req.params.id);
  db.save('sessions', sessions);
  json(res, { ok: true });
});

route('GET', '/api/whatsapp/status/:sessionId', (req, res) => {
  const status = waStatus.get(req.params.sessionId) || 'disconnected';
  json(res, { status, connected: status === 'connected' });
});

// ── WhatsApp Operations ───────────────────────────────────────────────
route('GET', '/api/whatsapp/chats', async (req, res) => {
  const qs = new URL(req.url, 'http://x').searchParams;
  const sessionId = qs.get('sessionId');
  const client = waClients.get(sessionId);
  if (!client?.info) return json(res, []);
  try {
    const chats = await client.getChats();
    const result = await Promise.all(chats.slice(0, 60).map(async c => {
      let pic = '';
      try { pic = await client.getProfilePicUrl(c.id._serialized) || ''; } catch {}
      return { id: c.id._serialized, name: c.name || c.id.user, pic: pic || `https://ui-avatars.com/api/?name=${encodeURIComponent(c.name||'U')}&background=128c7e&color=fff`, isGroup: c.isGroup, unread: c.unreadCount || 0, timestamp: c.timestamp, lastMessage: c.lastMessage ? { body: c.lastMessage.body, fromMe: c.lastMessage.fromMe } : null };
    }));
    json(res, result);
  } catch { json(res, []); }
});

route('GET', '/api/whatsapp/messages/:chatId', async (req, res) => {
  const qs = new URL(req.url, 'http://x').searchParams;
  const sessionId = qs.get('sessionId');
  const chatId = req.params.chatId;
  const history = getHistory(sessionId, chatId);
  if (!history.length) {
    const client = waClients.get(sessionId);
    if (client?.info) {
      try {
        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 50 });
        messages.forEach(msg => addToHistory(sessionId, chatId, { id: msg.id.id, body: msg.body, fromMe: msg.fromMe, timestamp: msg.timestamp, type: msg.type }));
        return json(res, getHistory(sessionId, chatId));
      } catch {}
    }
  }
  json(res, history);
});

route('POST', '/api/whatsapp/send', async (req, res) => {
  const { sessionId, to, message } = req.body;
  const client = waClients.get(sessionId);
  if (!client?.info) return err(res, 'Session not connected');
  try { await client.sendMessage(to, message); json(res, { ok: true }); }
  catch (e) { err(res, e.message, 500); }
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

route('DELETE', '/api/flows/:sessionId/:flowId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const flows = db.load('flows', {});
  if (flows[req.params.sessionId]) flows[req.params.sessionId] = flows[req.params.sessionId].filter(f => f.id !== req.params.flowId);
  db.save('flows', flows); json(res, { ok: true });
});

// ── AI Config ─────────────────────────────────────────────────────────
route('GET', '/api/ai-config/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const config = db.load('ai_config', {});
  json(res, config[req.params.sessionId] || { enabled: false, provider: 'openai', model: 'gpt-4o-mini' });
});

route('POST', '/api/ai-config/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const config = db.load('ai_config', {});
  config[req.params.sessionId] = { ...config[req.params.sessionId], ...req.body, updatedAt: new Date().toISOString() };
  db.save('ai_config', config); json(res, { ok: true });
});

route('POST', '/api/ai-chat-status', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { sessionId, chatId, enabled } = req.body;
  const statuses = db.load('ai_chat_status', {});
  statuses[`${sessionId}:${chatId}`] = enabled;
  db.save('ai_chat_status', statuses); json(res, { ok: true });
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
  json(res, db.load('contacts').filter(c => c.sessionId === req.params.sessionId));
});

route('POST', '/api/contacts/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const contacts = db.load('contacts');
  const contact = { ...req.body, sessionId: req.params.sessionId, id: req.body.id || uuid(), updatedAt: new Date().toISOString() };
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx >= 0) contacts[idx] = contact; else contacts.push(contact);
  db.save('contacts', contacts); json(res, contact);
});

// ── Scheduled ─────────────────────────────────────────────────────────
route('GET', '/api/scheduled/:sessionId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  json(res, db.load('scheduled_messages').filter(s => s.sessionId === req.params.sessionId));
});

route('POST', '/api/scheduled', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const scheduled = db.load('scheduled_messages');
  const item = { ...req.body, id: req.body.id || uuid(), sent: false, createdAt: new Date().toISOString() };
  scheduled.push(item); db.save('scheduled_messages', scheduled); json(res, item);
});

route('DELETE', '/api/scheduled/:id', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  let s = db.load('scheduled_messages');
  db.save('scheduled_messages', s.filter(x => x.id !== req.params.id)); json(res, { ok: true });
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
  hist.push(msg);
  if (hist.length > 100) hist.shift();
  const histDir = join(DATA, 'history');
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
  const fp = join(histDir, `${sessionId}_${chatId.replace(/\W/g, '_')}.json`);
  try {
    let existing = existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : [];
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

async function initWhatsApp(sessionId, userId) {
  if (!hasWA || waClients.has(sessionId)) return;
  console.log(`🔄 Init WA session: ${sessionId}`);
  waStatus.set(sessionId, 'initializing');
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: join(ROOT, '.wwebjs_auth') }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }
  });
  client.on('qr', async (qr) => {
    waStatus.set(sessionId, 'qr');
    const qrImg = qrcode ? await qrcode.toDataURL(qr) : '';
    if (io) { io.to(userId).emit('qr', { sessionId, qr: qrImg }); io.to(sessionId).emit('qr', qrImg); }
  });
  client.on('ready', () => {
    waStatus.set(sessionId, 'connected');
    if (io) { io.to(userId).emit('ready', { sessionId }); io.to(sessionId).emit('ready'); }
    const sessions = db.load('sessions');
    const s = sessions.find(x => x.id === sessionId);
    if (s) { s.status = 'connected'; db.save('sessions', sessions); }
  });
  client.on('disconnected', (reason) => {
    waStatus.set(sessionId, 'disconnected');
    waClients.delete(sessionId);
    if (io) { io.to(userId).emit('disconnected', { sessionId }); io.to(sessionId).emit('disconnected', reason); }
  });
  client.on('message', async (msg) => {
    const chatId = msg.from;
    const msgData = { id: msg.id.id, body: msg.body, fromMe: false, timestamp: msg.timestamp, type: msg.type };
    addToHistory(sessionId, chatId, msgData);
    if (io) { io.to(userId).emit('new-message', { sessionId, chatId, message: msgData }); io.to(sessionId).emit('new-message', { chatId, message: msgData }); }
    if (!msg.fromMe) {
      await handleFlows(sessionId, chatId, msg, client, userId);
      handleAIDebounced(sessionId, userId, chatId, msg, client);
    }
  });
  client.on('message_create', (msg) => {
    if (!msg.fromMe) return;
    const msgData = { id: msg.id.id, body: msg.body, fromMe: true, timestamp: msg.timestamp, type: msg.type };
    addToHistory(sessionId, msg.to, msgData);
    if (io) io.to(userId).emit('new-message', { sessionId, chatId: msg.to, message: msgData });
  });
  client.initialize().catch(e => { console.error('WA init error:', e.message); waStatus.set(sessionId, 'error'); waClients.delete(sessionId); });
  waClients.set(sessionId, client);
}

async function handleFlows(sessionId, chatId, msg, client, userId) {
  const flows = (db.load('flows', {})[sessionId] || []).filter(f => f.active);
  for (const flow of flows) {
    let triggered = false;
    if (flow.trigger === 'keyword' && flow.keyword) triggered = msg.body?.toLowerCase().includes(flow.keyword.toLowerCase());
    else if (flow.trigger === 'first_message') triggered = getHistory(sessionId, chatId).length === 1;
    else if (flow.trigger === 'any') triggered = true;
    if (!triggered) continue;
    for (const step of (flow.steps || [])) {
      if (step.delay) await new Promise(r => setTimeout(r, step.delay * 1000));
      if (step.type === 'message' && step.content) await client.sendMessage(chatId, step.content);
    }
    break;
  }
}

function handleAIDebounced(sessionId, userId, chatId, msg, client) {
  const key = `${sessionId}:${chatId}`;
  if (pendingAI.has(key)) clearTimeout(pendingAI.get(key));
  const t = setTimeout(() => { pendingAI.delete(key); handleAI(sessionId, userId, chatId, msg, client); }, 2000);
  pendingAI.set(key, t);
}

async function handleAI(sessionId, userId, chatId, msg, client) {
  if (!hasOpenAI) return;
  const config = db.load('ai_config', {})[sessionId];
  if (!config?.enabled) return;
  const chatStatuses = db.load('ai_chat_status', {});
  if (chatStatuses[`${sessionId}:${chatId}`] === false) return;
  if (config.keywordTrigger && !msg.body?.toLowerCase().includes(config.keywordTrigger.toLowerCase())) return;
  try {
    const openai = new OpenAI({ apiKey: config.apiKey || process.env.OPENAI_API_KEY });
    const history = getHistory(sessionId, chatId).slice(-10).map(m => ({ role: m.fromMe ? 'assistant' : 'user', content: m.body || '' })).filter(m => m.content);
    const response = await openai.chat.completions.create({ model: config.model || 'gpt-4o-mini', messages: [{ role: 'system', content: config.prompt || 'Você é um assistente comercial profissional.' }, ...history], max_tokens: 500 });
    const reply = response.choices[0].message.content;
    if (reply) {
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
      await client.sendMessage(chatId, reply);
      if (io) io.to(userId).emit('ai-replied', { sessionId, chatId, reply });
    }
  } catch (e) { console.error('AI error:', e.message); }
}

// ── Scheduled messages cron ───────────────────────────────────────────
if (hasCron) {
  cron.schedule('* * * * *', async () => {
    const now = Math.floor(Date.now() / 1000);
    const scheduled = db.load('scheduled_messages');
    let changed = false;
    for (const s of scheduled) {
      if (s.sent || s.scheduledTime > now) continue;
      const client = waClients.get(s.sessionId);
      if (!client?.info) continue;
      try { await client.sendMessage(s.to, s.message); s.sent = true; s.sentAt = new Date().toISOString(); changed = true; if (io) io.to(s.sessionId).emit('scheduled-sent', s); }
      catch {}
    }
    if (changed) db.save('scheduled_messages', scheduled);
  });
  console.log('✅ Cron scheduler initialized');
}

// ── Restore sessions on startup ───────────────────────────────────────
async function restoreSessions() {
  if (!hasWA) return;
  const authPath = join(ROOT, '.wwebjs_auth');
  if (!existsSync(authPath)) return;
  const sessions = db.load('sessions');
  for (const session of sessions) {
    if (session.status === 'connected') {
      const sessionPath = join(authPath, `session-${session.id}`);
      if (existsSync(sessionPath)) {
        console.log(`🔄 Restoring: ${session.id}`);
        await initWhatsApp(session.id, session.userId);
      }
    }
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
