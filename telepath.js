// telepath.js — Drafts Telepath: control-plane Telegram bot for Drafts servers.
//
// v0.5: project bots integration. Each PAP project can attach its own
// Telegram bot via the PAP WebApp dashboard. Project bots are managed
// by the project-bots.js module (independent long-pollers, profile sync,
// broadcast). This file exposes the management endpoints and renders
// the WebApp UI for them.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { projectBotsApi } from './project-bots.js';

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
let DRAFTS_DIR = null;
let PUBLIC_BASE = null;
let SERVER_NUMBER = 0;
let getSAP = null;
let getDraftsState = null;
let saveDraftsState = null;
let findProjectByName = null;
let findProjectByPAP = null;
let findProjectAndAAPByAAPToken = null;
let ensureProjectDirs = null;
let listVersions = null;
let serverHelpers = {};

const STATE_VERSION = 1;
const POLL_TIMEOUT  = 25;
const TAP_FILE      = '/etc/labs/drafts.tap';
const PENDING_TTL_MS = 10 * 60 * 1000;

let TAP = null;
let telepathState = null;
let polling = false;
let pollOffset = 0;
let botMeRefreshTimer = null;

const pendingCreate = new Map();

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function safeWriteJSON(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filepath);
}

function statePath() { return path.join(DRAFTS_DIR, '.telepath.json'); }

function loadState() {
  try {
    if (fs.existsSync(statePath())) {
      telepathState = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    }
  } catch (e) {
    console.error('[telepath] state load failed:', e.message);
  }
  if (!telepathState || telepathState.version !== STATE_VERSION) {
    telepathState = {
      version: STATE_VERSION,
      users: {},
      settings: {
        notify_sap_on_new_project: true,
        notify_sap_on_new_pap: true,
        notify_pap_on_aap_merge: true,
        notify_pap_on_main_commit: true,
      },
      installed_at: null,
    };
    persistState();
  }
}

function persistState() {
  try {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    safeWriteJSON(statePath(), telepathState);
  } catch (e) {
    console.error('[telepath] state save failed:', e.message);
  }
}

