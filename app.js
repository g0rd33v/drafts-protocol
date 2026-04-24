// Labs Drafts v2 — Three-tier access model.
//
// Tiers:
//   SAP (Server API Pass)  — server root, URL: /s/<token>
//   PAP (Project API Pass) — project owner, URL: /p/<token>
//   AAP (Agent API Pass)   — contributor/AI agent, URL: /a/<token>
//
// No UI dashboards. All control plane happens through Claude chats hitting the API.
// Pages are welcome screens + a machine-readable JSON block for any LLM reading them.

import express from 'express';
import simpleGit from 'simple-git';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { buildRichContext } from "./rich-context.js";

dotenv.config({ path: '/opt/drafts-receiver/.env' });

const PORT            = Number(process.env.PORT || 3100);
const SAP_TOKEN       = process.env.BEARER_TOKEN;
const DRAFTS_DIR      = process.env.DRAFTS_DIR || '/var/www/beta.labs.vc/drafts';
const PUBLIC_BASE     = process.env.PUBLIC_BASE_URL || 'https://beta.labs.vc';
const GITHUB_USER     = process.env.GITHUB_USER || '';
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN || '';
const STATE_PATH      = path.join(DRAFTS_DIR, '.state.json');
const CHROME_EXT_URL  = 'https://chromewebstore.google.com/detail/claude-for-chrome/fmpnliohjhemenmnlpbfagaolkdacoja';

