# drafts/0.1 — Formal Specification

**Status:** Experimental
**Editor:** Labs (eugene@labs.vc)
**Feedback:** https://github.com/g0rd33v/drafts-protocol/issues

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119.

---

## 1. Portable token grammar

```abnf
token         = "drafts_" tier "_" server-num "_" secret
tier          = "server" / "project" / "agent"
server-num    = 1*DIGIT
secret        = 1*HEXDIG
HEXDIG        = %x30-39 / %x61-66    ; 0-9 a-f lowercase only
```

Secret length requirements:

| Tier | MUST accept | MUST reject |
|---|---|---|
| server | exactly 16 hex | any other length |
| project | exactly 12 hex | any other length |
| agent | exactly 10 hex | any other length |

Uppercase hex MUST be rejected.

---

## 2. URL namespace

### 2.1 Welcome

```
GET /drafts/pass/<token>
```

Response: `200 OK` with `Content-Type: text/html; charset=utf-8`. Body MUST contain an HTML page AND a `<script type="application/json" id="drafts-machine-context">` block with the schema of § 5.

Malformed or unrecognized token: `404 Not Found`.

### 2.2 Public artifacts

```
GET /live/<project>/<path>
```

- No authentication
- `<project>` MUST match `[a-z][a-z0-9-]{0,62}`
- Servers SHOULD set `Cache-Control: public, max-age=60` or stricter

### 2.3 API

```
<method> /drafts/api/<endpoint>
Authorization: Bearer <secret>
```

`<secret>` is the hex portion of the portable token (the substring after the last underscore).

---

## 3. Operations

### 3.1 Create project (server tier)

```
POST /drafts/projects
Authorization: Bearer <server_secret>
Content-Type: application/json

{ "name": "<project-name>", "description": "<optional>" }
```

Success:
```json
{
  "ok": true,
  "project": "<name>",
  "pap_activation_url": "https://<host>/drafts/pass/drafts_project_<n>_<hex>",
  "live_url": "https://<host>/live/<name>/",
  "drafts_view_url": "https://<host>/drafts-view/<name>/"
}
```

Errors: `400` invalid name, `409` exists, `401` wrong token.

### 3.2 Write file (project or agent tier)

```
PUT /drafts/api/files/<project>/<path>
Authorization: Bearer <secret>
Content-Type: <mime>

<body>
```

- Project tier writes to `main` branch
- Agent tier writes to `aap/<agent_id>/` branch
- `<path>` MUST NOT contain `..`, `//`, or absolute components
- Maximum body size: 20 MB (MUST be enforced)

Success: `200 OK` (update) or `201 Created` (new) with `{ "ok": true, "commit": "<sha>" }`.

### 3.3 Promote (project tier)

```
POST /drafts/api/promote/<project>
Authorization: Bearer <project_secret>
```

Atomic: partial states MUST NOT be observable to public requests.

Response: `{ "ok": true, "live_url": "https://<host>/live/<project>/" }`.

### 3.4 Optional operations

In 0.1, implementations MAY provide: list files, diff, rollback, delete, rotate. Formal definitions deferred to 0.2.

---

## 4. Rate limits (minimum conformance)

Implementations MUST enforce per-token limits at or below:

| Tier | Per minute | Per hour | Per day |
|---|---|---|---|
| Server | 120 | 2,000 | 20,000 |
| Project | 60 | 600 | 5,000 |
| Agent | 10 | 60 | 300 |

On exceed: `429 Too Many Requests` with `Retry-After` header in seconds.

Implementations SHOULD additionally apply per-IP limits on `/drafts/pass/` and `/drafts/api/` — 30 req/min per IP is RECOMMENDED.

---

## 5. Machine JSON schema

Embedded in every welcome page:

```html
<script type="application/json" id="drafts-machine-context">
{
  "protocol": "drafts",
  "protocol_version": "0.1",
  "server_number": 0,
  "server_name": "Labs Reference Server",
  "tier": "project",
  "project_name": "<string|null>",
  "portable_identifier": "https://<host>/drafts/pass/drafts_<tier>_<n>_<hex>",
  "token": "<secret>",
  "api_base": "https://<host>/drafts/api",
  "endpoints": {
    "files": "https://<host>/drafts/api/files/<project>/<path>",
    "promote": "https://<host>/drafts/api/promote/<project>",
    "projects": "https://<host>/drafts/projects"
  },
  "capabilities": ["static", "media", "git", "github-sync"],
  "rate_limits": { "per_minute": 60, "per_hour": 600, "per_day": 5000 },
  "registry_url": "https://beta.labs.vc/drafts/registry.json"
}
</script>
```

Clients SHOULD ignore unknown fields.

---

## 6. Registry schema

```json
{
  "protocol": "drafts",
  "protocol_version": "0.1",
  "updated_at": "<ISO 8601>",
  "servers": {
    "<n>": {
      "name": "<string>",
      "operator": "<string>",
      "base_url": "https://<host>",
      "contact": "<email|url>",
      "status": "active" | "deprecated",
      "endpoints": {
        "welcome": "https://<host>/drafts/pass/<token>",
        "api": "https://<host>/drafts/api",
        "registry": "https://<host>/drafts/registry.json"
      },
      "token_format": {
        "server_hex_length": 16,
        "project_hex_length": 12,
        "agent_hex_length": 10
      }
    }
  }
}
```

Server number `0` is reserved for the reference server operated by Labs. Other non-negative integers assigned first-come via PR to this repository's `registry.json`.

---

## 7. Security considerations

### 7.1 Token leakage

Tokens are bearer credentials. Anything in possession of the token has the authority granted by the tier. Clients MUST NOT send tokens in URL query strings (where they appear in referrer headers and server logs). Tokens SHOULD only appear in path segments of welcome URLs or in `Authorization: Bearer` headers.

### 7.2 Token brute-force

Minimum entropy targets (48-bit project, 40-bit agent) are chosen under the assumption of the rate limits in § 4. At 100 million active project passes and a 1,000-IP distributed attacker, expected time to first valid hit is approximately 28 days. Implementations SHOULD augment with fail2ban-equivalent on `401` response bursts.

### 7.3 Path traversal

All file paths MUST be validated against the project root. Implementations MUST reject `..`, absolute paths, and any percent-encoded or double-encoded equivalent.

### 7.4 Content-Type

Servers SHOULD enforce an allowed MIME list. HTML, CSS, JavaScript, JSON, plain text, and common media (PNG, JPEG, WebP, MP3, MP4) are safe. Executable binary formats SHOULD be rejected.

### 7.5 Transport

HTTPS is required. Plain HTTP requests under `/drafts/` MUST 301-redirect to HTTPS. HSTS with `max-age >= 31536000` is RECOMMENDED.

### 7.6 Rotation

Compromised passes MUST be rotatable. Implementations SHOULD expose `POST /drafts/api/rotate`. Old-token invalidation MUST be immediate (no grace period for the old secret).

### 7.7 Audit

Implementations SHOULD retain per-token access logs for at least 30 days.

---

## 8. Versioning

- `0.x`: breaking changes permitted, documented in CHANGELOG.md
- `>= 1.0`: SemVer — MAJOR breaking, MINOR additive, PATCH backward-compatible
- Current protocol version is advertised in registry and machine JSON

---

## 9. References

- RFC 2119 — keyword semantics
- RFC 7231 — HTTP/1.1 semantics
- RFC 6750 — Bearer tokens
- RFC 8446 — TLS 1.3
- RFC 6797 — HSTS
