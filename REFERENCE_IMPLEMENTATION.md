# drafts reference server

This document describes the reference implementation of drafts/0.2, operated by [Labs](https://labs.vc) at [beta.labs.vc](https://beta.labs.vc/) as federation member `0`.

## Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 18+, Express 4 |
| HTTP / TLS | nginx 1.24, Let's Encrypt |
| Process manager | pm2 |
| Rate-limit state | In-memory sliding window (per-process) |
| Project registry | JSON file (`.state.json`) + per-project git repos |
| Static serving | nginx direct from `/var/www/html/live/` |
| Hosting | Hetzner LXC, Ubuntu 24.04, 8 GB RAM, 100 GB disk |

## Source files

| Path | Purpose |
|---|---|
| `drafts.js` | Express server: welcome routes, API, project/pass management |
| `rich-context.js` | Welcome-page renderer with inline SVG, capability cards, project state |
| `install.sh` | One-command Ubuntu installer (nginx + certbot + Node + pm2 + clone) |
| `drafts-registry.json` | Federation registry (canonical, served from GitHub raw) |

## Filesystem layout

```
/var/lib/drafts/                   # default for fresh installs
└── <project>/
    ├── drafts/                    # editable git working tree
    │   ├── .git/
    │   └── <files>
    └── live/                      # deployed public copy (symlinked from /var/www/html/live/<project>)

/etc/labs/
├── drafts.env                     # PUBLIC_BASE_URL, SERVER_NUMBER, etc.
└── drafts.sap                     # auto-minted SAP token (mode 0600)
```

The reference server uses a legacy `DRAFTS_DIR=/var/www/beta.labs.vc/drafts` for historical compatibility; new installs default to `/var/lib/drafts`.

## Project lifecycle

1. SAP holder issues `POST /drafts/projects` with a project name
2. drafts.js creates the working tree (empty `git init`) and mints a Project Pass (PAP)
3. Owner opens the welcome URL — Claude (or any capable agent) reads the machine JSON, writes files via API
4. Owner sends `POST /drafts/promote` (project context inferred from PAP) — `live/` is replaced atomically
5. Output is public at `https://beta.labs.vc/live/<project>/`

## GitHub sync (optional per project)

Configured via runtime API (no env vars needed):

- **Server default** (SAP only): `PUT /drafts/config/github` with `{user, token}`
- **Per-project override** (PAP or SAP): `PUT /drafts/projects/:name/config/github` with `{user, token}`

When `github_repo` is set on a project and a config is resolvable, `POST /drafts/github/sync` pushes `main` to the linked repo.

Projects with GitHub sync active on the reference server: `beta`, `zeus`, `wizrag`, `qoin`, `silence`, `drafts`.

## Divergences from the protocol

- **Per-IP limit** — recommended by SPEC § 4 but not currently enforced (in-memory per-token only)
- **HSTS** — `max-age=31536000; includeSubDomains; preload`
- **Rich welcome pages** — embeds project state (branches, recent commits, contributor count) in HTML alongside the normative machine JSON block

## Observability

Logs:
- Server stdout → `pm2 logs drafts`
- nginx access → `/var/log/nginx/access.log`
- nginx errors → `/var/log/nginx/error.log`

State files:
- `/var/lib/drafts/.state.json` (or legacy `/var/www/beta.labs.vc/drafts/.state.json`)
- `/etc/labs/drafts.sap`

## Contact

Operator: Eugene Gordeev / Labs
Abuse reports, server-pass issues: [GitHub Issues](https://github.com/g0rd33v/drafts-protocol/issues)
