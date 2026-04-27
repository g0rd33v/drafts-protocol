// rich-context.js — Welcome page enrichment
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ICONS = {
  // Capabilities
  storage:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/></svg>',
  runtime:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  llm:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg>',
  git:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>',
  cdn:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  media:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  database:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>',
  backend:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  auth:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  // Features
  landing:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
  pwa:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
  form:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
  aitool:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 15 8 22 9 17 14 18 21 12 18 6 21 7 14 2 9 9 8 12 2"/></svg>',
  widget:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  gallery:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  publish:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
  invite:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
  // How-to
  chrome:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" y1="8" x2="12" y2="8"/><line x1="3.95" y1="6.06" x2="8.54" y2="14"/><line x1="10.88" y1="21.94" x2="15.46" y2="14"/></svg>',
  chat:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
};

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(2) + ' MB';
}

function buildCapabilities() {
  const now = [
    { icon: 'landing', t: 'Static HTML/CSS/JS', d: 'Single-file pages, fast, adaptive, mobile-ready' },
    { icon: 'media',   t: 'Media assets',       d: 'Upload images, audio — rendered inline' },
    { icon: 'git',     t: 'Git versioning',     d: 'Every commit tracked. Rollback with one sentence' },
    { icon: 'cdn',     t: 'Public URLs + SSL',  d: 'beta.labs.vc/&lt;project&gt; — HTTPS, auto-issued' },
    { icon: 'llm',     t: 'Client-side LLM',    d: 'You bring Claude. Any plan. Free works' },
    { icon: 'runtime', t: 'Node 18 build zone', d: 'Modern JS libs from CDN: React, D3, Tailwind' },
  ];
  const soon = [
    { icon: 'database', t: 'Databases',           d: 'SQL + vector storage per project' },
    { icon: 'backend',  t: 'Backend runtime',    d: 'Your server code on managed infra' },
    { icon: 'auth',     t: 'Auth out of the box', d: 'Users, sessions, OAuth' },
  ];
  const cap = (c, cls='') => '<div class="cap ' + cls + '">' + ICONS[c.icon] + '<div><div class="t">' + c.t + '</div><div class="d">' + c.d + '</div></div></div>';
  return '<div class="caps">' + now.map(c=>cap(c,'')).join('') + soon.map(c=>cap(c,'soon')).join('') + '</div>';
}

function buildFeatures() {
  const feats = [
    { icon: 'landing', t: 'Landing pages',        d: 'Hero, copy, CTAs, gallery, testimonials' },
    { icon: 'pwa',     t: 'Progressive web apps', d: 'Installable, offline-capable, mobile-first' },
    { icon: 'form',    t: 'Forms that capture',   d: 'Contact, signup, survey. Email delivery via Claude' },
    { icon: 'aitool',  t: 'AI-powered tools',     d: 'Generators, analyzers, chat widgets using Claude API' },
    { icon: 'widget',  t: 'Interactive widgets',  d: 'Calculators, dashboards, mini-games, toys' },
    { icon: 'gallery', t: 'Multi-page sites',     d: 'Blogs, docs, portfolios, product catalogs' },
    { icon: 'publish', t: 'Publish & rollback',   d: 'Promote draft to live. Revert in one breath' },
    { icon: 'invite',  t: 'Invite contributors',  d: 'Unlimited collaborators. Each gets own branch' },
  ];
  const feat = f => '<div class="feat">' + ICONS[f.icon] + '<div><div class="t">' + f.t + '</div><div class="d">' + f.d + '</div></div></div>';
  return '<div class="features">' + feats.map(feat).join('') + '</div>';
}

function buildHowto() {
  return '<div class="howto">' +
    '<div class="way">' + ICONS.chrome +
      '<div><div class="t">Claude for Chrome<span class="tag">recommended</span></div>' +
      '<div class="d">Install the <a href="https://chromewebstore.google.com/detail/claude-for-chrome/fmpnliohjhemenmnlpbfagaolkdacoja" target="_blank" rel="noopener">Chrome extension</a>, then paste this URL in the side panel. Claude reads the page and starts building.</div></div></div>' +
    '<div class="way">' + ICONS.chat +
      '<div><div class="t">Any Claude chat<span class="tag">fallback</span></div>' +
      '<div class="d">Works in claude.ai web, Desktop, or any client. Just paste the URL and talk.</div></div></div>' +
    '</div>';
}

