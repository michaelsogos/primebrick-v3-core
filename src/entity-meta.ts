/**
 * Canonical entity metadata contract — the single source of truth for the
 * `GET /api/v1/entities/{entity}/meta` schema, shared by every consumer:
 * backend meta authoring (`*.meta.ts` + `assembleMeta`), frontend pages
 * (EntityTablePage / EntityListTable / form pages), SDK and microservices.
 *
 * Field naming is snake_case end-to-end (BE JSON → TS model → FE prop, no
 * DTO renaming — see the workspace data-model conventions).
 *
 * Two shapes exist on purpose:
 *   - `EntityMeta`         — the STATIC authored meta (`*.meta.ts` files).
 *   - `EntityMetaResponse` — the SERVED response: static meta + the
 *                            runtime-injected `display_name`, `actions` and
 *                            `collaboration` produced by `assembleMeta`.
 */

/** Table view names supported by entity list pages. */
export type ViewName = "table" | "cards" | "cards_list";

/** Sort direction for server-side list queries and header UI. */
export type SortDir = "asc" | "desc";

/**
 * Sentinel gates a route may declare instead of concrete permissions.
 * Values mirror the `Permission` enum in `@primebrick/sdk`.
 */
export type EntityActionSentinel =
  | "_public"
  | "_authenticated_user"
  | "_authenticated_admin";

/** Backing route of an `EntityAction` — emitted by the BE route scan. */
export interface EntityActionEndpoint {
  /** HTTP method of the backing route (`GET`, `POST`, `PUT`, `DELETE`, ...). */
  method: string;
  /** Full registered API path with `:param` placeholders verbatim
   *  (e.g. `/api/v1/auth/users/:uuid/restore`). Consumers substitute
   *  placeholders from the row (`:uuid` ← `meta.uid`). */
  path: string;
}

/**
 * One entry of `meta.actions` — the derived capability contract.
 * EVERY standard op is present; `enabled: false` means the op is
 * unavailable for everyone (route missing or product-disabled).
 */
export interface EntityAction {
  /** Operation name — canonical (`list`, `get`, `delete.bulk`, ...) or the
   *  last path segment for non-standard routes (`change_password`). */
  op: string;
  /** Declared non-sentinel permissions, verbatim (OR semantics). */
  permissions: string[];
  /** Sentinel gate when the route declares one instead of real perms. */
  sentinel?: EntityActionSentinel;
  /** Visibility flag — false hides the CTA for everyone. */
  enabled: boolean;
  /** The registered route that backs this op — present on every `enabled`
   *  action, absent when no route exists (`enabled: false`). Consumers
   *  dispatch writes to the declared endpoint instead of recomputing the
   *  `/api/v1/entities/{entity}` convention — required for ops living under
   *  non-standard prefixes (e.g. `/api/v1/auth/users`). */
  endpoint?: EntityActionEndpoint;
}

/** Per-op enable overrides — may ONLY toggle `enabled` on route-backed ops. */
export type ActionsOverrides = Record<string, { enabled?: boolean }>;

/**
 * The canonical vocabulary of standard entity ops. Every op is always
 * present in `meta.actions` — ops whose route is not registered are emitted
 * with `enabled: false` (explicitly unavailable) instead of being omitted.
 */
export const STANDARD_OPS = [
  "list",
  "meta",
  "get",
  "create.single",
  "update.single",
  "delete.single",
  "purge.single",
  "restore.single",
  "read.audit",
  "export",
  "delete.bulk",
  "restore.bulk",
  "duplicate.bulk",
] as const;

export type StandardOp = (typeof STANDARD_OPS)[number];

/** UI column renderer type. NOTE: this is the UI type, not the DB type —
 *  e.g. `roles` is `"text"` here but `jsonb` on disk (never ILIKE-searchable). */
export type MetaColumnType =
  | "text"
  | "badge"
  | "boolean"
  | "color"
  | "date"
  | "datetime"
  | "number"
  | "sparkline";

/**
 * Authored field-format vocabulary — the SEMANTIC input contract of a
 * column: which control archetype a form renderer must use and which
 * validation chain `buildEntityFormSchema` applies. Absent → the renderer
 * falls back to `type` (text→text input, boolean→switch, badge→options).
 *
 * Closed union on purpose: an unknown `format` in a `*.meta.ts` file is a
 * compile error — the US→FE option boundary is enforced by the type.
 * New formats are additive literals (never breaking).
 */