function loadTAP() {
  try {
    if (fs.existsSync(TAP_FILE)) {
      TAP = JSON.parse(fs.readFileSync(TAP_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[telepath] TAP load failed:', e.message);
    TAP = null;
  }
}

function persistTAP() {
  try {
    fs.mkdirSync(path.dirname(TAP_FILE), { recursive: true });
    safeWriteJSON(TAP_FILE, TAP || {});
    fs.chmodSync(TAP_FILE, 0o600);
  } catch (e) {
    console.error('[telepath] TAP save failed:', e.message);
  }
}

// Public getter so project-bots.js can append "Built with Drafts → @<username>" to its messages
export function getControlBotUsername() {
  return TAP && TAP.bot ? TAP.bot.username : null;
}

// ─────────────────────────────────────────────────────────────
// Telegram HTTP client (control-plane bot only)
// ─────────────────────────────────────────────────────────────
function tgApi(method, params = {}, opts = {}) {
  if (!TAP || !TAP.token) return Promise.reject(new Error('no_tap'));
  const body = JSON.stringify(params);
  const reqOpts = {
    hostname: 'api.telegram.org', port: 443,
    path: `/bot${TAP.token}/${method}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: opts.timeout || 30000,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            const err = new Error(parsed.description || 'tg_api_error');
            err.code = parsed.error_code;
            err.parameters = parsed.parameters;
            return reject(err);
          }
          resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('tg_api_timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function tgSend(chatId, html, opts = {}) {
  return tgApi('sendMessage', {
    chat_id: chatId, text: html, parse_mode: 'HTML',
    disable_web_page_preview: true, ...opts,
  });
}

// ─────────────────────────────────────────────────────────────
// WebApp initData verification
// ─────────────────────────────────────────────────────────────
function verifyInitData(initDataRaw) {
  if (!initDataRaw || !TAP || !TAP.token) return null;
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k,v])=>`${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TAP.token).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (computed !== hash) return null;
  const auth_date = Number(params.get('auth_date') || 0);
  if (!auth_date || (Date.now()/1000 - auth_date) > 24*3600) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) {}
  return { user, auth_date, query_id: params.get('query_id') };
}

// ─────────────────────────────────────────────────────────────
// Token recognition
// ─────────────────────────────────────────────────────────────
function recognizeToken(text) {
  if (!text) return null;
  text = String(text).trim();
  const url = text.match(/drafts_(server|project|agent)_(\d+)_([a-f0-9]+)/i);
  if (url) {
    const tierWord = url[1].toLowerCase();
    const secret = url[3];
    if (tierWord === 'server') {
      if (secret === getSAP()) return { tier: 'sap', token: secret };
      return null;
    }
    if (tierWord === 'project') {
      const tok = 'pap_' + secret;
      const p = findProjectByPAP(tok);
      if (p) return { tier: 'pap', token: tok, project: p };
      return null;
    }
    if (tierWord === 'agent') {
      const tok = 'aap_' + secret;
      const hit = findProjectAndAAPByAAPToken(tok);
      if (hit) return { tier: 'aap', token: tok, project: hit.project, aap: hit.aap };
      return null;
    }
  }
  if (/^pap_[a-f0-9]+$/i.test(text)) {
    const p = findProjectByPAP(text);
    if (p) return { tier: 'pap', token: text, project: p };
    return null;
  }
  if (/^aap_[a-f0-9]+$/i.test(text)) {
    const hit = findProjectAndAAPByAAPToken(text);
    if (hit) return { tier: 'aap', token: text, project: hit.project, aap: hit.aap };
    return null;
  }
  if (/^[a-f0-9]{12,64}$/i.test(text) && text === getSAP()) {
    return { tier: 'sap', token: text };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// User bindings
// ─────────────────────────────────────────────────────────────
function getUser(tg_user_id) {
  return telepathState.users[String(tg_user_id)] || null;
}

function ensureUser(tgUser) {
  const id = String(tgUser.id);
  if (!telepathState.users[id]) {
    telepathState.users[id] = {
      tg_user_id: tgUser.id,
      tg_username: tgUser.username || null,
      first_name: tgUser.first_name || null,
      is_premium: !!tgUser.is_premium,
      bindings: [],
      notif_subscribed: true,
      created_at: now(),
    };
  } else {
    telepathState.users[id].tg_username = tgUser.username || telepathState.users[id].tg_username;
    telepathState.users[id].first_name = tgUser.first_name || telepathState.users[id].first_name;
    telepathState.users[id].is_premium = !!tgUser.is_premium;
  }
  return telepathState.users[id];
}

function bindToken(tg_user_id, recognized) {
  const user = telepathState.users[String(tg_user_id)];
  if (!user) return;
  user.bindings = user.bindings.filter(b => b.token !== recognized.token);
  user.bindings.push({
    tier: recognized.tier,
    token: recognized.token,
    project_name: recognized.project ? recognized.project.name : null,
    aap_id: recognized.aap ? recognized.aap.id : null,
    bound_at: now(),
  });
  persistState();
}

function unbindToken(tg_user_id, token) {
  const user = telepathState.users[String(tg_user_id)];
  if (!user) return false;
  const before = user.bindings.length;
  user.bindings = user.bindings.filter(b => b.token !== token);
  persistState();
  return user.bindings.length < before;
}

function findUsersBoundToTier(tier) {
  const out = [];
  for (const [id, u] of Object.entries(telepathState.users)) {
    if (u.bindings.some(b => b.tier === tier)) out.push(u);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Premium gate
// ─────────────────────────────────────────────────────────────
function isAllowed(tgFrom, user) {
  if (tgFrom && tgFrom.is_premium) return true;
  if (user && user.bindings.some(b => b.tier === 'sap')) return true;
  return false;
}

const PREMIUM_REFUSAL =
  '<b>Premium only ✨</b>\n\n' +
  'Drafts is free, but you need Telegram Premium to use it.\n' +
  'Upgrade in Telegram Settings → Premium.';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function webAppUrl(suffix) { return PUBLIC_BASE + '/telepath/app/' + suffix; }
function publicHostname() {
  try { return new URL(PUBLIC_BASE).hostname; } catch (e) { return 'this server'; }
}
function tierBadge(tier) {
  return { sap: '🔑 server', pap: '📁 project', aap: '🤝 agent' }[tier] || tier;
}

function welcomeText(user) {
  const name = user && user.first_name ? user.first_name : 'there';
  let t = `<b>Drafts</b> ✦ build by talking to Claude\n\n`;
  t += `gm ${esc(name)} 👋\n\n`;
  t += '/new — make a project\n';
  t += 'or paste a <code>pap_…</code> / <code>aap_…</code> to open one\n\n';
  t += '/help · /projects · /forget';
  return t;
}

function helpText() {
  let t = '<b>commands</b>\n\n';
  t += '/new — new project\n';
  t += '/projects — your projects\n';
  t += '/forget — drop a token\n';
  t += '/notif <code>on|off</code> — notifications\n';
  t += '/start — welcome\n';
  t += '/help — this\n\n';
  t += 'paste any <code>pap_…</code> or <code>aap_…</code> to open it.';
  return t;
}

function projectsListText(user) {
  if (!user || user.bindings.length === 0) {
    return 'nothing here yet. /new to start ✨';
  }
  let t = '<b>your stuff</b>\n\n';
  for (const b of user.bindings) {
    t += `${tierBadge(b.tier)}`;
    if (b.project_name) t += ` · <code>${esc(b.project_name)}</code>`;
    t += `\n`;
  }
  return t;
}

function dashboardKeyboardForBinding(binding) {
  let url, label;
  if (binding.tier === 'sap') {
    url = webAppUrl('sap');
    label = '🔑 server admin';
  } else if (binding.tier === 'pap') {
    url = webAppUrl('pap/' + binding.token);
    label = '✨ open ' + (binding.project_name || 'project');
  } else if (binding.tier === 'aap') {
    url = webAppUrl('aap/' + binding.token);
    label = '🤝 open agent';
  }
  return [[{ text: label, web_app: { url } }]];
}

// ─────────────────────────────────────────────────────────────
// /new flow
// ─────────────────────────────────────────────────────────────
function validateProjectName(raw) {
  const name = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
  if (!name) return { ok: false, error: 'empty' };
  if (name.length < 2) return { ok: false, error: 'too_short' };
  if (/^[-_]/.test(name) || /[-_]$/.test(name)) return { ok: false, error: 'edge_separators' };
  return { ok: true, name };
}

function previewUrl(name) { return PUBLIC_BASE + '/' + name + '/'; }

async function sendNewPrompt(chatId) {
  const exampleHost = publicHostname();
  const html =
    '<b>name your project</b>\n\n' +
    'send a name as your next message ✏️\n\n' +
    `it'll live at <code>${esc(exampleHost)}/&lt;name&gt;/</code>\n\n` +
    '<i>a–z, 0–9, <code>-</code>, <code>_</code> · 2–40 chars</i>';
  await tgSend(chatId, html, {
    reply_markup: { inline_keyboard: [[{ text: '✕ cancel', callback_data: 'new:cancel' }]] },
  });
}

async function sendNewPreview(chatId, name) {
  const url = previewUrl(name);
  const html =
    '<b>looks good?</b>\n\n' +
    `<code>${esc(name)}</code>\n` +
    `→ <a href="${esc(url)}">${esc(url)}</a>`;
  await tgSend(chatId, html, {
    reply_markup: { inline_keyboard: [
      [{ text: '✓ create', callback_data: 'new:confirm:' + name }],
      [{ text: '✎ rename', callback_data: 'new:rename' }, { text: '✕ cancel', callback_data: 'new:cancel' }],
    ]},
  });
}

function setPending(tgUserId) {
  pendingCreate.set(tgUserId, { expires_at: Date.now() + PENDING_TTL_MS });
}
function clearPending(tgUserId) { pendingCreate.delete(tgUserId); }
function getPending(tgUserId) {
  const p = pendingCreate.get(tgUserId);
  if (!p) return null;
  if (Date.now() > p.expires_at) { pendingCreate.delete(tgUserId); return null; }
  return p;
}

async function actuallyCreateProject(chatId, user, name) {
  if (!serverHelpers.createProject) {
    return await tgSend(chatId, 'oops, internal error.');
  }
  const owner = user.tg_username || user.first_name || ('user_' + user.tg_user_id);
  try {
    const res = await serverHelpers.createProject({ name, description: 'Created via Telepath by ' + owner });
    bindToken(user.tg_user_id, { tier: 'pap', token: res.pap_token, project: { name: res.project } });
    const html =
      '🎉 <b>it\'s yours</b>\n\n' +
      `<code>${esc(res.project)}</code>\n` +
      `→ <a href="${esc(res.live_url)}">${esc(res.live_url)}</a>\n\n` +
      'tap below to open the dashboard, then talk to Claude to build.';
    await tgSend(chatId, html, {
      reply_markup: { inline_keyboard: dashboardKeyboardForBinding({ tier: 'pap', token: res.pap_token, project_name: res.project }) },
    });
    notifySAPOwners(`🆕 new project: <code>${esc(res.project)}</code> by ${esc(owner)}`);
  } catch (e) {
    let msg = 'failed: ' + esc(e.message);
    if (e.message === 'exists') msg = `<code>${esc(name)}</code> is taken — try another with /new`;
    if (e.message === 'reserved_name') msg = `<code>${esc(name)}</code> is reserved — try another with /new`;
    if (e.message === 'invalid_name') msg = 'invalid name. a–z, 0–9, <code>-</code>, <code>_</code>. 2–40 chars.';
    await tgSend(chatId, msg);
  }
}

// ─────────────────────────────────────────────────────────────
// Update handler
// ─────────────────────────────────────────────────────────────
async function handleUpdate(upd) {
  try {
    if (upd.message) await handleMessage(upd.message);
    else if (upd.callback_query) await handleCallback(upd.callback_query);
  } catch (e) {
    console.error('[telepath] handleUpdate error:', e.message);
  }
}

async function handleMessage(msg) {
  if (!msg.from || msg.from.is_bot) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const user = ensureUser(msg.from);

  const recogPreview = recognizeToken(text);
  const isSapBindingAttempt = recogPreview && recogPreview.tier === 'sap';

  if (!isAllowed(msg.from, user) && !isSapBindingAttempt) {
    return await tgSend(chatId, PREMIUM_REFUSAL);
  }

  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    if (cmd !== '/new') clearPending(msg.from.id);

    if (cmd === '/start')    return await sendStart(chatId, user);
    if (cmd === '/help')     return await sendHelp(chatId);
    if (cmd === '/projects') return await sendProjects(chatId, user);
    if (cmd === '/forget')   return await sendForgetMenu(chatId, user);
    if (cmd === '/new')      return await handleNewCommand(chatId, user, parts.slice(1).join(' '));
    if (cmd === '/cancel') {
      if (getPending(msg.from.id)) { clearPending(msg.from.id); return await tgSend(chatId, 'cancelled.'); }
      return await tgSend(chatId, 'nothing to cancel.');
    }
    if (cmd === '/notif') {
      const arg = parts[1];
      if (arg === 'off') { user.notif_subscribed = false; persistState(); return await tgSend(chatId, '🔕 notifications off'); }
      if (arg === 'on')  { user.notif_subscribed = true;  persistState(); return await tgSend(chatId, '🔔 notifications on'); }
      return await tgSend(chatId, '<code>/notif on</code> or <code>/notif off</code>\nnow: '+(user.notif_subscribed?'on':'off'));
    }
    return await tgSend(chatId, "didn't catch that. /help");
  }

  const recog = recognizeToken(text);
  if (recog) {
    clearPending(msg.from.id);
    bindToken(msg.from.id, recog);
    let body = '✅ ' + tierBadge(recog.tier);
    if (recog.project) body += ' · <code>' + esc(recog.project.name) + '</code>';
    body += '\n\ntap to open ↓';
    return await tgSend(chatId, body, {
      reply_markup: { inline_keyboard: dashboardKeyboardForBinding({
        tier: recog.tier, token: recog.token, project_name: recog.project?.name,
      }) },
    });
  }

  if (getPending(msg.from.id)) {
    const v = validateProjectName(text);
    if (!v.ok) {
      const explain = v.error === 'empty' ? "that's empty."
        : v.error === 'too_short' ? 'too short (min 2 chars).'
        : v.error === 'edge_separators' ? "can't start/end with <code>-</code> or <code>_</code>."
        : 'invalid.';
      return await tgSend(chatId,
        explain + ' try again or /cancel.\n\n<i>a–z, 0–9, <code>-</code>, <code>_</code>. 2–40 chars.</i>'
      );
    }
    if (findProjectByName(v.name)) {
      return await tgSend(chatId,
        `<code>${esc(v.name)}</code> is taken. try another or /cancel.`
      );
    }
    clearPending(msg.from.id);
    return await sendNewPreview(chatId, v.name);
  }

  await tgSend(chatId,
    "didn't catch that.\n\n/new to make one, or paste a <code>pap_…</code> / <code>aap_…</code>"
  );
}

async function handleNewCommand(chatId, user, requestedName) {
  if (requestedName && requestedName.trim()) {
    const v = validateProjectName(requestedName);
    if (!v.ok) {
      const explain = v.error === 'too_short' ? 'too short.'
        : v.error === 'edge_separators' ? "can't start/end with <code>-</code> or <code>_</code>."
        : 'bad chars.';
      await tgSend(chatId, explain + ' try /new with another name.');
      return;
    }
    if (findProjectByName(v.name)) {
      return await tgSend(chatId, `<code>${esc(v.name)}</code> is taken.`);
    }
    return await sendNewPreview(chatId, v.name);
  }
  setPending(user.tg_user_id);
  await sendNewPrompt(chatId);
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data || '';
  const user = ensureUser(cq.from);

  if (!isAllowed(cq.from, user)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'Premium only', show_alert: true });
    return;
  }

  if (data.startsWith('forget:')) {
    const tok = data.slice(7);
    const ok = unbindToken(cq.from.id, tok);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: ok ? 'gone.' : 'not found' });
    if (ok) await tgSend(chatId, 'forgotten.');
    return;
  }

  if (data === 'new:cancel') {
    clearPending(cq.from.id);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'cancelled' });
    try { await tgApi('editMessageText', {
      chat_id: chatId, message_id: cq.message.message_id,
      text: '✕ cancelled', parse_mode: 'HTML',
    }); } catch (e) {}
    return;
  }

  if (data === 'new:rename') {
    setPending(cq.from.id);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
    try { await tgApi('editMessageText', {
      chat_id: chatId, message_id: cq.message.message_id,
      text: '✏️ send a new name as your next message',
      parse_mode: 'HTML',
    }); } catch (e) {}
    return;
  }

  if (data.startsWith('new:confirm:')) {
    const name = data.slice('new:confirm:'.length);
    const v = validateProjectName(name);
    if (!v.ok) {
      await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'invalid name', show_alert: true });
      return;
    }
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'creating...' });
    try { await tgApi('editMessageText', {
      chat_id: chatId, message_id: cq.message.message_id,
      text: `⏳ creating <code>${esc(v.name)}</code>...`, parse_mode: 'HTML',
    }); } catch (e) {}
    await actuallyCreateProject(chatId, user, v.name);
    return;
  }

  await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
}