async function readProjectState(project, projectsDir) {
  if (!project) return null;
  const projDir = path.join(projectsDir, project.name);
  const liveDir = path.join(projDir, 'live');
  const draftsDir = path.join(projDir, 'drafts');

  const result = {
    name: project.name,
    description: project.description,
    github_repo: project.github_repo,
    live_files: [],
    live_total_size: 0,
    commits: [],
    live_commit: null,
    active_aaps: (project.aaps || []).filter(a => !a.revoked).length,
    created_at: project.created_at,
  };

  try {
    const files = await fs.readdir(liveDir);
    for (const f of files) {
      if (f.startsWith('.')) continue;
      const stat = await fs.stat(path.join(liveDir, f));
      if (stat.isFile()) {
        result.live_files.push({ name: f, size: stat.size });
        result.live_total_size += stat.size;
      }
    }
  } catch (e) {}

  try {
    const log = execSync('git -C ' + JSON.stringify(draftsDir) + ' log --pretty=format:"%h|%s|%ai" -n 5 2>/dev/null', { encoding: 'utf8' });
    result.commits = log.split('\n').filter(Boolean).map(line => {
      const [hash, msg, date] = line.split('|');
      return { hash, msg, date };
    });
    try {
      const liveLog = execSync('git -C ' + JSON.stringify(draftsDir) + ' log --pretty=format:"%h|%s|%ai" -n 1 --grep=promote 2>/dev/null', { encoding: 'utf8' });
      if (liveLog.trim()) {
        const [hash, msg, date] = liveLog.split('|');
        result.live_commit = { hash, msg, date };
      }
    } catch (e) {}
  } catch (e) {}

  return result;
}

const RICH_CSS = "<style>   /* Rich context sections */   .rich { margin: 28px 0; display: flex; flex-direction: column; gap: 20px; }   .rich-section { background: #0c0c0c; border: 1px solid rgba(255,255,255,0.07); border-radius: 14px; padding: 20px 22px; }   .rich-section h3 { font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #6a6a6a; margin: 0 0 14px 0; }   .rich-section h3 .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #4ade80; margin-right: 8px; vertical-align: middle; }   .rich-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 14px 0 18px 0; }   .rich-header .name { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; color: #f5f5f5; }   .rich-header .btn-quick { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 7px; font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,0.11); background: #111; color: #a8a8a8; text-decoration: none; }   .rich-header .btn-quick:hover { border-color: rgba(255,255,255,0.22); color: #f5f5f5; }   .rich-header .btn-quick.live { border-color: rgba(74,222,128,0.3); color: #4ade80; }   .rich-header .btn-quick.ghost { color: #6a6a6a; cursor: default; }   .caps { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }   @media(max-width: 560px) { .caps { grid-template-columns: 1fr; } }   .cap { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; padding: 12px 14px; display: flex; gap: 12px; align-items: flex-start; }   .cap svg { flex-shrink: 0; width: 20px; height: 20px; color: #ea5a2e; margin-top: 1px; }   .cap .t { font-size: 13px; font-weight: 600; color: #f5f5f5; letter-spacing: -0.005em; }   .cap .d { font-size: 12px; color: #a8a8a8; line-height: 1.5; margin-top: 2px; }   .cap.soon svg { color: #6a6a6a; }   .cap.soon .t { color: #a8a8a8; }   .cap.soon .d { color: #6a6a6a; }   .cap.soon::after { content: \"soon\"; font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6a6a6a; margin-left: auto; padding: 2px 6px; border: 1px solid rgba(255,255,255,0.07); border-radius: 4px; align-self: flex-start; }   .features { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }   @media(max-width: 560px) { .features { grid-template-columns: 1fr; } }   .feat { background: #0c0c0c; border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; padding: 14px 16px; display: flex; gap: 12px; align-items: flex-start; }   .feat svg { flex-shrink: 0; width: 22px; height: 22px; color: #ea5a2e; margin-top: 1px; }   .feat .t { font-size: 13.5px; font-weight: 700; color: #f5f5f5; letter-spacing: -0.005em; }   .feat .d { font-size: 12.5px; color: #a8a8a8; line-height: 1.5; margin-top: 3px; }   .state-row { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }   .state-row:last-child { border-bottom: none; }   .state-row .k { color: #6a6a6a; font-size: 11.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }   .state-row .v { color: #f5f5f5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; text-align: right; word-break: break-all; }   .state-row .v.muted { color: #6a6a6a; }   .commits { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }   .commits .commit { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }   .commits .commit:last-child { border-bottom: none; }   .commits .hash { font-family: ui-monospace, Menlo, monospace; color: #ea5a2e; font-size: 11px; flex-shrink: 0; padding-top: 1px; }   .commits .msg { color: #f5f5f5; flex: 1; line-height: 1.5; }   .commits .date { color: #6a6a6a; font-size: 11px; flex-shrink: 0; padding-top: 1px; white-space: nowrap; }   .files-list { display: flex; flex-direction: column; gap: 4px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }   .files-list .file { display: flex; gap: 12px; padding: 4px 0; }   .files-list .file .name { color: #f5f5f5; flex: 1; }   .files-list .file .size { color: #6a6a6a; flex-shrink: 0; }   .howto { display: flex; flex-direction: column; gap: 12px; }   .howto .way { display: flex; gap: 14px; align-items: flex-start; padding: 12px 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; }   .howto .way svg { flex-shrink: 0; width: 22px; height: 22px; color: #ea5a2e; margin-top: 1px; }   .howto .way .t { font-size: 13.5px; font-weight: 700; color: #f5f5f5; }   .howto .way .t .tag { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #ea5a2e; border: 1px solid #ea5a2e; padding: 1px 5px; border-radius: 3px; margin-left: 6px; vertical-align: 2px; }   .howto .way .d { font-size: 12.5px; color: #a8a8a8; line-height: 1.5; margin-top: 3px; }   .howto .way .d a { color: #60a5fa; } </style>";

