# Labs Drafts

**Personal staging pipe between AI chats and the public web.**

One URL. Talk to Claude. It writes the code, commits it, publishes it, verifies the result, hands you the URL. No dashboards. No deploy steps. No terminal.

```
chat  →  drafts  →  live
```

— v0.2 · live on `beta.labs.vc`

---

## What is it

Labs Drafts is a small server that accepts file uploads from a Claude chat, versions every save with git, and publishes on command to a public URL. You talk to Claude. Claude talks to Drafts. Your page appears online.

Built for one person. Designed so the LLM is the primary user and the human supervises through conversation.

Read the full overview: [docs/overview-v0.2.md](docs/overview-v0.2.md).

## What works today (v0.2)

- Single-file HTML/CSS/JS — landings, mockups, prototypes, internal tools, dashboards.
- Media assets — images (PNG, JPG, SVG), audio (MP3), documents. Multi-file projects with relative links.
- Every save is a git commit. Rollback to any point with one phrase.
- Optional GitHub sync — link a project to a repo, push on demand.
- Multi-collaborator via scoped access keys (PAPs). Mint, send, revoke.
- Full management UI on the master page — create/delete projects, mint/revoke PAPs.
- Two entry points: [Claude for Chrome](https://chromewebstore.google.com/detail/claude-for-chrome/fmpnliohjhemenmnlpbfagaolkdacoja) extension, or paste the URL into Claude.ai / Claude Desktop.

## What is coming next

- Runtime for user backend code (Node/Python in sandboxed containers).
- Per-project databases (SQLite/Postgres).
- One-command VPS setup script.
- LLM routing inside projects via OpenRouter.
- Hosted drafts spaces for people without a server.

## Access model: MAP and PAP

Two kinds of access keys, both delivered as URLs.

**MAP — Master Access Pass.** One per server. Belongs to the owner. Creates projects, mints access keys, deletes anything.

**PAP — Project Access Pass.** Minted by the owner from MAP. Scoped to one project. Send the URL to a collaborator — they paste it into their own Claude chat.

Both URLs embed the auth token in the path. URL is the credential. If a URL leaks, revoke from master, mint a new one. The instruction page at each URL contains a human-readable overview plus a machine-readable JSON block that any LLM can parse.

## Architecture

Intentionally boring:

- **nginx** — static files, HTTPS termination, proxies `/drafts/*` to receiver.
- **Node.js receiver** (`app.js`) — Express + simple-git, ESM, port 3100.
- **Local git** — every project's `drafts/` folder is a repo.
- **Filesystem** — `<DRAFTS_DIR>/<project>/{drafts,live}/`. Atomic swap on promote.
- **Let's Encrypt** — certificate.
- **PM2** — process manager.

No container orchestration, no message queues, no managed DB. Runs on a 1-vCPU, 2GB-RAM box.

## Folder shape

Every project is the same:

```
<DRAFTS_DIR>/<project>/
├── drafts/    # work in progress, every save commits to git
└── live/      # published, atomic copy from drafts
```

`/live/<project>/` renders as a static site. If `index.html` is present, the folder URL shows the website. Otherwise — file listing.

## API

All endpoints require `Authorization: Bearer <token>` header. Token is either the MAP or a valid PAP for the project.

### MAP-only

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/whoami` | — | verify role + token |
| GET | `/projects` | — | list all projects |
| POST | `/projects` | `{name, description?, github_repo?}` | create project (auto-creates /live/ symlink) |
| DELETE | `/projects/:name` | — | wipe project entirely |
| POST | `/projects/:name/keys` | `{name?}` | mint PAP, returns `activation_url` |
| GET | `/projects/:name/keys` | — | list all PAPs for project |
| DELETE | `/projects/:name/keys/:id` | — | revoke a PAP |

### PAP (and MAP)

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/project/info` | — | metadata + folder paths |
| POST | `/upload` | `{filename, content, where?:"drafts"\|"live"}` | write file (default `drafts`) |
| GET | `/files?where=drafts\|live` | — | list files |
| GET | `/file?path=...&where=drafts\|live` | — | read file content |
| DELETE | `/file?path=...&where=drafts\|live` | — | delete file |
| POST | `/commit` | `{message?}` | snapshot drafts/ into git |
| POST | `/promote` | `{message?}` | atomic drafts → live, publish |
| GET | `/history?limit=50` | — | commit log |
| POST | `/rollback` | `{commit}` | restore drafts to past commit |
| POST | `/github/sync` | `{branch?, message?}` | push to linked GitHub repo |

## Installation

> One-command setup script is on the roadmap. Until then, manual steps.

1. **Provision a Linux server.** Ubuntu 24.04 recommended. 1 vCPU, 2GB RAM is enough. Point a domain at it.
2. **Install nginx, Node.js 18+, git, certbot.**
3. **Clone this repo** into `/opt/drafts-receiver/`.
4. **Copy `.env.example` to `.env`.** Generate a master token with `openssl rand -hex 32` and put it in `BEARER_TOKEN`. Fill in `DRAFTS_DIR`, `PUBLIC_BASE_URL`.
5. **`npm install`.**
6. **Configure nginx** to proxy `/drafts/` to `localhost:3100` and serve `/live/` and `/drafts-view/` from the drafts directory via autoindex. (Full nginx config coming in the setup script.)
7. **Copy static files** — `static/drafts-launch.js` and `static/drafts-manage.js` go to nginx's html root.
8. **Run the receiver** under pm2: `pm2 start app.js --name drafts-receiver`.
9. **Get your MAP URL** — `https://your-domain/m/<BEARER_TOKEN>`. Paste it into any Claude chat.

## Security model

- **URL = credential.** The token is in the path. Anyone with the URL can act. Treat URLs like API keys.
- **Revocable.** If a PAP leaks, delete it from the MAP management UI. The URL stops working immediately.
- **Isolated.** PAPs are scoped to one project. They cannot read or write other projects.
- **No accounts, no registration.** The system is owned end-to-end by one person.
- **Not for production.** For prototypes, internal tools, demos. No audit log, no 2FA, no RBAC.

## What it is not

- Not production hosting. If a project graduates to a real product, move it.
- Not multi-tenant. One owner per server.
- Not a publishing platform. No discovery, no SEO, no aggregated index.
- Not a website builder. The interface is a chat. Say what to change.

## License

MIT. See [LICENSE](LICENSE).

## The bet underneath

The most useful tools of the next few years will be the ones that assume an LLM is in the loop and design every interface accordingly. Not LLM features bolted onto existing tools — tools where the LLM is the primary user and the human supervises through conversation.

Drafts is one experiment in that direction.

---

*Labs Drafts · v0.2 · by [Labs](https://labs.vc)*
