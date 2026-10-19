# AI AGENT INSTRUCTIONS - @primebrick/core

## ⚠️ CRITICAL: NEVER COMMIT AUTOMATICALLY

**AI agents MUST NEVER commit changes without explicit user instruction.**

- **WAIT for the user to explicitly tell you to commit** before running any `git commit` command
- This applies to ALL situations — no exceptions
- See [docs/gitflow.md](./docs/gitflow.md) for complete GitFlow rules including commit rules

## Repository overview

`@primebrick/core` is the **root of the shared library tree** for Primebrick v3 —
environment-neutral contracts consumed by every other package:

```
@primebrick/core      (this repo — pure types, models, helpers, zero runtime deps)
   ├── @primebrick/dal-pg
   ├── @primebrick/sdk
   ├── @primebrick/ui
   └── primebrick-be-v3 / primebrick-us-v3 / primebrick-fe-v3
```

It hosts the canonical entity metadata schema (`EntityMeta`,
`EntityMetaResponse`, `MetaColumn`, `TableMeta`, `RowCustomAction`), the entity
action vocabulary (`EntityAction`, `STANDARD_OPS`, `EntityActionEndpoint`), list
query types (`ListResponse`, `DeletionFilterMode`, `ListConnector`,
`AdvancedFilter`), branded primitives (`SnakeCaseSingular`), and the pure column
helpers (`orderedColumns`, `defaultVisibleColumnKeys`, `getOperatorsForColumnType`).

**Hard invariants:**

- **Zero runtime dependencies** — this package must stay dependency-free.
- **Environment-neutral** — no DOM, no Node APIs, no Svelte, no Express. It must
  compile identically for browser, server and CLI consumers.
- **No I/O, no framework code** — types + pure functions only.

**Documentation language:** All `*.md` files use **English**.

## Commands

| Action | Command |
|--------|---------|
| Install | `pnpm install` |
| Build | `pnpm run build` |
| Type check | `npx tsc --noEmit` |
| Test | `pnpm test` |
| Test (watch) | `pnpm test:watch` |
| Extract docs | `pnpm extract-docs` |

## Conventions

- **snake_case everywhere** — TS properties, JSON fields, contract keys. No DTO
  transformation. See `.devin/rules/data-model-conventions.md`.
- **Contract-first versioning** — a breaking change to a shared type requires
  bumping all consumers; prefer additive changes (`?:` fields, new union
  members documented as such).
- **Fail-closed helpers** — `isEntityOpEnabled` and friends return `false` on
  absent/invalid contract data; they never guess defaults.

## GitFlow

This repository follows GitFlow. AI agents MUST follow these rules.

**See [docs/gitflow.md](./docs/gitflow.md) for complete GitFlow rules.**

## Package Versioning — FIXED versions only (MANDATORY)

All package versions in `package.json` MUST be pinned to exact versions (e.g.
`"typescript": "6.0.3"`). NO ranges (`^`, `~`, `>=`, `*`, `latest`) are allowed
for registry packages.

See [.devin/rules/package-versioning.md](./.devin/rules/package-versioning.md)
for the full rule and upgrade procedure.

## Documentation (3 tiers — see `.devin/rules/docs-audience.md`)

Developer documentation lives in `docs/dev-guide/` as MDX files.
These are synced to `docs.primebrick.dev` under the dev section — never ingested
into the end-user AI KB.

- **Location**: `docs/dev-guide/*.mdx` — one file per topic
- **Ordering**: `docs/dev-guide/_order.json` defines the sidebar page order
- **Conventions**: see `.devin/rules/docs-dev-guide.md` for editorial rules
- **Mermaid**: use `<Mermaid chart={...} />`, never ` ```Code ` or ` ```mermaid `
- **API extraction**: run `pnpm extract-docs` to generate
  `docs/dev-guide/_extracted/api.json` from TypeDoc
- **Internal docs** (`docs/ai/`, `docs/gitflow.md`) are NOT synced — they stay
  in this repo for AI agents only