export function buildRichContext({ tier, token, project, projectsDir, publicBase }) {
  const isSAP = tier === 'SAP';
  const isPAP = tier === 'PAP';
  const isAAP = tier === 'AAP';

  // Project header (only for PAP/AAP)
  let projHeader = '';
  if (project) {
    const liveUrl = publicBase + '/' + project.name + '/';
    const repoBtn = project.github_repo
      ? '<a class="btn-quick" href="https://github.com/' + esc(project.github_repo) + '" target="_blank" rel="noopener">Repository ↗</a>'
      : '<span class="btn-quick ghost" title="Not linked yet. Ask Claude to link a GitHub repo">Repository (unlinked)</span>';
    projHeader =
      '<div class="rich-header">' +
        '<span class="name">' + esc(project.name) + '</span>' +
        '<a class="btn-quick live" href="' + liveUrl + '" target="_blank" rel="noopener">Live ↗</a>' +
        repoBtn +
      '</div>';
  }

  // Capabilities
  const caps =
    '<div class="rich-section">' +
      '<h3><span class="dot"></span>Available capabilities on this server</h3>' +
      buildCapabilities() +
    '</div>';

  // Features
  const feats =
    '<div class="rich-section">' +
      '<h3>What you can build here</h3>' +
      buildFeatures() +
    '</div>';

  // How to interact
  const howto =
    '<div class="rich-section">' +
      '<h3>How to talk to this link</h3>' +
      buildHowto() +
    '</div>';

  // Current state placeholder — filled lazily by client-side JS
  let state = '';
  if (project) {
    state =
      '<div class="rich-section" id="projectState">' +
        '<h3>Current state</h3>' +
        '<div id="projectStateContent" style="color:#6a6a6a;font-size:13px;padding:8px 0">loading live files and recent commits...</div>' +
      '</div>';
  }

  return RICH_CSS + '<div class="rich">' + projHeader + caps + feats + howto + state + '</div>';
}

export { readProjectState };