async function sendStart(chatId, user) { await tgSend(chatId, welcomeText(user)); }
async function sendHelp(chatId) { await tgSend(chatId, helpText()); }
async function sendProjects(chatId, user) {
  const text = projectsListText(user);
  const kb = (user?.bindings || []).slice(0, 8).flatMap(b => dashboardKeyboardForBinding(b));
  await tgSend(chatId, text, { reply_markup: kb.length ? { inline_keyboard: kb } : undefined });
}
async function sendForgetMenu(chatId, user) {
  if (!user || !user.bindings.length) {
    return await tgSend(chatId, 'nothing to forget');
  }
  const kb = user.bindings.map(b => [{
    text: 'forget ' + tierBadge(b.tier) + (b.project_name ? ' · ' + b.project_name : ''),
    callback_data: 'forget:' + b.token,
  }]);
  await tgSend(chatId, 'pick one to forget:', { reply_markup: { inline_keyboard: kb } });
}

// ─────────────────────────────────────────────────────────────
// Long polling
// ─────────────────────────────────────────────────────────────
async function pollLoop() {
  if (polling) return;
  polling = true;
  console.log('[telepath] long-polling started');
  while (polling && TAP && TAP.token) {
    try {
      const updates = await tgApi('getUpdates', {
        offset: pollOffset, timeout: POLL_TIMEOUT,
        allowed_updates: ['message', 'callback_query'],
      }, { timeout: (POLL_TIMEOUT + 5) * 1000 });
      for (const upd of updates) {
        pollOffset = Math.max(pollOffset, upd.update_id + 1);
        await handleUpdate(upd);
      }
    } catch (e) {
      if (e.code === 401) {
        console.error('[telepath] bot token rejected (401). Stopping polling.');
        polling = false;
        break;
      }
      console.error('[telepath] poll error:', e.message);
      await sleep(5000);
    }
  }
  console.log('[telepath] long-polling stopped');
}

