# Drafts Protocol v0.1

## Portable identifier

`drafts_<tier>_<server_num>_<secret>`

- `tier`: `server` | `project` | `agent`
- `server_num`: non-negative integer. 0 is the canonical registry server.
- `secret`: lowercase hex. 16 chars for server, 12 for project, 10 for agent.

Examples:
- `drafts_server_0_91e52304063d5440`
- `drafts_project_0_a30aca1fe85b`
- `drafts_agent_0_b7fabf75b3`

## URL format

**Canonical (welcome page):**
```
https://<host>/drafts/pass/drafts_<tier>_<server_num>_<secret>
```

**API (project-level operations):**
```
https://<host>/drafts/api/<operation>
Authorization: Bearer <project-token-without-prefix>
```

**Public (live artifacts):**
```
https://<host>/live/<project>/<path>
```

## Agent publishing flow (3 HTTP calls)

1. `GET /drafts/pass/<portable_id>` — welcome page returns machine JSON with endpoints
2. `PUT /drafts/api/files/<project>/<path>` — write file content with Authorization header
3. `POST /drafts/api/promote/<project>` — deploy drafts → live

That's it. Any agent that can make 3 HTTP calls can publish.

## Registry

`GET https://beta.labs.vc/drafts/registry.json` returns all known servers:

```json
{
  "servers": {
    "0": {
      "name": "Labs Reference Server",
      "base_url": "https://beta.labs.vc",
      "endpoints": { ... }
    }
  },
  "token_format": { ... }
}
```

Run your own server? Submit a PR adding your server to this registry.