export type MetaColumnFormat =
  | "text"
  | "textarea"
  | "email"
  | "url"
  | "phone"
  | "secret"
  | "nats_subject"
  | "schedule_spec"
  | "json"
  | "display_name"
  | "idp_name"
  | "color_hex"
  | "number"
  | "money"
  | "date"
  | "datetime"
  | "time";

/** Tooltip visual severity — drives icon and title color in priority
 *  tooltip renderers. */
export type TooltipPriority =
  | "INFORMATION"
  | "WARNING"
  | "ERROR"
  | "QUESTION"
  | "HINT"
  | "SUCCESS";

/**
 * Entity field descriptor — the root-level `columns` dictionary.
 * Transversal to every page type: table cells, form tooltips, labels.
 *
 * Declared as a type alias (not interface): object literal types get an
 * implicit index signature, keeping `MetaColumn` assignable to
 * `Record<string, unknown>` — host/remotes pass columns through generic
 * cell-snippet args typed as `Record<string, unknown>`.
 */
export type MetaColumn = {
  /** Entity field key — must match the entity property name. */
  key: string;
  /** i18n key for the column/field label. */
  label_key: string;
  /** Renderer discriminator — `MetaColumnType` documents the built-in set,
   *  but the field is intentionally open (`| string`): modules may emit
   *  custom cell types resolved by consumer-registered cell renderers
   *  (e.g. a `cell` snippet override on EntityListTable). */
  type: MetaColumnType | string;
  /** Deterministic display position — explicit per column, array position
   *  MUST NOT matter. Rendering groups sticky → normal → audited, each group
   *  sorted by `order`. Convention: `uuid` is `order: -1` (canonical first
   *  sticky column, hidden but selectable); `display_field` is `order: 0`. */
  order: number;

  // ---- table flags ----
  /** Column supports ORDER BY (default true when omitted). */
  sortable?: boolean;
  /** Column supports filter operations in the filters sheet. */
  filterable?: boolean;
  /** Included in "search in fields" scope + backend default search
   *  (default true; set false for non-text-physical or sensitive fields). */
  searchable?: boolean;
  /** Visible by default (default true). */
  default_visible?: boolean;
  /** Pinned at the left of the table, rendered before normal columns. */
  sticky?: boolean;
  /** If false, the column cannot be hidden via the column picker. */
  hideable?: boolean;
  /** System-managed auditing column (created_at, updated_by, …) —
   *  rendered last. */
  audited?: boolean;

  // ---- form constraint props ----
  // DERIVED — injected at decl time by the DAL `withColumnConstraints`
  // helper from the entity class registration. Authors MUST NOT set them:
  // the helper throws on an authored value contradicting the class.
  /** Physical nullability — `true` → optional in forms, `false` →
   *  required. Absent on columns with no physical backing (virtual
   *  columns like `sparkline`) — those never belong in `page_props.form`. */
  nullable?: boolean;
  /** Physical max length from `@Column({length})` — feeds `maxlength`
   *  on the control and `z.string().max()` in the schema. */
  max_length?: number;
  /** Physical PG column type (`varchar`, `text`, `jsonb`, `boolean`, …) —
   *  informational for the control pick when `format` is absent. */
  pg_type?: string;

  // AUTHORED — semantic contract the entity class cannot express.
  /** Field format — see {@link MetaColumnFormat}. */
  format?: MetaColumnFormat;
  /** Extra regex applied to text-ish fields (zod `.regex()`). */
  pattern?: string;
  /** Semantic minimum length (physical `max_length` is derived). */
  min_length?: number;
  /** Numeric bounds for `number`/`money` formats. */
  min?: number;
  max?: number;
  /** `format:"json"` — JSON Schema driving the editor's lint/completion
   *  AND the structural validation in `buildEntityFormSchema`. */
  json_schema?: Record<string, unknown>;

  /** Lucide icon name rendered before the label in FORM field labels —
   *  inherits the label text color (it identifies the field's semantic,
   *  e.g. `zap` on event-subject fields). Not a table-cell icon. */
  icon?: string;

  // ---- form/list tooltip flags ----
  /** i18n key of the hint tooltip body. */
  tooltip?: string;
  /** i18n key of the tooltip title. */
  tooltip_title?: string;
  /** Tooltip visual priority (affects icon/color). */
  tooltip_priority?: TooltipPriority;
  /** Show the tooltip on form pages. */
  show_form_tooltip?: boolean;
  /** Show the tooltip on list/table pages. */
  show_list_tooltip?: boolean;

  // ---- type-specific payloads ----
  /** `type: "badge"` — per-value label/color mapping. */
  badge?: {
    values: Record<
      string,
      {
        /** i18n key for the value label. */
        label_key: string;
        /** Literal label override — wins over `label_key` when present. */
        label_text?: string;
        /** Badge color. */
        color: string;
      }
    >;
  };
  /** `type: "datetime"` — FE IANA formatting toggle bound to a per-row
   *  timezone field (IANA id comes from the API row). */
  datetime_iana_toggle?: {
    record_iana_field: string;
  };
  /** `type: "sparkline"` — per-row stacked mini-histogram fed by ONE batch
   *  POST per rows load (virtual column: no DB field expected). The list
   *  engine performs the fetch automatically — zero per-page wiring. */
  sparkline?: {
    /** POST path relative to the service API base — e.g.
     *  `/actions/job-run-stats` resolves to `/svc/job/api/v1/actions/…`
     *  for `/svc/` entities, `/api/v1/…` for BE entities. */
    endpoint: string;
    /** Request body field receiving the collected row keys
     *  (e.g. `schedule_subjects`). */
    request_field: string;
    /** Row field supplying each key (e.g. `schedule_subject`). */
    row_key: string;
    /** Response field holding the `{key: buckets[]}` map — default `"stats"`. */
    response_field?: string;
    /** Bucket time field for axis labels — default `"bucket_start"`. */
    bucket_field?: string;
    /** Response field carrying the bucket unit (`hour|day|week|month`) —
     *  default `"bucket_unit"`. */
    bucket_unit_field?: string;
    /** Stacked series, rendered bottom→top in array order; `color` is a
     *  tailwind `fill-*` utility class (e.g. `fill-emerald-500`) — the
     *  reference FE safelists the full fill palette in `app.css`, any
     *  `fill-{color}-{shade}` resolves. */
    series: readonly { field: string; color: string; label_key?: string }[];
  };
};

