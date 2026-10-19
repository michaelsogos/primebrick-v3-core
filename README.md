# @primebrick/core

Environment-neutral shared contracts for Primebrick v3 — the root of the shared
library tree. Pure TypeScript types, models and helpers; zero runtime
dependencies; consumable identically from browser, server and CLI code.

## What's inside

| Area | Exports |
|------|---------|
| Entity meta contract | `EntityMeta`, `EntityMetaResponse`, `MetaColumn`, `MetaColumnType`, `TableMeta`, `RowCustomAction`, `CollaborationMeta`, `TooltipPriority` |
| Entity actions | `EntityAction`, `EntityActionEndpoint`, `EntityActionSentinel`, `STANDARD_OPS`, `StandardOp`, `ActionsOverrides`, `isEntityOpEnabled` |
| List query | `ListResponse<TRow>`, `DeletionFilterMode`, `ListConnector`, `FilterOperator`, `AdvancedFilter`, `ViewName`, `SortDir` |
| Brands & helpers | `SnakeCaseSingular`, `isSnakeCaseSingular`, `asSnakeCaseSingular`, `orderedColumns`, `defaultVisibleColumnKeys`, `sanitizeVisibleKeys`, `searchableTextColumns`, `getOperatorsForColumnType` |

## Install

```bash
pnpm add @primebrick/core
```

## Usage

```ts
import {
  STANDARD_OPS,
  isEntityOpEnabled,
  type EntityMetaResponse,
} from "@primebrick/core";

const meta: EntityMetaResponse = await fetch(`/api/v1/entities/${entity}/meta`).then(r => r.json());
if (isEntityOpEnabled(meta.actions, "create.single")) {
  // render the create CTA
}
```

Subpath exports: `@primebrick/core/entity-meta`, `@primebrick/core/list`,
`@primebrick/core/columns`.

## Versioning

Fixed versions only — see the workspace GitFlow rules. Releases are tagged
`x.y.z` (no `v` prefix) and published via OIDC Trusted Publishing by
`.github/workflows/ci.yml`.

## License

MIT — see [LICENSE](./LICENSE).
