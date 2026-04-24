# drafts reference server

This document describes the reference implementation of drafts/0.1, operated by [Labs](https://labs.vc) at [beta.labs.vc](https://beta.labs.vc/) as federation member `0`.

## Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 18, Express 4 |
| HTTP / TLS | nginx 1.24, Let's Encrypt |
| Rate-limit state | Redis 7 |
| Project registry | JSON file (`.state.json`) + per-project git repos |
| Static serving | nginx direct from `/var/www/html/live/` |
| Hosting | Hetzner LXC, Ubuntu 24.04, 8 GB RAM, 100 GB disk |

## Source files

| Path | Purpose |
|---|---|
| `app.js` | Express receiver: welcome routes, API, project/pass management |
| `rich-context.js` | Welcome-page renderer with inline SVG, capability cards, project state |
| `deploy/nginx.conf` | Reference nginx configuration |
| `deploy/bin/labs-sync` | Per-project drafts → live sync |
| `deploy/bin/labs-github-sync` | GitHub pull-back cron (every 5 min) |
| `deploy/bin/labs-drafts-refresh` | Directory/repo metadata refresh |
| `deploy/bin/labs-status-collect` | Health metrics |

## Filesystem layout

```
/var/www/beta.labs.vc/drafts/
├── .state.json                    # project registry
└── <project>/
    ├── drafts/                    # editable git working tree
    │   ├── .git/
    │   └── <files>
    └── live/                      # deployed public copy (symlinked from /var/www/html/live/<project>)
```

## Project lifecycle

1. Server-pass holder issues `POST /drafts/projects` with a project name
2. Reference server creates the working tree (empty `git init`) and mints a Project Pass
3. Owner opens the welcome URL — Claude (or any capable agent) reads the machine JSON, writes files via API
4. Owner sends `POST /drafts/api/promote/<project>` — `live/` is replaced atomically
5. Output is public at `https://beta.labs.vc/live/<project>/`

## GitHub sync (optional per project)

If `github_repo` is set on a project:
- Post-commit hook in `drafts/` pushes to GitHub asynchronously (~5-10 s)
- `labs-github-sync` cron pulls remote changes every 5 minutes
- Remote changes trigger automatic redeploy to `live/`

Projects with GitHub sync active on the reference server: `beta`, `zeus`, `wizrag`, `qoin`, `silence`, `drafts`.

## Divergences from the protocol

The reference implementation is strictly conformant with [SPEC.md](docs/SPEC.md) for the three required operations. Additional operator-level choices:

- **Per-IP limit** — 100/day beyond per-token minimums (recommended by SPEC § 4 but not mandated)
- **HSTS** — `max-age=31536000; includeSubDomains; preload`
- **Rich welcome pages** — embeds project state (branches, recent commits, contributor count) in HTML alongside the normative machine JSON block

Optional operations not yet exposed as HTTP endpoints (list files, diff, rollback) are available via chat-through-Claude on the welcome page.

## Observability

Logs:
- Receiver stdout → `journalctl -u drafts-receiver`
- GitHub autopush → `journalctl -t drafts-autopush-<project>`
- Cron pull-back → `/var/log/drafts-github-sync.log`
- nginx access → `/var/log/nginx/access.log`

## Contact

Operator: Eugene Gordeev / Labs
Abuse reports, server-pass issues: [GitHub Issues](https://github.com/g0rd33v/drafts-protocol/issues)