function stopPolling() { polling = false; }

async function refreshBotMe() {
  if (!TAP || !TAP.token) return;
  try {
    const me = await tgApi('getMe');
    TAP.bot = { id: me.id, username: me.username, first_name: me.first_name };
    persistTAP();
  } catch (e) {
    console.error('[telepath] getMe failed:', e.message);
  }
}

async function configureBotProfile() {
  if (!TAP || !TAP.token) return;
  const commands = [
    { command: 'new',      description: 'new project ✨' },
    { command: 'projects', description: 'your projects' },
    { command: 'help',     description: 'help' },
    { command: 'forget',   description: 'drop a token' },
    { command: 'notif',    description: 'notifications on/off' },
    { command: 'cancel',   description: 'cancel /new' },
    { command: 'start',    description: 'welcome' },
  ];
  const shortDesc = 'Build by talking to Claude. Premium only.';
  const longDesc =
    'Drafts turns Telegram into your build space. Type /new to create a project, then talk to Claude to build a website, app, or bot. Each version is saved automatically.';
  try {
    await tgApi('setMyCommands', { commands });
    await tgApi('setMyShortDescription', { short_description: shortDesc });
    await tgApi('setMyDescription', { description: longDesc });
    console.log('[telepath] bot profile configured');
  } catch (e) {
    console.error('[telepath] configureBotProfile error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Notification dispatchers
// ─────────────────────────────────────────────────────────────
function notifySAPOwners(html) {
  if (!TAP) return;
  const subs = findUsersBoundToTier('sap').filter(u => u.notif_subscribed);
  for (const u of subs) {
    tgSend(u.tg_user_id, html).catch(e => console.error('[telepath] notify SAP failed:', e.message));
  }
}

function notifyPAPOwners(projectName, html) {
  if (!TAP) return;
  const subs = Object.values(telepathState.users).filter(u =>
    u.notif_subscribed && u.bindings.some(b => b.tier === 'pap' && b.project_name === projectName)
  );
  for (const u of subs) {
    tgSend(u.tg_user_id, html).catch(e => console.error('[telepath] notify PAP failed:', e.message));
  }
}

function onNewProject(project) {
  if (!telepathState.settings.notify_sap_on_new_project) return;
  notifySAPOwners(`🆕 <code>${esc(project.name)}</code>`);
}
function onNewAAPCreated(project, aap) {
  notifyPAPOwners(project.name, `🤝 new agent on <code>${esc(project.name)}</code>: ${esc(aap.name || aap.id)}`);
}
function onAAPMerged(project, aap, versionN) {
  if (!telepathState.settings.notify_pap_on_aap_merge) return;
  notifyPAPOwners(project.name, `✅ merged into <code>${esc(project.name)}</code> · v${versionN}`);
}
function onMainCommit(project, commit, versionN) {
  if (!telepathState.settings.notify_pap_on_main_commit) return;
  const msg = (commit?.summary?.changes || commit?.commit || '').toString().slice(0, 80);
  notifyPAPOwners(project.name, `📝 <code>${esc(project.name)}</code> v${versionN}: ${esc(msg || 'commit')}`);
}

// ─────────────────────────────────────────────────────────────
// HTTP routes
// ─────────────────────────────────────────────────────────────
function mountRoutes(app) {
  // ── TAP management (control bot) ──
  app.get('/drafts/tap', requireSAP, (req, res) => {
    if (!TAP) return res.json({ ok: true, installed: false });
    res.json({ ok: true, installed: true, bot: TAP.bot || null, installed_at: TAP.installed_at || null, polling });
  });

  app.put('/drafts/tap', requireSAP, async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return res.status(400).json({ ok: false, error: 'invalid_token_format' });
    }
    const oldTAP = TAP;
    TAP = { token };
    try {
      const me = await tgApi('getMe');
      TAP = { token, bot: { id: me.id, username: me.username, first_name: me.first_name }, installed_at: now() };
      persistTAP();
      stopPolling();
      await sleep(500);
      pollLoop();
      configureBotProfile().catch(()=>{});
      res.json({ ok: true, bot: TAP.bot });
    } catch (e) {
      TAP = oldTAP;
      res.status(400).json({ ok: false, error: 'token_rejected_by_telegram', detail: e.message });
    }
  });

  app.delete('/drafts/tap', requireSAP, (req, res) => {
    stopPolling();
    TAP = null;
    try { fs.unlinkSync(TAP_FILE); } catch (e) {}
    res.json({ ok: true, removed: true });
  });

  app.put('/drafts/tap/settings', requireSAP, (req, res) => {
    const allowed = ['notify_sap_on_new_project','notify_sap_on_new_pap','notify_pap_on_aap_merge','notify_pap_on_main_commit'];
    for (const k of allowed) if (k in req.body) telepathState.settings[k] = !!req.body[k];
    persistState();
    res.json({ ok: true, settings: telepathState.settings });
  });

  app.post('/drafts/tap/configure', requireSAP, async (req, res) => {
    try { await configureBotProfile(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── WebApp pages ──
  app.get('/telepath/app/sap',           (req, res) => res.type('html').send(renderWebAppShell('sap')));
  app.get('/telepath/app/pap/:token',    (req, res) => res.type('html').send(renderWebAppShell('pap', req.params.token)));
  app.get('/telepath/app/aap/:token',    (req, res) => res.type('html').send(renderWebAppShell('aap', req.params.token)));

  // ── WebApp API ──
  app.post('/telepath/api/whoami', initDataAuth, (req, res) => {
    res.json({ ok: true, tg_user: req.tgUser });
  });

  app.get('/telepath/api/state/:tier/:token?', initDataAuth, (req, res) => {
    const tier = req.params.tier;
    const token = req.params.token;
    if (tier === 'sap') {
      const u = getUser(req.tgUser.id);
      if (!u || !u.bindings.some(b => b.tier === 'sap')) return res.status(403).json({ ok: false, error: 'no_sap_binding' });
      const projects = getDraftsState().projects.map(p => ({
        name: p.name, description: p.description, github_repo: p.github_repo,
        created_at: p.created_at,
        pap_active: !!(p.pap && !p.pap.revoked),
        aap_count: (p.aaps || []).filter(a => !a.revoked).length,
        bot_attached: !!(p.bot && p.bot.token),
        bot_username: p.bot?.bot_username || null,
      }));
      return res.json({ ok: true, tier: 'sap', server_number: SERVER_NUMBER, public_base: PUBLIC_BASE, projects, settings: telepathState.settings });
    }
    if (tier === 'pap') {
      const u = getUser(req.tgUser.id);
      if (!u || !u.bindings.some(b => b.token === token && b.tier === 'pap')) return res.status(403).json({ ok: false, error: 'not_bound' });
      const p = findProjectByPAP(token);
      if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
      return res.json({ ok: true, tier: 'pap', public_base: PUBLIC_BASE, project: {
        name: p.name, description: p.description, github_repo: p.github_repo,
        created_at: p.created_at, live_url: PUBLIC_BASE + '/' + p.name + '/',
        pass_url: PUBLIC_BASE + '/drafts/pass/drafts_project_' + SERVER_NUMBER + '_' + token.replace(/^pap_/,''),
        aaps: (p.aaps || []).map(a => ({ id: a.id, name: a.name, revoked: a.revoked, branch: a.branch })),
        bot: projectBotsApi.getBotStatus(p),
      }});
    }
    if (tier === 'aap') {
      const u = getUser(req.tgUser.id);
      if (!u || !u.bindings.some(b => b.token === token && b.tier === 'aap')) return res.status(403).json({ ok: false, error: 'not_bound' });
      const hit = findProjectAndAAPByAAPToken(token);
      if (!hit) return res.status(404).json({ ok: false, error: 'aap_not_found' });
      return res.json({ ok: true, tier: 'aap', public_base: PUBLIC_BASE,
        project: { name: hit.project.name, live_url: PUBLIC_BASE + '/' + hit.project.name + '/' },
        aap: { id: hit.aap.id, name: hit.aap.name, branch: hit.aap.branch },
        pass_url: PUBLIC_BASE + '/drafts/pass/drafts_agent_' + SERVER_NUMBER + '_' + token.replace(/^aap_/,''),
      });
    }
    return res.status(400).json({ ok: false, error: 'bad_tier' });
  });

  app.post('/telepath/api/sap/projects', initDataAuth, async (req, res) => {
    const u = getUser(req.tgUser.id);
    if (!u || !u.bindings.some(b => b.tier === 'sap')) return res.status(403).json({ ok: false, error: 'no_sap_binding' });
    const name = String(req.body.name || '').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
    if (!name) return res.status(400).json({ ok: false, error: 'invalid_name' });
    if (!serverHelpers.createProject) return res.status(500).json({ ok:false, error: 'createProject not wired' });
    try {
      const out = await serverHelpers.createProject({ name, description: req.body.description || '' });
      bindToken(req.tgUser.id, { tier: 'pap', token: out.pap_token, project: { name } });
      res.json({ ok: true, project: name, pap_activation_url: out.pap_activation_url, live_url: out.live_url });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/telepath/api/pap/aaps', initDataAuth, async (req, res) => {
    const u = getUser(req.tgUser.id);
    const token = String(req.body.pap_token || '');
    if (!u || !u.bindings.some(b => b.token === token && b.tier === 'pap')) return res.status(403).json({ ok: false, error: 'not_bound' });
    const p = findProjectByPAP(token);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!serverHelpers.createAAP) return res.status(500).json({ ok:false, error: 'createAAP not wired' });
    try {
      const out = await serverHelpers.createAAP(p, { name: req.body.name || null });
      onNewAAPCreated(p, out.aap);
      res.json({ ok: true, aap: out.aap, activation_url: out.activation_url });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/telepath/api/forget', initDataAuth, (req, res) => {
    const tok = String(req.body.token || '');
    const ok = unbindToken(req.tgUser.id, tok);
    res.json({ ok, removed: ok });
  });

  // ── Project Bots (per-PAP) ──
  // helper: load project by PAP token, verify caller owns it
  function papOwnerCheck(req, res) {
    const u = getUser(req.tgUser.id);
    const token = String(req.body.pap_token || req.query.pap_token || '');
    if (!u || !u.bindings.some(b => b.token === token && b.tier === 'pap')) {
      res.status(403).json({ ok: false, error: 'not_bound' });
      return null;
    }
    const p = findProjectByPAP(token);
    if (!p) {
      res.status(404).json({ ok: false, error: 'project_not_found' });
      return null;
    }
    return p;
  }

  app.get('/telepath/api/pap/bot', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    res.json({ ok: true, bot: projectBotsApi.getBotStatus(p) });
  });

  app.put('/telepath/api/pap/bot', initDataAuth, async (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    const botToken = String(req.body.bot_token || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
      return res.status(400).json({ ok: false, error: 'invalid_bot_token_format' });
    }
    try {
      const out = await projectBotsApi.installBot(p, botToken);
      res.json({ ok: true, bot: out });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete('/telepath/api/pap/bot', initDataAuth, async (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    try {
      const out = await projectBotsApi.unlinkBot(p, { notify_subscribers: false });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/telepath/api/pap/bot/sync', initDataAuth, async (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    const message = String(req.body.message || '').trim();
    // If user provided a message, append the viral attribution line
    let html = null;
    if (message) {
      const ctrlBot = getControlBotUsername();
      const attribution = ctrlBot
        ? `\n\n<i>Built with Drafts → @${esc(ctrlBot)}</i>`
        : '\n\n<i>Built with Drafts</i>';
      html = esc(message).replace(/\n/g, '\n') + attribution;
    }
    try {
      const out = await projectBotsApi.syncBot(p, html);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Express middlewares
// ─────────────────────────────────────────────────────────────
function requireSAP(req, res, next) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const tok = m ? m[1].trim() : null;
  if (!tok || tok !== getSAP()) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

function initDataAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.body?._initData || '';
  const verified = verifyInitData(initData);
  if (!verified || !verified.user) return res.status(401).json({ ok: false, error: 'invalid_initdata' });
  req.tgUser = verified.user;
  next();
}

// ─────────────────────────────────────────────────────────────
// WebApp shell HTML — Gen Z'd: tighter copy, cleaner cards, bot section
// ─────────────────────────────────────────────────────────────
function renderWebAppShell(tier, token) {
  const stateUrl = '/telepath/api/state/' + tier + (token ? '/' + token : '');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Drafts</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root { color-scheme: dark light; }
body { margin:0; padding:0; background: var(--tg-theme-bg-color, #000); color: var(--tg-theme-text-color, #f5f5f5); font-family: Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size:15px; line-height:1.5; }
.wrap { max-width: 600px; margin: 0 auto; padding: 16px 18px 80px; }
h1 { font-size: 26px; font-weight: 800; letter-spacing: -0.025em; margin: 4px 0 4px; }
.sub { color: var(--tg-theme-hint-color, #888); font-size: 13px; margin-bottom: 20px; }
.card { background: var(--tg-theme-secondary-bg-color, #111); border-radius: 14px; padding: 16px 18px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.04); }
.card h3 { font-size:11px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color: var(--tg-theme-hint-color, #888); margin:0 0 12px; display:flex; align-items:center; gap:6px; }
.card h3 .dot { display:inline-block; width:6px; height:6px; border-radius:50%; }
.card h3 .dot.on { background:#4ade80; }
.card h3 .dot.off { background:#666; }
.row { display:flex; justify-content:space-between; gap:10px; padding:8px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size:13px; }
.row:last-child { border-bottom:none; }
.row .k { color: var(--tg-theme-hint-color, #888); flex-shrink:0; }
.row .v { text-align:right; word-break:break-all; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.btn { display:inline-block; padding:11px 18px; border-radius:12px; background: var(--tg-theme-button-color, #ea5a2e); color: var(--tg-theme-button-text-color, #fff); text-decoration:none; font-weight:700; font-size:14px; border:none; cursor:pointer; font-family:inherit; }
.btn:active { transform: scale(0.97); }
.btn.ghost { background: transparent; color: var(--tg-theme-link-color, #60a5fa); border: 1.5px solid rgba(96,165,250,0.3); }
.btn.danger { background: transparent; color: #ef4444; border: 1.5px solid rgba(239,68,68,0.3); }
.btn + .btn { margin-left: 8px; }
.btn.full { width:100%; display:block; text-align:center; }
.muted { color: var(--tg-theme-hint-color, #888); font-size:12px; line-height:1.55; }
input, textarea { width:100%; padding:12px 14px; border-radius:10px; border:1.5px solid rgba(255,255,255,0.1); background: var(--tg-theme-bg-color, #000); color: inherit; font-family:inherit; font-size:14px; box-sizing:border-box; margin-bottom:8px; }
input:focus, textarea:focus { outline:none; border-color:var(--tg-theme-button-color, #ea5a2e); }
.proj-item { padding:12px 0; border-bottom:1px solid rgba(255,255,255,0.05); }
.proj-item:last-child { border-bottom:none; }
.proj-name { font-weight:700; font-size:15px; }
.proj-meta { font-size:12px; color: var(--tg-theme-hint-color, #888); margin-top:3px; }
.empty { padding: 28px 0; text-align:center; color: var(--tg-theme-hint-color, #888); font-size:13px; }
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:#222; color:#fff; padding:11px 18px; border-radius:10px; font-size:13px; z-index:100; box-shadow:0 4px 20px rgba(0,0,0,0.4); }
.actions { display:flex; gap:10px; flex-wrap:wrap; }
.bot-status { display:flex; align-items:center; gap:10px; padding:6px 0 14px; }
.bot-status .badge { font-size:13px; font-weight:600; color:#f5f5f5; }
.bot-status .meta { font-size:12px; color: var(--tg-theme-hint-color, #888); }
.help-block { background:rgba(96,165,250,0.06); border-left:3px solid #60a5fa; padding:10px 12px; border-radius:6px; font-size:12.5px; color:#a8a8a8; margin:8px 0; line-height:1.5; }
</style>
</head><body><div class="wrap" id="root"><div class="empty">loading…</div></div>
<script>
(function(){
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if (tg) { tg.ready(); tg.expand(); }
  const initData = tg ? tg.initData : '';
  const root = document.getElementById('root');
  const TIER = ${JSON.stringify(tier)};
  const TOKEN = ${JSON.stringify(token || null)};
  const STATE_URL = ${JSON.stringify(stateUrl)};

  function toast(msg){ const t=document.createElement('div'); t.className='toast'; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),2400); }
  function copy(text){ navigator.clipboard.writeText(text).then(()=>toast('copied ✓')); }
  function esc(s){ if(s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  async function api(method, url, body) {
    const opts = { method, headers: { 'Content-Type':'application/json', 'X-Telegram-Init-Data': initData } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const j = await r.json().catch(()=>({ok:false,error:'bad_json'}));
    if (!j.ok) throw new Error(j.error || 'request_failed');
    return j;
  }

  async function load(){
    if (!initData) {
      root.innerHTML = '<div class="card"><h3>open from telegram</h3><div class="muted">this only works inside the telegram app. open it via the bot.</div></div>';
      return;
    }
    try {
      const data = await api('GET', STATE_URL);
      if (data.tier === 'sap') return renderSAP(data);
      if (data.tier === 'pap') return renderPAP(data);
      if (data.tier === 'aap') return renderAAP(data);
    } catch (e) {
      root.innerHTML = '<div class="card"><h3>error</h3><div class="muted">'+esc(e.message)+'</div></div>';
    }
  }

  function renderSAP(d) {
    let h = '<h1>server</h1><div class="sub">'+esc(d.public_base.replace(/^https?:\\/\\//,''))+' · #'+d.server_number+'</div>';
    h += '<div class="card"><h3>new project</h3>';
    h += '<input id="newName" placeholder="project-name" maxlength="40"/>';
    h += '<input id="newDesc" placeholder="description (optional)"/>';
    h += '<button class="btn full" id="createBtn">create ✨</button></div>';
    h += '<div class="card"><h3>projects · '+d.projects.length+'</h3>';
    if (!d.projects.length) h += '<div class="empty">no projects yet</div>';
    for (const p of d.projects) {
      const botBadge = p.bot_attached ? ' · 🤖 @'+esc(p.bot_username||'bot') : '';
      h += '<div class="proj-item"><div class="proj-name">'+esc(p.name)+'</div>';
      h += '<div class="proj-meta">'+(p.description ? esc(p.description)+' · ' : '')+'agents: '+p.aap_count+botBadge+'</div></div>';
    }
    h += '</div>';
    root.innerHTML = h;
    document.getElementById('createBtn').addEventListener('click', async () => {
      const name = document.getElementById('newName').value.trim();
      const description = document.getElementById('newDesc').value.trim();
      if (!name) { toast('name required'); return; }
      try {
        await api('POST', '/telepath/api/sap/projects', { name, description });
        toast('created ✓');
        setTimeout(load, 600);
      } catch (e) { toast('failed: '+e.message); }
    });
  }

  function renderPAP(d) {
    const p = d.project;
    let h = '<h1>'+esc(p.name)+'</h1><div class="sub">project on '+esc(d.public_base.replace(/^https?:\\/\\//,''))+'</div>';

    // Live + Pass-link actions
    h += '<div class="card"><h3>your project</h3>';
    h += '<div class="actions">';
    h += '<a class="btn" href="'+p.live_url+'" target="_blank">🌐 live</a>';
    h += '<button class="btn ghost" id="copyPass">🔗 pass-link</button>';
    h += '</div>';
    h += '<div class="muted" style="margin-top:10px">pass-link is what you share with Claude to build. tap to copy.</div>';
    h += '</div>';

    // Bot card
    h += '<div class="card" id="botCard"><h3><span class="dot '+(p.bot.installed?'on':'off')+'"></span>telegram bot</h3>';
    if (p.bot.installed) {
      h += '<div class="bot-status"><div><div class="badge">@'+esc(p.bot.bot_username||'bot')+'</div>';
      h += '<div class="meta">'+p.bot.subscriber_count+' subscriber'+(p.bot.subscriber_count===1?'':'s');
      if (p.bot.last_synced_at) h += ' · synced '+new Date(p.bot.last_synced_at).toLocaleDateString();
      else h += ' · not synced yet';
      h += '</div></div></div>';
      h += '<div class="actions">';
      h += '<button class="btn" id="syncBtn">↻ update bot</button>';
      h += '<button class="btn danger" id="unlinkBtn">unlink</button>';
      h += '</div>';
      h += '<div class="help-block">tap <b>update bot</b> to push latest project info + send a broadcast to subscribers. by default the bot does <b>not</b> auto-update so users don\\'t get spammed.</div>';
    } else {
      h += '<div class="muted" style="margin-bottom:12px">turn your project into a telegram bot. users tap to open your project as a mini-app.</div>';
      h += '<input id="botToken" placeholder="paste bot token from @BotFather" type="password" autocomplete="off"/>';
      h += '<button class="btn full" id="linkBtn">🔗 link bot</button>';
      h += '<div class="help-block">need a bot? open <a href="https://t.me/BotFather" target="_blank" style="color:#60a5fa">@BotFather</a> → /newbot → follow the steps → copy the token here.</div>';
    }
    h += '</div>';

    // Agents
    h += '<div class="card"><h3>agents · '+p.aaps.length+'</h3>';
    if (!p.aaps.length) h += '<div class="empty">no agents yet</div>';
    for (const a of p.aaps) {
      h += '<div class="proj-item"><div class="proj-name">'+esc(a.name||a.id)+(a.revoked?' <span style="color:#ef4444">(revoked)</span>':'')+'</div>';
      h += '<div class="proj-meta">branch: '+esc(a.branch)+'</div></div>';
    }
    h += '<div style="margin-top:12px"><input id="aapName" placeholder="agent name (optional)" maxlength="60"/>';
    h += '<button class="btn full" id="newAap">+ invite agent</button></div>';
    h += '</div>';

    // Info
    h += '<div class="card"><h3>info</h3>';
    h += '<div class="row"><span class="k">created</span><span class="v">'+esc(p.created_at.slice(0,10))+'</span></div>';
    if (p.github_repo) h += '<div class="row"><span class="k">github</span><span class="v">'+esc(p.github_repo)+'</span></div>';
    h += '<div class="row"><span class="k">about</span><span class="v">'+esc(p.description||'—')+'</span></div>';
    h += '</div>';

    root.innerHTML = h;

    document.getElementById('copyPass').addEventListener('click', () => copy(p.pass_url));
    document.getElementById('newAap').addEventListener('click', async () => {
      const name = document.getElementById('aapName').value.trim();
      try {
        const out = await api('POST', '/telepath/api/pap/aaps', { pap_token: TOKEN, name });
        copy(out.activation_url);
        toast('agent link copied ✓');
        setTimeout(load, 600);
      } catch (e) { toast('failed: '+e.message); }
    });

    if (p.bot.installed) {
      document.getElementById('syncBtn').addEventListener('click', () => openBroadcastModal());
      document.getElementById('unlinkBtn').addEventListener('click', async () => {
        if (!confirm('unlink @'+(p.bot.bot_username||'bot')+'? subscribers will stop receiving updates.')) return;
        try {
          await api('DELETE', '/telepath/api/pap/bot?pap_token='+encodeURIComponent(TOKEN));
          toast('unlinked ✓');
          setTimeout(load, 500);
        } catch (e) { toast('failed: '+e.message); }
      });
    } else {
      document.getElementById('linkBtn').addEventListener('click', async () => {
        const token = document.getElementById('botToken').value.trim();
        if (!token) { toast('paste a token first'); return; }
        try {
          const out = await api('PUT', '/telepath/api/pap/bot', { pap_token: TOKEN, bot_token: token });
          toast('linked: @'+out.bot.bot_username);
          setTimeout(load, 600);
        } catch (e) { toast('failed: '+e.message); }
      });
    }
  }

  function openBroadcastModal() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;display:flex;align-items:flex-end;justify-content:center;';
    overlay.innerHTML = ''+
      '<div style="background:#181818;width:100%;max-width:600px;border-radius:16px 16px 0 0;padding:20px 18px 28px;">'+
        '<div style="font-size:18px;font-weight:800;margin-bottom:6px">update bot</div>'+
        '<div class="muted" style="margin-bottom:14px">syncs the bot\\'s name, description, and menu button to your project. optionally send a message to subscribers.</div>'+
        '<textarea id="bcMsg" rows="3" placeholder="what\\'s new? 👀  (leave empty to skip broadcast)"></textarea>'+
        '<button class="btn full" id="bcSend">↻ update bot</button>'+
        '<button class="btn ghost full" id="bcCancel" style="margin-top:8px">cancel</button>'+
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('bcCancel').onclick = () => overlay.remove();
    document.getElementById('bcSend').onclick = async () => {
      const message = document.getElementById('bcMsg').value.trim();
      try {
        const out = await api('POST', '/telepath/api/pap/bot/sync', { pap_token: TOKEN, message });
        if (out.broadcast && !out.broadcast.skipped) {
          toast('synced + sent to '+out.broadcast.sent);
        } else {
          toast('synced ✓');
        }
        overlay.remove();
        setTimeout(load, 600);
      } catch (e) { toast('failed: '+e.message); }
    };
  }

  function renderAAP(d) {
    const p = d.project;
    let h = '<h1>'+esc(p.name)+'</h1><div class="sub">agent: '+esc(d.aap.name||d.aap.id)+'</div>';
    h += '<div class="card"><h3>your branch</h3>';
    h += '<div class="muted" style="margin-bottom:10px">open this pass-link in Claude. your work goes to <code>'+esc(d.aap.branch)+'</code>.</div>';
    h += '<div class="actions">';
    h += '<button class="btn" id="copyPass">🔗 pass-link</button>';
    h += '<a class="btn ghost" href="'+p.live_url+'" target="_blank">🌐 live</a>';
    h += '</div></div>';
    root.innerHTML = h;
    document.getElementById('copyPass').addEventListener('click', () => copy(d.pass_url));
  }

  load();
})();
</script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// init()
// ─────────────────────────────────────────────────────────────
export function initTelepath(opts) {
  DRAFTS_DIR = opts.draftsDir;
  PUBLIC_BASE = opts.publicBase;
  SERVER_NUMBER = opts.serverNumber || 0;
  getSAP = opts.getSAP;
  getDraftsState = opts.getDraftsState;
  saveDraftsState = opts.saveDraftsState;
  findProjectByName = opts.findProjectByName;
  findProjectByPAP = opts.findProjectByPAP;
  findProjectAndAAPByAAPToken = opts.findProjectAndAAPByAAPToken;
  ensureProjectDirs = opts.ensureProjectDirs;
  listVersions = opts.listVersions;
  serverHelpers = opts.serverHelpers || {};

  loadState();
  loadTAP();
  if (TAP && TAP.token) {
    refreshBotMe().then(() => {
      configureBotProfile().catch(()=>{});
      pollLoop();
    });
    if (botMeRefreshTimer) clearInterval(botMeRefreshTimer);
    botMeRefreshTimer = setInterval(refreshBotMe, 6 * 3600 * 1000);
  } else {
    console.log('[telepath] no TAP installed — bot inactive. Install via PUT /drafts/tap');
  }
}

export function mountTelepathRoutes(app) { mountRoutes(app); }

export const hooks = {
  onNewProject,
  onNewAAPCreated,
  onAAPMerged,
  onMainCommit,
};

export function getTelepathStatus() {
  return {
    installed: !!(TAP && TAP.token),
    bot: TAP ? TAP.bot : null,
    polling,
    users_count: telepathState ? Object.keys(telepathState.users).length : 0,
  };
}
