# drafts

> **The publishing protocol for AI-generated artifacts.**
> One URL. Any agent. Public the moment it exists.

[![Protocol](https://img.shields.io/badge/protocol-drafts%2F0.1-blue)](docs/SPEC.md)
[![Reference server](https://img.shields.io/badge/reference-beta.labs.vc-brightgreen)](https://beta.labs.vc/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

**drafts** is an open protocol for publishing small digital artifacts — static pages, PWAs, AI-powered apps — to public URLs using nothing but a portable access token. No accounts. No credit cards. No framework lock-in.

```
drafts_server_0_91e52304063d5440     full server control
drafts_project_0_a30aca1fe85b        project owner
drafts_agent_0_b7fabf75b3            contributor, isolated branch
```

Any capability that can issue three HTTP requests can publish.

---

## Why it exists

AI agents produce outputs that want to live at a URL — a research deliverable, a daily-updating dashboard, a curated list, an interactive explainer. Today those outputs either get trapped inside a chat session or require the agent to complete a developer-targeted deploy flow (Vercel, Netlify, GitHub Pages) built for humans with billing credentials.

drafts removes every decision the agent shouldn't have to make. The token is the identity. The identity is stateless. The output is immediately public.

**Design target:** a quantized 7B-parameter model on a local GPU can publish to drafts with three HTTP requests and no error recovery.

---

## Specification

| Document | Purpose |
|---|---|
| [PROTOCOL.md](docs/PROTOCOL.md) | Protocol overview |
| [SPEC.md](docs/SPEC.md) | Formal specification (URL grammar, HTTP contract, tier semantics, registry model, security) |
| [REGISTRY.md](docs/REGISTRY.md) | How to register your own drafts server |
| [INSTALL.md](docs/INSTALL.md) | Run a conformant server |

Protocol version: **drafts/0.1** — experimental. Breaking changes possible before 1.0.

---

## Reference implementation

This repository contains the reference drafts server, operated by [Labs](https://labs.vc) as federation member `0` at:

**https://beta.labs.vc/**

Stack: Node.js 18+ (Express 4), nginx 1.24 (TLS via Let's Encrypt), Redis (rate-limit state), SQLite + per-project git repos (project registry).

See [REFERENCE_IMPLEMENTATION.md](REFERENCE_IMPLEMENTATION.md) for operational detail.

---

## Quick start

### Use the reference server

Ask the operator of beta.labs.vc for a Project Pass. Paste its welcome URL into Claude for Chrome. Tell Claude what to build.

### Run your own

```bash
git clone https://github.com/g0rd33v/drafts-protocol.git
cd drafts-protocol
npm install
cp .env.example .env
# edit .env: set BEARER_TOKEN (16-hex), PUBLIC_BASE, paths
node app.js
```

Register with the federation by opening a pull request adding your server entry to [`registry.json`](registry.json). See [REGISTRY.md](docs/REGISTRY.md).

---

## Minimal publishing flow

Three HTTP calls.

```
1. GET  https://<host>/drafts/pass/<portable_token>
   (parse machine JSON, read endpoints)

2. PUT  https://<host>/drafts/api/files/<project>/<path>
   Authorization: Bearer <secret>
   Body: <file content>

3. POST https://<host>/drafts/api/promote/<project>
   Authorization: Bearer <secret>
```

Output is now public at `https://<host>/live/<project>/<path>`.

---

## Status

| Capability | 0.1 |
|---|---|
| Static HTML, CSS, JS, media | ✓ |
| Per-project git with rollback | ✓ |
| Multi-contributor branch isolation | ✓ |
| HTTPS with Let's Encrypt | ✓ |
| Rate limits per tier | ✓ |
| GitHub mirror (optional) | ✓ |
| Public federation registry | ✓ |

### Roadmap

- **v1.1** — per-project SQL + vector storage
- **v2** — backend runtime, auth primitives, multi-LLM routing via OpenRouter
- **Research** — capability-bundled passes (GPU, video-gen, RAG)

---

## Community

- **Discussion & proposals** — [GitHub Issues](https://github.com/g0rd33v/drafts-protocol/issues)
- **Operator contact** — eugene@labs.vc
- **Changelog** — [CHANGELOG.md](CHANGELOG.md)

---

## License

[MIT](LICENSE). Contributions require agreement to the [Code of Conduct](CODE_OF_CONDUCT.md).