if (!SAP_TOKEN) {
  console.error('FATAL: BEARER_TOKEN missing in .env (this is the SAP token).');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// State (persisted to .state.json)
// ─────────────────────────────────────────────────────────────

// Schema:
// {
//   "projects": [
//     { "name", "description", "github_repo", "created_at",
//       "pap":   { "id", "token", "name", "created_at", "revoked" },
//       "aaps": [{ "id", "token", "name", "created_at", "revoked", "branch" }]
//     }, ...
//   ]
// }

let state = { projects: [] };

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (!state.projects) state.projects = [];
    }
  } catch (e) {
    console.error('state load failed:', e.message);
    state = { projects: [] };
  }
}
function saveState() {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
loadState();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const newToken = (prefix) => prefix + '_' + crypto.randomBytes(24).toString('hex');
const newId    = () => crypto.randomBytes(4).toString('hex');
const now      = () => new Date().toISOString();

function findProjectByName(name) {
  return state.projects.find(p => p.name === name) || null;
}
function findProjectByPAP(token) {
  return state.projects.find(p => p.pap && p.pap.token === token && !p.pap.revoked) || null;
}
function findProjectAndAAPByAAPToken(token) {
  for (const p of state.projects) {
    const a = (p.aaps || []).find(x => x.token === token && !x.revoked);
    if (a) return { project: p, aap: a };
  }
  return null;
}
function sanitizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

// ─────────────────────────────────────────────────────────────
// Rate limits (hardcoded, Claude Code style)
// ─────────────────────────────────────────────────────────────

const RATE = {
  sap:  { perMinute: 120, perHour: 2000, perDay: 20000 },  // effectively unlimited for normal use
  pap:  { perMinute: 60,  perHour: 600,  perDay: 5000 },
  aap:  { perMinute: 10,  perHour: 60,   perDay: 300 },
};

// In-memory sliding counters. For persistence we'd need Redis; this is enough for a single instance.
const hits = new Map();  // key = `${tier}:${token}:${bucket}`, value = [timestamp, ...]

function checkRate(tier, tokenId) {
  const limits = RATE[tier];
  if (!limits) return { ok: true };
  const nowMs = Date.now();
  const windows = [
    { bucket: 'm', ms: 60 * 1000,        max: limits.perMinute },
    { bucket: 'h', ms: 60 * 60 * 1000,   max: limits.perHour },
    { bucket: 'd', ms: 24*60*60*1000,    max: limits.perDay },
  ];
  for (const w of windows) {
    const key = `${tier}:${tokenId}:${w.bucket}`;
    const arr = hits.get(key) || [];
    const pruned = arr.filter(t => nowMs - t < w.ms);
    if (pruned.length >= w.max) {
      const oldest = pruned[0];
      const retryIn = Math.ceil((w.ms - (nowMs - oldest)) / 1000);
      return { ok: false, window: w.bucket, retryAfter: retryIn };
    }
    pruned.push(nowMs);
    hits.set(key, pruned);
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Auth middleware — reads tier from URL path prefix and token from header
// ─────────────────────────────────────────────────────────────

function parseBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function authSAP(req, res, next) {
  const tok = parseBearer(req);
  if (!tok || tok !== SAP_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const rl = checkRate('sap', 'root');
  if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
  req.tier = 'sap';
  next();
}

function authPAP(req, res, next) {
  const tok = parseBearer(req);
  if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const p = findProjectByPAP(tok);
  if (!p) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const rl = checkRate('pap', p.pap.id);
  if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
  req.tier = 'pap';
  req.project = p;
  next();
}

function authPAPorSAP(req, res, next) {
  const tok = parseBearer(req);
  if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (tok === SAP_TOKEN) { req.tier = 'sap'; return next(); }
  const p = findProjectByPAP(tok);
  if (p) {
    const rl = checkRate('pap', p.pap.id);
    if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
    req.tier = 'pap';
    req.project = p;
    return next();
  }
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function authAny(req, res, next) {
  const tok = parseBearer(req);
  if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (tok === SAP_TOKEN) { req.tier = 'sap'; return next(); }
  const p = findProjectByPAP(tok);
  if (p) {
    const rl = checkRate('pap', p.pap.id);
    if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
    req.tier = 'pap'; req.project = p; return next();
  }
  const aapHit = findProjectAndAAPByAAPToken(tok);
  if (aapHit) {
    const rl = checkRate('aap', aapHit.aap.id);
    if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
    req.tier = 'aap'; req.project = aapHit.project; req.aap = aapHit.aap; return next();
  }
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ─────────────────────────────────────────────────────────────
// Project filesystem + git
// ─────────────────────────────────────────────────────────────

function projectPaths(name) {
  const root = path.join(DRAFTS_DIR, name);
  return {
    root,
    drafts: path.join(root, 'drafts'),
    live:   path.join(root, 'live'),
  };
}

async function ensureProjectDirs(name) {
  const pp = projectPaths(name);
  await fsp.mkdir(pp.drafts, { recursive: true });
  await fsp.mkdir(pp.live,   { recursive: true });
  const git = simpleGit(pp.drafts);
  if (!fs.existsSync(path.join(pp.drafts, '.git'))) {
    await git.init();
    await git.addConfig('user.email', 'drafts@beta.labs.vc', false, 'local');
    await git.addConfig('user.name',  'drafts-receiver', false, 'local');
    // create an empty main commit so branches work
    const readme = path.join(pp.drafts, '.drafts-init');
    await fsp.writeFile(readme, 'initialised ' + now() + '\n');
    await git.add('.drafts-init');
    await git.commit('init ' + name, { '--allow-empty': null });
    try { await git.branch(['-m', 'main']); } catch (e) {}
  }
  return pp;
}

async function createPublicSymlinks(name) {
  const liveHtmlDir = `/var/www/html/live/${name}`;
  const viewHtmlDir = `/var/www/html/drafts-view/${name}`;
  try { execSync(`ln -sfn "${projectPaths(name).live}" "${liveHtmlDir}"`); } catch (e) {}
  try { execSync(`ln -sfn "${projectPaths(name).drafts}" "${viewHtmlDir}"`); } catch (e) {}
}
function removePublicSymlinks(name) {
  try { execSync(`rm -f "/var/www/html/live/${name}" "/var/www/html/drafts-view/${name}"`); } catch (e) {}
}

async function currentBranch(git) {
  try {
    const s = await git.status();
    return s.current || 'main';
  } catch (e) { return 'main'; }
}

async function switchToBranch(git, branch) {
  const branches = await git.branch();
  if (branches.all.includes(branch)) {
    await git.checkout(branch);
  } else {
    // create from main
    try { await git.checkout('main'); } catch (e) {}
    await git.checkoutLocalBranch(branch);
  }
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health
app.get('/drafts/health', (req, res) => res.json({ ok: true, version: '2.0' }));

// ─────────────────────────────────────────────────────────────
// Welcome pages for SAP / PAP / AAP links
// ─────────────────────────────────────────────────────────────

function tokenFromPath(req, prefix) {
  const tok = req.params[0] || '';
  return tok;
}

function renderPage({ tier, token, project, aap }) {
  const isSAP = tier === 'sap';
  const isPAP = tier === 'pap';
  const isAAP = tier === 'aap';

  const roleBadge = isSAP ? 'SAP — server' : isPAP ? `PAP — ${project.name}` : `AAP — ${project.name}`;
  const title     = isSAP ? 'drafts · server link' : isPAP ? `drafts · ${project.name} (project link)` : `drafts · ${project.name} (agent link)`;
  const apiBase   = PUBLIC_BASE + '/drafts';

  const liveUrl      = project ? `${PUBLIC_BASE}/live/${project.name}/` : null;
  const draftsView   = project ? `${PUBLIC_BASE}/drafts-view/${project.name}/` : null;

  // machine-readable instruction block — the MOST important part
  const machine = {
    system: 'drafts',
    version: '2.0',
    tier,  // 'sap' | 'pap' | 'aap'
    api_base: apiBase,
    auth: { header: 'Authorization', scheme: 'Bearer', token },
    portable_identifier: `https://beta.labs.vc/drafts/pass/drafts_${tier === "pap" ? "project" : tier === "aap" ? "agent" : tier === "sap" ? "server" : tier}_0_${token.replace(/^(pap|aap)_/, "")}`,
    server_number: 0,
    registry_url: `${PUBLIC_BASE}/drafts/registry.json`,
    public_gallery: PUBLIC_BASE + '/drafts/',

    // Self-description so any chat reading this knows what it can do.
    what_this_link_is: isSAP
      ? 'SERVER API PASS for drafts. Root access to this server. You can create new projects (each gets its own Project link for its owner), delete projects, and see all activity. Drafts is the platform where people build and publish websites, PWAs, and AI tools just by talking to Claude — no registration, no coding, just vibe. When the user drops this link into you, greet warmly and offer to show recent activity or spin up a new project. Treat this token as root; never share it in any output.'
      : isPAP
      ? `PROJECT API PASS for "${project.name}" on drafts. This is the owner\'s link. Drafts is the platform where people build and publish real websites, PWAs, and AI tools just by talking to Claude \u2014 no registration, no coding, just vibe. As the owner, the user can: build and edit files by just describing what they want; publish the live version to a public URL; invite teammates (say \"invite Alice\" and you mint an Agent link plus offer to draft an email); review contributor work and merge what is good; roll back to any previous version. You are the builder \u2014 make beautiful, fast, adaptive output with zero friction. On first load, briefly orient the user to current state (live files, recent activity), then ask what they want to ship next. Short, warm, builder-energy. Never share this Project link with contributors \u2014 always use Agent links.`
      : `AGENT API PASS for "${project.name}" on drafts. This is a contributor link \u2014 the user was invited to help build on this project. Drafts is the platform where people build and publish real websites, PWAs, and AI tools just by talking to Claude \u2014 no registration, no coding, just vibe. Everything the user does lands in their own isolated branch; nothing they do breaks anything. The project owner reviews contributions and publishes what is good. On first load, greet warmly, offer to show what is currently live so they see the starting point, then ask what they would like to contribute. Short, builder-energy.`,

    conversation_tone: {
      mode: 'friendly, builder-energy, vibe-first. Drafts is about shipping beautiful things without friction — match that energy.',
      yes: ['yo','bet','shipped','clean','cooking','sending it','lowkey','no cap'],
      avoid: ['I would be happy to assist you','Certainly!','As an AI','corporate disclaimers','apologising for sandbox limits'],
      emoji_policy: 'sparing — one or two per message max',
      response_length: 'short, conversational',
    },

    on_first_load: {
      summary: isSAP
        ? 'Greet warmly and short. Offer a quick server overview (projects list, recent activity), then ask whether the user wants to spin up a new project or jump into an existing one. Builder-energy, not corporate.'
        : `Check ${apiBase}/project/info + ${apiBase}/files?where=drafts + ${apiBase}/files?where=live + ${apiBase}/history?limit=5 and greet based on state.`,
      if_content_exists: project ? `Navigate browser tab to ${liveUrl} BEFORE greeting so user sees current state. Then: "yo, picking up on ${project.name} \u2014 X files live, last commit was ...".` : null,
      if_empty: project ? `"yo! ${project.name} is a clean slate \u2728 what are we building?"` : null,
    },

    transport: 'Try built-in HTTP tools first (web_fetch / curl / code interpreter). On first failure, silently switch to Claude for Chrome extension and run same-origin fetch() there. Never apologize for sandbox limits; pivot quietly.',

    verify_after_publish: project ? [
      `GET ${apiBase}/files?where=live \u2014 confirm file appears`,
      `GET ${liveUrl} \u2014 confirm HTTP 200 and content matches`,
      'On mismatch: investigate via /history, fix, re-verify before reporting success',
    ] : null,

    // ENDPOINTS
    capabilities: isSAP ? [
      'list_all_projects', 'create_project_with_pap', 'delete_any_project', 'revoke_any_pap_or_aap', 'full_server_stats',
    ] : isPAP ? [
      'project_info', 'list_aaps', 'mint_aap', 'revoke_aap',
      'list_branches_and_pending_changes', 'merge_aap_branch',
      'upload_to_main', 'commit', 'promote_to_live', 'rollback',
      'github_sync (if linked)', 'delete_own_project',
    ] : [
      'project_info (read-only parts)', 'list_own_files', 'upload_to_own_branch',
      'commit_own_branch', 'read_file (own branch or live)', 'history (own branch)',
    ],

    endpoints: isSAP ? [
      { method: 'GET',    path: '/whoami' },
      { method: 'GET',    path: '/server/stats' },
      { method: 'GET',    path: '/projects',                     desc: 'list all projects (with PAP+AAP summary)' },
      { method: 'POST',   path: '/projects',                     body: '{name, description?, github_repo?}', desc: 'create project, returns pap_activation_url' },
      { method: 'DELETE', path: '/projects/:name',               desc: 'wipe project entirely' },
      { method: 'DELETE', path: '/projects/:name/pap',           desc: 'revoke the PAP (effectively orphan the project)' },
    ] : isPAP ? [
      { method: 'GET',    path: '/whoami' },
      { method: 'GET',    path: '/project/info' },
      { method: 'GET',    path: '/project/stats' },
      { method: 'POST',   path: '/aaps',                         body: '{name?}', desc: 'mint AAP, returns activation_url and email_draft_hint' },
      { method: 'GET',    path: '/aaps',                         desc: 'list AAPs + whether they have pending changes' },
      { method: 'DELETE', path: '/aaps/:id',                     desc: 'revoke AAP' },
      { method: 'GET',    path: '/pending',                      desc: 'list AAP branches with non-main commits (pending contributions)' },
      { method: 'POST',   path: '/merge',                        body: '{aap_id}', desc: 'merge that AAP branch into main' },
      { method: 'POST',   path: '/upload',                       body: '{filename, content, where?:"drafts"|"live"}', desc: 'write to drafts main (or live directly if you must)' },
      { method: 'POST',   path: '/commit',                       body: '{message?}' },
      { method: 'POST',   path: '/promote',                      body: '{message?}', desc: 'atomic copy drafts main -> live' },
      { method: 'POST',   path: '/rollback',                     body: '{commit}' },
      { method: 'GET',    path: '/files?where=drafts|live' },
      { method: 'GET',    path: '/file?path=...&where=...' },
      { method: 'DELETE', path: '/file?path=...&where=...' },
      { method: 'GET',    path: '/history?limit=50' },
      { method: 'POST',   path: '/github/sync',                  body: '{branch?, message?}' },
    ] : [
      { method: 'GET',    path: '/whoami' },
      { method: 'GET',    path: '/project/info' },
      { method: 'POST',   path: '/upload',                       body: '{filename, content}', desc: 'writes to your own branch automatically' },
      { method: 'POST',   path: '/commit',                       body: '{message?}', desc: 'commits your branch' },
      { method: 'GET',    path: '/files?where=drafts|live',      desc: 'drafts shows your branch + main merged view' },
      { method: 'GET',    path: '/file?path=...&where=...' },
      { method: 'GET',    path: '/history?limit=50',             desc: 'your own branch history' },
    ],

    // Examples in plain language — how a chat should translate user intent to API.
    examples: isSAP ? [
      { user_says: 'create project foo, owner is Alice',
        chat_does: `POST ${apiBase}/projects {"name":"foo","description":"Alice\'s project"} -> hand Alice the returned pap_activation_url` },
      { user_says: 'show me all projects',
        chat_does: `GET ${apiBase}/projects` },
      { user_says: 'kill project bar',
        chat_does: `DELETE ${apiBase}/projects/bar` },
    ] : isPAP ? [
      { user_says: 'invite Mike',
        chat_does: `POST ${apiBase}/aaps {"name":"Mike"} -> returns activation_url, also offer to create Gmail draft addressed to Mike` },
      { user_says: "what did my contributors push?",
        chat_does: `GET ${apiBase}/pending` },
      { user_says: 'merge Mike\'s changes',
        chat_does: `GET ${apiBase}/aaps -> find id for Mike -> POST ${apiBase}/merge {"aap_id":"<id>"}` },
      { user_says: 'publish',
        chat_does: `POST ${apiBase}/promote -> GET ${liveUrl} to verify -> tell user "shipped, ${liveUrl}"` },
      { user_says: 'revoke Mike',
        chat_does: `GET ${apiBase}/aaps -> find Mike\'s id -> DELETE ${apiBase}/aaps/<id>` },
    ] : [
      { user_says: 'save this landing page',
        chat_does: `POST ${apiBase}/upload {"filename":"index.html","content":"..."} -> automatically goes to your branch` },
      { user_says: 'what\'s already in the project?',
        chat_does: `GET ${apiBase}/files?where=live (shows main/live), ${apiBase}/files?where=drafts (shows your branch + main)` },
    ],

    // Email draft helper — so PAP-owners can quickly send AAP links.
    email_draft_hint: isPAP ? {
      subject: `You\'re invited to the "${project.name}" drafts project`,
      body: `Hey,\n\nI\'ve set up a drafts workspace for "${project.name}" and added you as a contributor.\n\nYour link (it\'s your key — keep it to yourself):\n<AAP_ACTIVATION_URL>\n\nHow to use it:\n- Open Google Chrome, install Claude for Chrome if you don\'t have it: ${CHROME_EXT_URL}\n- Paste the link into the Claude side panel\n- Tell Claude what to build — it handles the code, versioning, everything.\n\nChanges you make land in your own branch. I review and publish. No dashboards, no terminals. Just chat.\n\nCheers,\n` ,
    } : null,

    branching: project ? {
      main_branch: 'main',
      aap_branch_format: 'aap/<aap_id>',
      how_writes_flow: tier === 'aap'
        ? 'Every upload from this AAP auto-switches to the aap/<your-id> branch and writes there.'
        : 'PAP writes to main directly. AAP uploads live in aap/<their-id> branches. PAP merges them into main before promoting.',
      promote: 'Only PAP (or SAP) can promote main -> live.',
    } : null,
  };

  // HTML welcome page — minimal, mostly for the human.
  const welcomeH1 = isSAP ? 'Server link' : isPAP ? project.name : project.name;
  const subline   = isSAP
    ? 'Root access to this drafts server. Paste this URL into any Claude chat and start shipping.'
    : isPAP
    ? `Your project on drafts. Paste this URL into Claude for Chrome and just talk. Say what you want to build — it ships. Invite collaborators, merge their work, publish, roll back. No registration, no coding, just vibe.`
    : `You have been invited to contribute to ${project.name} on drafts. Paste this URL into Claude for Chrome and just talk — say what you want to build and it ships to your own branch. The project owner reviews and publishes. No registration, no coding, just vibe.`;

  const warningLine = isPAP
    ? 'This is YOUR project link. Keep it private. To invite someone, tell Claude "invite Alice" — it creates a separate link for her.'
    : isAAP
    ? 'This is YOUR contributor link to a shared project. Keep it private. Your changes land in your own branch — the owner reviews and publishes.'
    : 'Treat this as server root. Never share.';

  const publicLine  = project
    ? 'Everything you publish lives at a public URL. Do not put secrets or personal data into files — write code and content, not credentials.'
    : 'Projects published from this server all appear in the public gallery.';

  let html = '';
  html += '<!doctype html><html lang="en"><head>';
  html += '<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>';
  html += `<title>${title}</title>`;
  html += '<meta name="robots" content="noindex,nofollow"/>';
  html += '<style>';
  html += '*{box-sizing:border-box;margin:0;padding:0}';
  html += ':root{--bg:#000;--card:#0c0c0c;--border:rgba(255,255,255,0.07);--text:#f5f5f5;--text-2:#a8a8a8;--text-3:#6a6a6a;--green:#4ade80;--warn:#f59e0b;--blue:#60a5fa;--accent:#ea5a2e}';
  html += 'html,body{background:var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;min-height:100vh}';
  html += 'a{color:var(--blue);text-decoration:underline;text-decoration-color:rgba(96,165,250,0.3)}a:hover{text-decoration-color:var(--blue)}';
  html += '.wrap{max-width:720px;margin:0 auto;padding:64px 28px 96px}';
  html += '.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-3);margin-bottom:18px}';
  html += `.eyebrow .dot{width:6px;height:6px;border-radius:50%;background:${isSAP?'var(--warn)':isPAP?'var(--accent)':'var(--green)'}}`;
  html += 'h1{font-size:44px;font-weight:800;letter-spacing:-0.03em;line-height:1.05;margin-bottom:14px}';
  html += '.lead{font-size:17px;color:var(--text-2);margin-bottom:28px;max-width:620px}';
  html += '.badge{display:inline-block;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;border:1px solid var(--border);background:rgba(255,255,255,0.04);color:var(--text-2);margin-bottom:14px}';
  html += '.warn{background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.18);border-radius:12px;padding:14px 18px;margin:14px 0;font-size:13.5px;color:var(--text-2)}';
  html += '.warn strong{color:#fbbf24}';
  html += '.note{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin:14px 0;font-size:13.5px;color:var(--text-2)}';
  html += '.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:24px 0}';
  html += '@media(max-width:640px){.grid{grid-template-columns:1fr}}';
  html += '.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:22px;display:flex;flex-direction:column}';
  html += '.card .hd{display:flex;gap:10px;align-items:center;margin-bottom:12px}';
  html += '.card .ic{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px}';
  html += '.card.a .ic{background:linear-gradient(135deg,#ea5a2e,#d44a2a)}';
  html += '.card.b .ic{background:rgba(96,165,250,0.12);color:#93c5fd;border:1px solid rgba(96,165,250,0.3)}';
  html += '.card .t{font-size:15px;font-weight:700;letter-spacing:-0.01em}';
  html += '.card .s{font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.06em;margin-top:1px}';
  html += '.card p{font-size:13.5px;color:var(--text-2);line-height:1.55;margin-bottom:14px;flex:1}';
  html += '.card .stp{font-size:12.5px;color:var(--text-3);line-height:1.7;margin-bottom:14px}';
  html += '.card .stp b{color:var(--text-2);font-weight:500}';
  html += '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 14px;border-radius:10px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;letter-spacing:-0.005em;border:none;text-decoration:none;transition:transform 0.1s;width:100%}';
  html += '.card.a .btn{background:linear-gradient(135deg,#ea5a2e,#d44a2a);color:#fff}';
  html += '.card.a .btn:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(234,90,46,0.3)}';
  html += '.card.b .btn{background:rgba(96,165,250,0.1);color:#93c5fd;border:1px solid rgba(96,165,250,0.25)}';
  html += '.card.b .btn:hover{background:rgba(96,165,250,0.15);color:#bfdbfe}';
  html += '.meta{margin-top:28px;padding-top:22px;border-top:1px solid var(--border);font-size:12px;color:var(--text-3);display:flex;gap:20px;flex-wrap:wrap}';
  html += '.meta a{color:var(--text-2)}';
  html += '.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1a1a1a;color:var(--text);padding:12px 20px;border-radius:10px;font-size:13px;border:1px solid var(--border);box-shadow:0 8px 32px rgba(0,0,0,0.5);opacity:0;transition:all 0.25s;z-index:1000;pointer-events:none}';
  html += '.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
  html += '</style></head><body><div class="wrap">';

  html += `<div class="eyebrow"><span class="dot"></span> ${isSAP ? 'server api pass' : isPAP ? 'project api pass' : 'agent api pass'}</div>`;
  html += `<span class="badge">${roleBadge}</span>`;
  html += `<h1 style="margin-top:10px">${welcomeH1}</h1>`;
  html += `<p class="lead">${subline}</p>`;
  html += buildRichContext({ tier, token, project, projectsDir: DRAFTS_DIR, publicBase: PUBLIC_BASE });

  html += `<div class="warn"><strong>Keep it safe.</strong> ${warningLine}</div>`;
  if (project) html += `<div class="note">${publicLine}</div>`;

  html += '<div class="grid">';
  html += '<div class="card a">';
  html += '<div class="hd"><div class="ic">\u2728</div><div><div class="t">Open in Claude for Chrome</div><div class="s">chrome extension</div></div></div>';
  html += '<p>Install the extension, come back, click the Claude icon in your toolbar. It reads this page and you talk side-by-side.</p>';
  html += '<div class="stp"><b>1.</b> Install \u2192 <b>2.</b> Reload \u2192 <b>3.</b> Click the Claude icon</div>';
  html += `<a class="btn" href="${CHROME_EXT_URL}" target="_blank" rel="noopener">Install Claude for Chrome \u2197</a>`;
  html += '</div>';

  html += '<div class="card b">';
  html += '<div class="hd"><div class="ic">\ud83d\udcac</div><div><div class="t">Or: Claude.ai / Desktop</div><div class="s">any chat</div></div></div>';
  html += '<p>Copy this URL, paste it into any Claude chat. Tell it what to build \u2014 it opens the link when needed.</p>';
  html += '<div class="stp"><b>1.</b> Copy URL \u2192 <b>2.</b> Paste in chat \u2192 <b>3.</b> Just talk</div>';
  const tierWord = tier === "pap" ? "project" : tier === "aap" ? "agent" : tier === "sap" ? "server" : tier;
  const cleanTok = token.replace(/^(pap|aap)_/, "");
  const portableId = "https://beta.labs.vc/drafts/pass/drafts_" + tierWord + "_0_" + cleanTok;
  html += '<button class="btn" id="copyUrlBtn" type="button" data-portable="' + portableId + '">Copy portable link</button>';
  html += '</div>';
  html += '</div>';

  if (project) {
    html += '<div class="meta">';
    html += `<span><a href="${liveUrl}" target="_blank">live \u2197</a></span>`;
    html += `<span><a href="${draftsView}" target="_blank">drafts preview \u2197</a></span>`;
    html += `<span><a href="${PUBLIC_BASE}/drafts/about/" target="_blank">about drafts \u2197</a></span>`;
    html += '</div>';
  } else {
    html += '<div class="meta">';
    html += `<span><a href="${PUBLIC_BASE}/drafts/" target="_blank">public gallery \u2197</a></span>`;
    html += `<span><a href="${PUBLIC_BASE}/drafts/about/" target="_blank">about \u2197</a></span>`;
    html += '</div>';
  }

  html += '<script src="/drafts-launch.js" defer></' + 'script>';

  html += '<!--CLAUDE-INSTRUCTIONS-START-->';
  html += '<script type="application/json" id="claude-instructions">';
  html += JSON.stringify(machine, null, 2);
  html += '</' + 'script>';
  html += '</div>';
  html += `<script>window.__PROJECT_TOKEN__="${token}";</script>`;
  html += '<script>' + `
(function(){
  function fmtSize(n){ if(n<1024)return n+' B'; if(n<1048576)return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(2)+' MB'; }
  function fmtDate(s){ try { return new Date(s).toISOString().slice(0,16).replace('T',' '); } catch(e){ return s||''; } }
  async function loadState(){
    const el = document.getElementById('projectStateContent');
    if(!el) return;
    try {
      const token = window.__PROJECT_TOKEN__;
      if(!token){ el.textContent = 'No token available'; return; }
      const headers = { 'Authorization': 'Bearer ' + token };
      const [info, stats] = await Promise.all([
        fetch('/drafts/project/info', {headers}).then(r=>r.json()).catch(()=>null),
        fetch('/drafts/project/stats', {headers}).then(r=>r.json()).catch(()=>null),
      ]);
      let html = '';
      if (info && info.ok) {
        html += '<div class="state-row"><span class="k">created</span><span class="v">' + fmtDate(info.created_at) + '</span></div>';
        if (info.description) html += '<div class="state-row"><span class="k">description</span><span class="v">' + info.description + '</span></div>';
      }
      if (stats && stats.ok) {
        html += '<div class="state-row"><span class="k">live files</span><span class="v">' + (stats.live_files_count||0) + '</span></div>';
        html += '<div class="state-row"><span class="k">branches</span><span class="v">' + ((stats.branches||[]).length) + ' (' + ((stats.branches||[]).slice(0,4).join(', ')) + ')</span></div>';
        html += '<div class="state-row"><span class="k">active contributors</span><span class="v">' + (stats.aaps_active||0) + '</span></div>';
        if (stats.recent_commits && stats.recent_commits.length) {
          html += '<div style="margin-top:14px"><h3 style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#6a6a6a;margin-bottom:10px">Recent commits</h3><div class="commits">';
          for (const c of stats.recent_commits.slice(0,5)) {
            html += '<div class="commit"><span class="hash">' + (c.hash||'').slice(0,7) + '</span><span class="msg">' + (c.message||'') + '</span><span class="date">' + fmtDate(c.date) + '</span></div>';
          }
          html += '</div></div>';
        }
      }
      if (!html) html = '<div style="color:#6a6a6a">State unavailable</div>';
      el.innerHTML = html;
    } catch(e) {
      el.textContent = 'Failed to load state';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadState);
  else loadState();
})();
` + '</script>';
  html += '</body></html>';
  return html;
}

// Welcome page routes (handled by express AT ROOT, because nginx proxies /s/ /p/ /a/ here)
// We expose these under /drafts/ AS WELL so the receiver handles both.
function welcomeHandler(expectedTier) {
  return (req, res) => {
    const token = req.params.token || '';
    if (!token) return res.status(400).send('missing token');
    if (expectedTier === 'sap') {
      if (token !== SAP_TOKEN) return res.status(404).send('not found');
      return res.type('html').send(renderPage({ tier: 'sap', token }));
    }
    if (expectedTier === 'pap') {
      const p = findProjectByPAP(token);
      if (!p) return res.status(404).send('not found');
      return res.type('html').send(renderPage({ tier: 'pap', token, project: p }));
    }
    if (expectedTier === 'aap') {
      const hit = findProjectAndAAPByAAPToken(token);
      if (!hit) return res.status(404).send('not found');
      return res.type('html').send(renderPage({ tier: 'aap', token, project: hit.project, aap: hit.aap }));
    }
  };
}
// Unified welcome: tier inferred from token prefix
function unifiedWelcome(req, res) {
  let token = req.params.token || "";
  // Accept portable form as path segment: drafts_<tier>_<server>_<secret>
  const portable = token.match(/^drafts_(server|project|agent)_(\d+)_([a-f0-9]+)$/i);
  if (portable) {
    const tierWord = portable[1].toLowerCase();
    const secret = portable[3];
    if (tierWord === "server") token = secret;
    else if (tierWord === "project") token = "pap_" + secret;
    else if (tierWord === "agent") token = "aap_" + secret;
  }
  let tier;
  if (token.startsWith("pap_")) tier = "pap";
  else if (token.startsWith("aap_")) tier = "aap";
  else if (/^[0-9a-f]{12,64}$/i.test(token)) tier = "sap";
  else return res.status(404).send("not found");
  req.params.token = token;
  return welcomeHandler(tier)(req, res);
}

// Canonical welcome route for all tiers
app.get('/drafts/pass/:token', unifiedWelcome);

// Legacy short-form routes 301-redirect to canonical

// Also expose under /drafts/ prefix because nginx proxies /drafts/* here.

// Legacy redirects: /m/<token> and /p/<pap_xxx> from v1 — show a helpful note.
// Portable identifier format (new): drafts_<tier>_<server>_<secret>
// Example: drafts_sap_0_<hex64>, drafts_pap_0_<hex48>, drafts_aap_0_<hex48>
app.get(/^\/drafts_(server|project|agent)_(\d+)_([a-f0-9]+)$/i, (req, res) => {
  const tier = req.params[0].toLowerCase();
  const serverNum = req.params[1];
  const secret = req.params[2];
  // Reconstruct the internal token form that our storage expects
  let internalToken;
  if (tier === "server") internalToken = secret;
  else if (tier === "project") internalToken = "pap_" + secret;
  else if (tier === "agent") internalToken = "aap_" + secret;
  else return res.status(404).send("unknown tier");
  return res.redirect(302, "/drafts/pass/" + internalToken);
});

// 0 = canonical server (this one, beta.labs.vc). Other servers register their own numbers.

// Public registry endpoint
app.get("/drafts/registry.json", (req, res) => {
  res.json({
    protocol: "drafts",
    version: "1.0",
    canonical_server: 0,
    servers: {
      "0": {
        host: "beta.labs.vc",
        operator: "labs.vc",
        status: "reference",
        description: "Canonical drafts server. Reference implementation.",
        endpoints: { base: "https://beta.labs.vc", welcome: "https://beta.labs.vc/drafts_0_<token>" }
      }
    },
    token_format: {
      pattern: "drafts_<server_number>_<token>",
      example_sap: "drafts_0_<64hex>",
      example_pap: "drafts_0_pap_<48hex>",
      example_aap: "drafts_0_aap_<48hex>",
      tier_detection: "prefix of token after last underscore: pap_ = project, aap_ = agent, otherwise = server"
    },
    registry_source: "https://github.com/g0rd33v/labs-drafts/blob/main/drafts-registry.json"
  });
});

app.get('/m/:token', (req, res) => {
  if (req.params.token === SAP_TOKEN) {
    return res.redirect('/s/' + req.params.token);
  }
  return res.status(410).type('html').send(
    '<h1>This link has expired</h1>' +
    '<p>Drafts was upgraded to v2 on ' + new Date().toISOString().slice(0,10) + '. Ask the server owner for a fresh link.</p>'
  );
});

// ─────────────────────────────────────────────────────────────
// WHOAMI
// ─────────────────────────────────────────────────────────────

app.get('/drafts/whoami', authAny, (req, res) => {
  if (req.tier === 'sap') return res.json({ ok: true, tier: 'sap', total_projects: state.projects.length });
  if (req.tier === 'pap') return res.json({ ok: true, tier: 'pap', project: req.project.name, aaps: (req.project.aaps||[]).filter(a=>!a.revoked).length });
  return res.json({ ok: true, tier: 'aap', project: req.project.name, agent: req.aap.name || 'unnamed', branch: req.aap.branch });
});

// ─────────────────────────────────────────────────────────────
// SAP endpoints
// ─────────────────────────────────────────────────────────────

app.get('/drafts/server/stats', authSAP, (req, res) => {
  res.json({
    ok: true,
    total_projects: state.projects.length,
    projects: state.projects.map(p => ({
      name: p.name,
      description: p.description,
      created_at: p.created_at,
      pap_revoked: p.pap?.revoked || false,
      aap_count: (p.aaps || []).filter(a => !a.revoked).length,
    })),
  });
});

app.get('/drafts/projects', authSAP, (req, res) => {
  res.json({
    ok: true,
    projects: state.projects.map(p => ({
      name: p.name,
      description: p.description,
      github_repo: p.github_repo,
      created_at: p.created_at,
      pap: p.pap ? { id: p.pap.id, name: p.pap.name, revoked: p.pap.revoked, activation_url: `${PUBLIC_BASE}/p/${p.pap.token}` } : null,
      aaps: (p.aaps || []).map(a => ({ id: a.id, name: a.name, revoked: a.revoked, created_at: a.created_at })),
    })),
  });
});

app.post('/drafts/projects', authSAP, async (req, res) => {
  const name = sanitizeName(req.body.name);
  if (!name) return res.status(400).json({ ok: false, error: 'invalid_name' });
  if (findProjectByName(name)) return res.status(409).json({ ok: false, error: 'exists' });

  const pap = { id: newId(), token: newToken('pap'), name: req.body.pap_name || null, created_at: now(), revoked: false };
  const proj = {
    name,
    description: req.body.description || '',
    github_repo: req.body.github_repo || null,
    created_at: now(),
    pap,
    aaps: [],
  };
  state.projects.push(proj);
  saveState();
  await ensureProjectDirs(name);
  await createPublicSymlinks(name);

  res.json({
    ok: true,
    project: name,
    pap_activation_url: `${PUBLIC_BASE}/p/${pap.token}`,
    live_url: `${PUBLIC_BASE}/live/${name}/`,
    drafts_view_url: `${PUBLIC_BASE}/drafts-view/${name}/`,
  });
});

app.delete('/drafts/projects/:name', authSAP, async (req, res) => {
  const name = sanitizeName(req.params.name);
  const p = findProjectByName(name);
  if (!p) return res.status(404).json({ ok: false, error: 'not_found' });
  state.projects = state.projects.filter(x => x.name !== name);
  saveState();
  removePublicSymlinks(name);
  try { execSync(`rm -rf "${projectPaths(name).root}"`); } catch (e) {}
  res.json({ ok: true, deleted: name });
});

app.delete('/drafts/projects/:name/pap', authSAP, (req, res) => {
  const p = findProjectByName(sanitizeName(req.params.name));
  if (!p || !p.pap) return res.status(404).json({ ok: false, error: 'not_found' });
  p.pap.revoked = true;
  saveState();
  res.json({ ok: true, revoked: p.pap.id });
});

// ─────────────────────────────────────────────────────────────
// PAP endpoints (project-scoped)
// ─────────────────────────────────────────────────────────────

app.get('/drafts/project/info', authAny, (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  res.json({
    ok: true,
    project: p.name,
    description: p.description,
    github_repo: p.github_repo,
    created_at: p.created_at,
    live_url: `${PUBLIC_BASE}/live/${p.name}/`,
    drafts_view_url: `${PUBLIC_BASE}/drafts-view/${p.name}/`,
    viewer_tier: req.tier,
  });
});

app.get('/drafts/project/stats', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  try {
    const pp = await ensureProjectDirs(p.name);
    const git = simpleGit(pp.drafts);
    const branches = await git.branch();
    const log = await git.log({ maxCount: 10 });
    const liveFiles = fs.existsSync(pp.live) ? fs.readdirSync(pp.live).filter(f=>!f.startsWith('.')) : [];
    res.json({
      ok: true,
      project: p.name,
      aaps_active: (p.aaps || []).filter(a => !a.revoked).length,
      aaps_total: (p.aaps || []).length,
      branches: branches.all,
      recent_commits: log.all.map(c => ({ hash: c.hash.slice(0,7), message: c.message, date: c.date })),
      live_files_count: liveFiles.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'stats_failed', detail: e.message });
  }
});

app.post('/drafts/aaps', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const aap = {
    id: newId(),
    token: newToken('aap'),
    name: (req.body.name || '').toString().slice(0, 60) || null,
    created_at: now(),
    revoked: false,
    branch: '', // set below
  };
  aap.branch = `aap/${aap.id}`;
  p.aaps = p.aaps || [];
  p.aaps.push(aap);
  saveState();

  const activationUrl = `${PUBLIC_BASE}/a/${aap.token}`;
  res.json({
    ok: true,
    aap: { id: aap.id, name: aap.name, branch: aap.branch, created_at: aap.created_at },
    activation_url: activationUrl,
    email_draft_hint: {
      subject: `You're invited to the "${p.name}" drafts project`,
      body: `Hey,\n\nI've set up a drafts workspace for "${p.name}" and added you as a contributor.\n\nYour link (it's your key — keep it to yourself):\n${activationUrl}\n\nHow to use it:\n- Open Google Chrome, install Claude for Chrome if you don't have it: ${CHROME_EXT_URL}\n- Paste the link into the Claude side panel\n- Tell Claude what to build — it handles the code, versioning, everything.\n\nChanges you make land in your own branch. I review and publish. No dashboards, no terminals. Just chat.\n\nCheers,\n`
    },
  });
});

app.get('/drafts/aaps', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  const branches = (await git.branch()).all;
  const aaps = await Promise.all((p.aaps || []).map(async (a) => {
    const br = `aap/${a.id}`;
    let pending = 0;
    if (branches.includes(br)) {
      try {
        const log = await git.log({ from: 'main', to: br });
        pending = log.total;
      } catch (e) {}
    }
    return {
      id: a.id,
      name: a.name,
      branch: br,
      revoked: a.revoked,
      created_at: a.created_at,
      activation_url: `${PUBLIC_BASE}/a/${a.token}`,
      pending_commits: pending,
    };
  }));
  res.json({ ok: true, project: p.name, aaps });
});

app.delete('/drafts/aaps/:id', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const a = (p.aaps || []).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: 'not_found' });
  a.revoked = true;
  saveState();
  res.json({ ok: true, revoked: a.id });
});

app.get('/drafts/pending', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  const branches = (await git.branch()).all.filter(b => b.startsWith('aap/'));
  const result = [];
  for (const br of branches) {
    const aapId = br.slice(4);
    const aap = (p.aaps || []).find(x => x.id === aapId);
    if (!aap || aap.revoked) continue;
    try {
      const log = await git.log({ from: 'main', to: br });
      if (log.total === 0) continue;
      result.push({
        aap_id: aap.id,
        aap_name: aap.name,
        branch: br,
        commits: log.all.slice(0, 20).map(c => ({ hash: c.hash.slice(0,7), message: c.message, date: c.date })),
        total_pending: log.total,
      });
    } catch (e) {}
  }
  res.json({ ok: true, project: p.name, pending: result });
});

