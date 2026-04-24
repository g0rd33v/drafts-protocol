# Registry

The drafts protocol uses a federated registry. Each server in the federation has a unique non-negative integer identifier.

## Current registry

[`https://beta.labs.vc/drafts/registry.json`](https://beta.labs.vc/drafts/registry.json)

## How to join

1. **Run a conformant drafts/0.1 server.** See [INSTALL.md](INSTALL.md) for setup and [SPEC.md § 9 — Conformance](SPEC.md) for requirements.

2. **Serve your own registry snapshot.** `GET <your_base>/drafts/registry.json` MUST return your server's entry (and SHOULD mirror the full federation).

3. **Fork this repository.**

4. **Edit [`registry.json`](../registry.json)** adding your entry under the next available integer key. Do NOT overwrite existing entries. Do NOT claim `0` — it is reserved for the Labs reference server.

5. **Include:**
   - `name` — human-readable server name
   - `operator` — individual or organization running it
   - `base_url` — https only
   - `contact` — email or URL for abuse reports
   - `status` — `"active"`

6. **Open a pull request.** A maintainer verifies:
   - Your server responds at `<base_url>/drafts/registry.json`
   - Your entry matches the canonical schema in [SPEC.md § 6](SPEC.md)
   - Basic conformance: welcome page renders, machine JSON parses, rate limits present

## Removing a server

Open a PR setting `"status": "deprecated"` on your entry. After 90 days, deprecated entries may be removed.

## PR template

```json
"<your_number>": {
  "name": "<Your Server Name>",
  "operator": "<Your name or org>",
  "base_url": "https://<your host>",
  "contact": "<email or https url>",
  "status": "active",
  "endpoints": {
    "welcome": "https://<your host>/drafts/pass/<token>",
    "api": "https://<your host>/drafts/api",
    "registry": "https://<your host>/drafts/registry.json"
  },
  "token_format": {
    "server_hex_length": 16,
    "project_hex_length": 12,
    "agent_hex_length": 10
  }
}
```

## Canonical reference server

Server `0` is operated by Labs at `beta.labs.vc`. It serves as:

- Registry authority (PRs merge here)
- Reference implementation (this repository)
- Test harness for conformance checks

Questions about the registry: [GitHub Issues](https://github.com/g0rd33v/drafts-protocol/issues).
