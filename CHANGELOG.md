# Changelog

All notable changes to the drafts protocol and reference implementation.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Protocol

- Expanded formal specification with RFC 2119 conformance language
- Security considerations section with explicit threat model
- Registry schema formalized
- Federation process documented in REGISTRY.md

### Reference implementation

- Rich welcome pages with embedded project state
- Shortened token lengths: server 16-hex (64-bit), project 12-hex (48-bit), agent 10-hex (40-bit)
- Canonical welcome URL `/drafts/pass/<token>`
- Self-describing portable tokens `drafts_<tier>_<server>_<secret>`
- Bidirectional GitHub mirror (post-commit push + cron pull-back)
- Three-tier access model: server, project, agent

## [0.1] — 2026-04-24

Initial experimental release.

### Protocol

- Three-tier access model
- Portable token format
- Canonical welcome URL namespace
- Minimal HTTP API (create project, write file, promote)
- Federated registry with integer server IDs
- Machine-readable JSON embedded in welcome pages

### Reference implementation

- Node.js / Express receiver
- nginx reverse proxy with Let's Encrypt TLS
- Redis rate limiting per token
- Per-project git history with atomic promote
- Optional GitHub mirror sync