app.post('/drafts/merge', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const aapId = req.body.aap_id;
  if (!aapId) return res.status(400).json({ ok: false, error: 'aap_id_required' });
  const aap = (p.aaps || []).find(x => x.id === aapId);
  if (!aap) return res.status(404).json({ ok: false, error: 'aap_not_found' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  try {
    await git.checkout('main');
    await git.merge([`aap/${aap.id}`, '--no-ff', '-m', `merge aap/${aap.name || aap.id}`]);
    res.json({ ok: true, merged: aap.id, branch: `aap/${aap.id}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'merge_failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Shared: upload / commit / files / history / promote / rollback
// ─────────────────────────────────────────────────────────────

app.post('/drafts/upload', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const filename = String(req.body.filename || '').replace(/^\/+/, '').replace(/\.\./g, '');
  if (!filename) return res.status(400).json({ ok: false, error: 'filename_required' });
  const where = req.body.where === 'live' && req.tier !== 'aap' ? 'live' : 'drafts';
  const pp = await ensureProjectDirs(p.name);
  const root = where === 'live' ? pp.live : pp.drafts;

  // If AAP — switch to own branch first
  if (req.tier === 'aap') {
    const git = simpleGit(pp.drafts);
    await switchToBranch(git, req.aap.branch);
  } else {
    const git = simpleGit(pp.drafts);
    await switchToBranch(git, 'main');
  }

  const full = path.join(root, filename);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, req.body.content || '');
  res.json({ ok: true, path: filename, where, branch: req.tier === 'aap' ? req.aap.branch : (where === 'drafts' ? 'main' : null) });
});

app.post('/drafts/commit', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  const branch = req.tier === 'aap' ? req.aap.branch : 'main';
  await switchToBranch(git, branch);
  await git.add('.');
  try {
    const msg = (req.body.message || 'update').toString().slice(0, 200);
    const out = await git.commit(msg);
    res.json({ ok: true, branch, commit: out.commit, summary: out.summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'commit_failed', detail: e.message });
  }
});

app.get('/drafts/files', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const where = req.query.where === 'live' ? 'live' : 'drafts';
  const pp = await ensureProjectDirs(p.name);
  const root = where === 'live' ? pp.live : pp.drafts;

  // If drafts and AAP — switch to their branch first so filesystem reflects their work
  if (where === 'drafts' && req.tier === 'aap') {
    const git = simpleGit(pp.drafts);
    try { await switchToBranch(git, req.aap.branch); } catch(e) {}
  }

  const walk = (dir, base='') => {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = path.posix.join(base, entry.name);
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(abs, rel));
      } else {
        const st = fs.statSync(abs);
        out.push({ name: rel, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
    return out;
  };
  res.json({ ok: true, where, files: walk(root) });
});

app.get('/drafts/file', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const where = req.query.where === 'live' ? 'live' : 'drafts';
  const relPath = String(req.query.path || '').replace(/^\/+/, '').replace(/\.\./g, '');
  const pp = await ensureProjectDirs(p.name);

  if (where === 'drafts' && req.tier === 'aap') {
    const git = simpleGit(pp.drafts);
    try { await switchToBranch(git, req.aap.branch); } catch(e) {}
  }

  const full = path.join(where === 'live' ? pp.live : pp.drafts, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).json({ ok: false, error: 'not_found' });
  const content = fs.readFileSync(full, 'utf8');
  res.json({ ok: true, path: relPath, where, content });
});

app.delete('/drafts/file', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const where = req.query.where === 'live' && req.tier !== 'aap' ? 'live' : 'drafts';
  const relPath = String(req.query.path || '').replace(/^\/+/, '').replace(/\.\./g, '');
  const pp = await ensureProjectDirs(p.name);

  if (req.tier === 'aap') {
    const git = simpleGit(pp.drafts);
    await switchToBranch(git, req.aap.branch);
  } else {
    const git = simpleGit(pp.drafts);
    await switchToBranch(git, 'main');
  }

  const full = path.join(where === 'live' ? pp.live : pp.drafts, relPath);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'not_found' });
  fs.unlinkSync(full);
  res.json({ ok: true, deleted: relPath });
});

app.get('/drafts/history', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  const branch = req.tier === 'aap' ? req.aap.branch : 'main';
  try { await switchToBranch(git, branch); } catch(e) {}
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const log = await git.log({ maxCount: limit });
  res.json({ ok: true, branch, commits: log.all.map(c => ({ hash: c.hash.slice(0,7), full: c.hash, date: c.date, message: c.message })) });
});

app.post('/drafts/promote', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  try {
    await switchToBranch(git, 'main');
    // Atomic copy: stage in .live.tmp, rename live -> .live.old, rename .live.tmp -> live, rm .live.old
    const tmp = pp.live + '.tmp';
    const old = pp.live + '.old';
    try { execSync(`rm -rf "${tmp}" "${old}"`); } catch (e) {}
    execSync(`cp -a "${pp.drafts}/" "${tmp}"`);
    // remove .git from the live copy
    try { execSync(`rm -rf "${tmp}/.git"`); } catch (e) {}
    try { execSync(`mv "${pp.live}" "${old}"`); } catch (e) {}
    execSync(`mv "${tmp}" "${pp.live}"`);
    try { execSync(`rm -rf "${old}"`); } catch (e) {}
    res.json({ ok: true, live_url: `${PUBLIC_BASE}/live/${p.name}/` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'promote_failed', detail: e.message });
  }
});

app.post('/drafts/rollback', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const commit = String(req.body.commit || '');
  if (!commit) return res.status(400).json({ ok: false, error: 'commit_required' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  try {
    await switchToBranch(git, 'main');
    await git.reset(['--hard', commit]);
    res.json({ ok: true, reset_to: commit });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'rollback_failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GitHub sync (PAP/SAP only)
// ─────────────────────────────────────────────────────────────

app.post('/drafts/github/sync', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  if (!p.github_repo) return res.status(400).json({ ok: false, error: 'project_not_linked_to_github' });
  if (!GITHUB_TOKEN || !GITHUB_USER) return res.status(500).json({ ok: false, error: 'github_not_configured' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  try {
    await switchToBranch(git, 'main');
    const remoteUrl = `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${p.github_repo}.git`;
    const remotes = await git.getRemotes();
    if (!remotes.find(r => r.name === 'origin')) {
      await git.addRemote('origin', remoteUrl);
    } else {
      await git.remote(['set-url', 'origin', remoteUrl]);
    }
    await git.push(['-u', 'origin', 'main', '--force']);
    // scrub token
    await git.remote(['set-url', 'origin', `https://github.com/${p.github_repo}.git`]);
    res.json({ ok: true, pushed_to: p.github_repo });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'github_sync_failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`drafts-receiver v2.0 listening on 127.0.0.1:${PORT}`);
  console.log(`SAP link: ${PUBLIC_BASE}/s/${SAP_TOKEN.slice(0,8)}...`);
});