/**
 * One WHERE condition of a filter preset — serialized verbatim as a
 * `filters[i]` entry on the `/list` query string (same vocabulary as
 * `AdvancedFilter` conditions: field/op/value).
 */
export type FilterCondition = {
  field: string;
  /** Wire operator — `=`, `!=`, `IN`, `NOT IN`, `ILIKE`, `BETWEEN`, … */
  op: string;
  value: string | number | boolean | readonly (string | number | boolean)[];
};

/** A single selectable option of a table filter preset. */
export type FilterPresetOption = {
  /** Stable option id — persisted selection key, never an i18n value. */
  id: string;
  /** i18n key for the option label — `button_group`: NEVER rendered (the
   *  group is icon-only by design; the label feeds `aria-label`/`title`
   *  fallback); `combobox`: the item's primary line. */
  label_key: string;
  /** Lucide icon name — `button_group`: REQUIRED, it is the only visible
   *  affordance (icon-only standard); `combobox`: enriches the dropdown item. */
  icon?: string;
  /** i18n key for the tooltip — `button_group`: `title` (the only place the
   *  option's meaning is spelled out); `combobox`: secondary line of the item. */
  tooltip_key?: string;
  /**
   * AND-ed conditions appended to EVERY `/list` call while selected
   * (refresh, pagination, sort, user filters — all combine). Omit or `[]`
   * for the "all" escape option — still a real selection, applies nothing.
   */
  where?: readonly FilterCondition[];
};

/**
 * A mutually-exclusive preset filter group rendered as its own control in
 * the table toolbar (tandem with the deletion-filter group). Exactly one
 * option is always active — there is no "clear" affordance. Declared in
 * `meta.table.filter_presets`; example: a `schedule_type` scope selector
 * (recurring / once / all) on a jobs table.
 */
export type FilterPreset = {
  /** Preset id — unique within the entity; keys the toolbar group and the
   *  persisted selection (`{storageKeyPrefix}filterPresets[preset.id]`). */
  id: string;
  /** Render mode — `button_group` is the toolbar standard: segmented
   *  icon-only buttons (`icon` per option is REQUIRED, meaning carried by
   *  `title` tooltip + `aria-pressed`); `combobox` for long option lists
   *  where a labelled dropdown reads better. */
  display: "button_group" | "combobox";
  /** i18n key labeling the whole group (a11y label / combobox placeholder). */
  label_key?: string;
  /** Selectable options — declare at least two. */
  options: readonly FilterPresetOption[];
  /** Option id selected before any user choice and as the fallback for an
   *  invalid persisted selection — REQUIRED, must exist in `options`. */
  default_option: string;
};

