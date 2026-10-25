# @primebrick/core

Environment-neutral shared contracts for Primebrick v3 — the root of the
shared library tree. Pure TypeScript types, models and helpers consumable
identically from browser, server and CLI code; `@primebrick/decimal` is
re-exported so downstream libs can pass it to FE/BE/US.

## Install

```bash
pnpm add @primebrick/core
```

## Documentation

The export surface is contract code — it is documented where it is
maintained, not duplicated here:

- [AGENTS.md](./AGENTS.md) — agent entry point, repo conventions
- [docs/dev-guide/](./docs/dev-guide/) — generated API reference + hand-written
  guides (entity-meta contract, vendor plane, page-route declaration)
- `src/index.ts` — the public barrel is the source of truth for exports;
  `package.json` `exports` lists every importable subpath

## Versioning

Fixed versions only. Releases are tagged `x.y.z` (no `v` prefix) and
published via OIDC Trusted Publishing by `.github/workflows/ci.yml`.
See [docs/gitflow.md](./docs/gitflow.md).

## License

MIT — see [LICENSE](./LICENSE).
