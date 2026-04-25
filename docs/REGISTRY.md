# Registry

The drafts protocol uses a federated registry. Each server in the federation has a unique non-negative integer identifier. The registry is hosted as a single JSON file in this repository — there is no DNS, no central API, no consensus protocol. Joining is a pull request.

## Current registry

- Browse: [`drafts-registry.json`](../drafts-registry.json)
- Raw: [https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/drafts-registry.json](https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/drafts-registry.json)

## Server numbers

Server `0` is the canonical reference server operated by Labs at `beta.labs.vc` **and** the default for any local/unregistered install. Every fresh install starts as server `0` and works fine that way — tokens are scoped to the issuing host, so there is no collision. Numbers `1, 2, 3, …` are assigned first-come via PR. Once assigned, a number is never reassigned, even if the server shuts down.

You only need a public server number if you want third-party tooling, registries, or other drafts servers to recognize your tokens by their `_<n>_` segment without having seen your host first. For most internal or single-tenant uses, staying on `0` is fine.

## How to join

1. **Run a conformant drafts/0.2 server.** See [INSTALL.md](INSTALL.md) for setup. The one-command installer is the fastest route.

2. **Fork this repository.**

3. **Edit [`drafts-registry.json`](../drafts-registry.json)** adding your entry under the next available integer key. Do NOT overwrite existing entries. Do NOT claim `0` — it is reserved for the Labs reference server and for unregistered local installs.

4. **Include:**
   - `host` — your domain
   - `operator` — individual or organization running it
   - `status` — `"active"`
   - `description` — short human-readable description
   - `endpoints` — `base`, `api`, `welcome_canonical` URLs

5. **Open a pull request.** A maintainer verifies:
   - Your server responds at `<base>/drafts/health` with `{"ok":true,"protocol":"drafts","version":"0.2"}`
   - Welcome page renders at `<base>/drafts/pass/<token>` with embedded machine JSON
   - Token format and rate limits conform to [SPEC.md §1, §4](SPEC.md)

6. **After merge:** edit `/etc/labs/drafts.env` on your server, set `SERVER_NUMBER=<your_assigned_number>`, restart with `pm2 restart drafts`. Existing tokens stay valid (they are matched by hex, not number); new tokens mint with the new number.

## Removing a server

Open a PR setting `"status": "deprecated"` on your entry. After 90 days, deprecated entries may be removed. The number remains permanently retired.

## PR template

Add to `servers` in `drafts-registry.json`:

```json
"<your_number>": {
  "host": "<your-host.example.com>",
  "operator": "<Your name or organization>",
  "status": "active",
  "description": "<one sentence — what makes your server distinct>",
  "endpoints": {
    "base": "https://<your-host>",
    "api": "https://<your-host>/drafts/",
    "welcome_canonical": "https://<your-host>/drafts/pass/<token>"
  }
}
```

## Canonical reference server

Server `0` is operated by Labs at `beta.labs.vc`. It serves as:

- Reference implementation (this repository's `drafts.js`)
- Test harness for conformance checks
- The default identity for any unregistered local install

Note: registry PRs merge against this repository, but the registry itself is not served by `beta.labs.vc` or any individual drafts server. There is exactly one source of truth, and it is the file in `main` of this repository.

Questions: [GitHub Issues](https://github.com/g0rd33v/drafts-protocol/issues).