/** UI configuration for a non-standard row CTA (route-backed bare op). */
export interface RowCustomAction {
  /** Action/op name — matches the bare op derived from the route
   *  (e.g. `change_password`). */
  action_name: string;
  /** i18n key for the CTA label. */
  translation_key: string;
  /** Icon name (Lucide in the reference FE). */
  icon: string;
  /** Optional CSS color class for the label. */
  text_color?: string;
  /** Disable the CTA on soft-deleted rows. */
  disabled_when_deleted?: boolean;
  /** Permission required to see/use the action (filtered client-side
   *  against the user's permission set). */
  required_permission?: string | string[];
}

/** Table options — present only on entities with a table page. */
export interface TableMeta {
  /** Initial view (default "table"). */
  default_view?: ViewName;
  default_sort?: { key: string; dir: SortDir };
  default_page_size?: number;
  page_size_options?: number[];
  /** UI config for non-standard row actions (e.g. change password).
   *  Standard ops (edit/delete/duplicate/preview) are derived from
   *  `meta.actions` — never declared here. */
  row_custom_actions?: RowCustomAction[];
  /** Mutually-exclusive preset WHERE filters — each rendered as its own
   *  toolbar control; the active option's conditions AND into every list
   *  request (see {@link FilterPreset}). */
  filter_presets?: readonly FilterPreset[];
}

/** Collaboration fragment injected by `assembleMeta` at serve time. */
export interface CollaborationMeta {
  enabled: boolean;
  expose_editing_value: boolean;
}

/**
 * Static entity meta — the shape every `*.meta.ts` file MUST satisfy.
 * The schema is CLOSED for authored metas: undeclared properties are
 * compile errors, so new meta props require extending this type first.
 */
export interface EntityMeta {
  /** Entity name, snake_case singular (e.g. `user_profile`). */
  entity: string;
  /** i18n prefix, snake_case singular — used to build dynamic keys. */
  translation_key: string;
  /**
   * Namespace OWNING this entity's label keys — the module's own namespace
   * (`job` → `job.entities.<translation_key>.*`). Absent → `system`
   * (BE/core-owned entities keep `system.entities.*`).
   * This is a READ-side reference declared by the owning module — the
   * namespace write boundary (see `translation-keys.ts`) guarantees the
   * keys actually live in that module's `<code>.translations` schema.
   */
  entities_ns?: string;
  /**
   * Optional i18n key overriding the canonical page title.
   * When absent, list/create/edit titles are built from the generic
   * `system.entities.page_title.{list|create|edit}` templates interpolated
   * with `system.entities.<translation_key>.{plural|singular}`.
   * Set only for custom pages needing a bespoke title — CRUD entity metas
   * must not declare it.
   */
  title_key?: string;
  /** Field key holding the entity primary key (usually `uuid`). */
  uid: string;
  /** Canonical display field — the column key identifying the entity's
   *  human-readable label. Drives first-column/sticky table identity and
   *  default display resolution. */
  display_field: string;
  /**
   * Display expression template (`${field}` syntax, dot-paths allowed).
   * OPTIONAL here: `assembleMeta` materializes it as
   * `"${" + display_field + "}"` when absent — it is always present in the
   * served response. Used automatically for edit-page titles; reusable for
   * comboboxes, lists, chips.
   */
  display_name?: string;
  /** Per-op enable overrides — may ONLY toggle `enabled` on route-backed
   *  ops; a missing route already produces `enabled: false`. */
  actions_overrides?: ActionsOverrides;
  /** Entity field dictionary (root-level, transversal). */
  columns: MetaColumn[];
  /** Table options — omit when the entity has no table page
   *  (e.g. a self-service form meta). */
  table?: TableMeta;
}

/**
 * The served `GET /api/v1/entities/{entity}/meta` response:
 * static meta + runtime-injected `display_name`, `actions`, `collaboration`.
 */
export type EntityMetaResponse = EntityMeta & {
  display_name: string;
  actions: EntityAction[];
  collaboration: CollaborationMeta;
};

/**
 * Pure enablement check — true when `op` exists in the served `actions`
 * array and carries `enabled: true`. FAIL-CLOSED: when `actions` is absent
 * (meta without actions — contract violation) the op is not enabled.
 *
 * This deliberately does NOT evaluate user permissions — that step lives in
 * the consumer (e.g. FE `isEntityOpAllowed` composes this with the session
 * permission check).
 */
export function isEntityOpEnabled(
  actions: readonly EntityAction[] | undefined,
  op: string,
): boolean {
  if (!actions) return false;
  const action = actions.find((a) => a.op === op);
  return action?.enabled === true;
}
