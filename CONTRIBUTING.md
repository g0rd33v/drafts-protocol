# Contributing to drafts

Thank you for your interest. drafts is early-stage; contributions of all sizes are welcome.

## Ways to contribute

- **Protocol feedback** — open an issue with the `protocol` label. Proposals for breaking changes should reference specific sections of [SPEC.md](docs/SPEC.md).
- **Reference implementation** — pull requests against `app.js`, `rich-context.js`, or `deploy/`. Changes that don't affect protocol conformance are low-friction.
- **Documentation** — any improvement to `docs/` or this README is welcome.
- **Registry** — see [REGISTRY.md](docs/REGISTRY.md) to register your own server.
- **Client libraries** — publish a drafts client in your favorite language, link here.

## Development setup

```bash
git clone https://github.com/g0rd33v/drafts-protocol.git
cd drafts-protocol
npm install
cp .env.example .env
# set BEARER_TOKEN to a 16-hex string of your choice
node app.js
```

## Pull request process

1. Fork this repository
2. Create a branch from `main` with a descriptive name (`feature/`, `fix/`, `docs/`)
3. For protocol-affecting changes, update [SPEC.md](docs/SPEC.md) and [CHANGELOG.md](CHANGELOG.md) in the same PR
4. For code changes, ensure `npm test` passes (when the suite lands)
5. Keep PRs focused — one concern per PR
6. Reference any related issue

## Versioning policy

- Protocol version declared in [SPEC.md § 8](docs/SPEC.md) and in the registry
- Implementation version in `package.json`
- Breaking protocol changes require major version bump and a 60-day deprecation period

## Testing a local server

Register your local server with a separate integer (e.g., `9999`) — not `0`, not anyone else's number. Do not submit local-development entries to the public registry.

## Code of conduct

All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
