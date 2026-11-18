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
   *  non-standard prefixes (e.g. `/api/v1/auth/users`). An RPC route may
   *  claim the slot via `entity_op.crud_action` — the declared override. */
  endpoint?: EntityActionEndpoint;
  /** CTA chrome overrides — translation key / icon / semantic color
   *  replacing the standard rendering (e.g. soft-delete-as-disable →
   *  "Deactivate" + `exec-stop` + destructive). Cosmetics only: gating,
   *  dialogs and dispatch are untouched. Sources: `entity_op.cta` on a
   *  `crud_action` route, or `meta.actions_overrides[op]`. */
  label_key?: string;
  icon?: string;
  color?: ActionColor;
  /** Confirm-dialog message template override (`{entity}`/`{name}` for
   *  single ops, `{count}`/`{entity}` for bulk). When set it replaces the
   *  standard `app.common.{delete,restore}Entit{y,ies}Confirm` copy —
   *  e.g. soft-delete-as-disable → "disattivare" + reversible note. */
  confirm_key?: string;
  /** In-flight confirm-button label override (default `app.common.
   *  {deleting,restoring}`) — e.g. "Disattivazione…" while disabling. */
  busy_key?: string;
}

/** Per-op overrides — `enabled` toggles route-backed ops; chrome fields
 *  restyle the standard CTA without touching its logic. */
export type ActionsOverrides = Record<
  string,
  {
    enabled?: boolean;
    label_key?: string;
    icon?: string;
    color?: ActionColor;
    confirm_key?: string;
    busy_key?: string;
  }
>;

/** Closed action-color vocabulary — ONE semantic drives BOTH the icon and
 *  the label of a menu CTA (impossible to drift them apart). `neutral` is
 *  the default uncolored rendering; the destructive/warning/success/info/
 *  primary names map to the theme's semantic text utilities. `violet` is
 *  the clone/duplicate semantic — `duplicate.bulk` carries it by default
 *  and the same hue marks `CLONE` entries in the version-history trail.
 *  A meta may never smuggle a Tailwind class here — the enum IS the contract. */
export type ActionColor =
  | "neutral"
  | "primary"
  | "info"
  | "success"
  | "warning"
  | "destructive"
  | "violet";

/**
 * The full `ActionColor` vocabulary — construction/lint validation rejects
 * anything outside this closed set (raw strings on the wire can never reach
 * the renderer).
 */
export const ACTION_COLORS: readonly ActionColor[] = [
  "neutral",
  "primary",
  "info",
  "success",
  "warning",
  "destructive",
  "violet",
];

/**
 * Semantic action icons — names whose COLOR IS PART OF THE ICON's meaning.
 * Each name binds to exactly one `ActionColor` (the label color); the icon
 * component itself (in `@primebrick/ui`'s `SEMANTIC_ICONS` registry, which
 * reads THIS table) renders the gradient surface self-colored. A meta that
 * pairs a semantic icon with a different color is a contract violation —
 * `validateActionChrome` rejects it at construction time, so icon and
 * label can never drift apart even by accident.
 *
 * - `exec-start` → success   (start/enable is a positive op — deliberate
 *   divergence from the standard restore-warning chrome)
 * - `exec-stop`  → destructive (stop/disable is a destructive op)
 */
export const SEMANTIC_ICON_COLORS: Record<string, ActionColor> = {
  "exec-start": "success",
  "exec-stop": "destructive",
};

/**
 * Maps an `ActionColor` to its Tailwind text utility. `neutral`/`undefined`
 * resolves to the empty string — the item keeps the theme's default muted
 * appearance (what standard CTAs like "Modifica" already show). This is the
 * ONLY mapping of semantic color → class; renderers never hand-roll
 * `text-${color}` strings.
 */
export function actionColorClass(color: ActionColor | undefined | null): string {
  if (!color || color === "neutral") return "";
  return `text-${color}`;
}

/**
 * Validates the icon↔color contract of a single action chrome override.
 * Returns a diagnostic string on violation, `null` when the pair is legal:
 * - `color` must be a member of `ACTION_COLORS`;
 * - a semantic icon (`SEMANTIC_ICON_COLORS` key) must carry its bound color —
 *   `icon:"exec-stop", color:"success"` is an error, not a style choice.
 */
export function validateActionChrome(
  icon: string | undefined,
  color: string | undefined,
): string | null {
  if (color !== undefined && !ACTION_COLORS.includes(color as ActionColor)) {
    return `color "${color}" is not an ActionColor — allowed: ${ACTION_COLORS.join("|")}`;
  }
  const bound = icon !== undefined ? SEMANTIC_ICON_COLORS[icon] : undefined;
  if (bound !== undefined && color !== undefined && color !== bound) {
    return `semantic icon "${icon}" binds to color "${bound}", got "${color}" — icon and label can never diverge`;
  }
  return null;
}

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
  | "sparkline"
  | "ref"
  | "ref_count"
  | "avatar";

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
  | "service_code"
  | "schedule_spec"
  | "json"
  | "display_name"
  | "idp_name"
  | "color_hex"
  | "number"
  | "money"
  | "date"
  | "datetime"
  | "time"
  | "identifier"
  | "snake_key"
  | "dotted_key"
  | "dotted_glob"
  | "slug"
  | "no_space"
  | "lang";

/**
 * Dynamic option vocabulary for combo-backed controls — declared on the
 * COLUMN (`MetaColumn.options_source`), never on a form placement:
 * the same contract feeds forms, list filters and docs generation.
 * Closed union on purpose — an unknown source is a construction error.
 */
export type MetaColumnOptionsSource = "census.emits" | "census.callables" | "audit.actors" | "system.roles";

/**
 * Option vocabulary a unit-of-measure selector may draw from.
 * `"currencies"`: the ISO 4217 list resolved client-side (`getAllCurrencies`
 * — same source the config-domain currency picker uses). `{entity}`: the
 * UoM codes persist as rows of another entity (resolved via its `/list`).
 * `{api_url}`: an explicit endpoint serving the options.
 * Closed union on purpose — an unknown source is a construction error.
 */
export type MetaColumnUomSource = "currencies" | { entity: string } | { api_url: string; value_field: string; label_field?: string };

/**
 * UoM macro-categories — the hardcoded CLDR grouping census. ECMA-402
 * exposes `Intl.supportedValuesOf("unit")` as a FLAT list with no
 * category accessor (the grouping lives in CLDR data, unreachable from
 * JS) — this map is the single reusable categorization. Every member
 * MUST be an Intl-sanctioned identifier; coverage matches the runtime
 * vocabulary (45 units on ICU ≥ 2024-06). `percent` is intentionally
 * absent — adimensional, it is a `kind` of its own.
 */
export type MetaColumnUomKind =
  | "length" | "mass" | "volume" | "area"
  | "time" | "temperature" | "digital" | "angle";

export const UNIT_CATEGORIES: Record<MetaColumnUomKind, readonly string[]> = {
  length: ["millimeter", "centimeter", "meter", "kilometer", "inch", "foot", "yard", "mile", "mile-scandinavian"],
  mass: ["gram", "kilogram", "ounce", "pound", "stone"],
  volume: ["milliliter", "liter", "gallon", "fluid-ounce"],
  area: ["acre", "hectare"],
  time: ["nanosecond", "microsecond", "millisecond", "second", "minute", "hour", "day", "week", "month", "year"],
  temperature: ["celsius", "fahrenheit"],
  digital: ["bit", "kilobit", "megabit", "gigabit", "terabit", "byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "petabyte"],
  angle: ["degree"],
};

/** Reverse lookup — `UNIT_TO_CATEGORY.meter === 'length'`; compound
 *  `-per-` units are NOT sanctioned list members → absent here. */
export const UNIT_TO_CATEGORY: Record<string, MetaColumnUomKind> = Object.freeze(
  Object.fromEntries(
    Object.entries(UNIT_CATEGORIES).flatMap(([kind, units]) =>
      units.map((unit) => [unit, kind as MetaColumnUomKind]),
    ),
  ),
);

/**
 * Numeric unit-of-measure contract — the column's semantic quantity unit.
 * `"percent"`: pure display transform (display = canonical × 100, emitted =
 * display ÷ 100) — the canonical value stays a fraction; NO sibling field.
 * `"currency"`: money semantics — `field` names the SIBLING column that
 * persists the ISO code per row (mandatory); `source` defaults to
 * `"currencies"` (the shared ISO list).
 * Category kinds (`"time"`, `"length"`, `"digital"`, …): Intl-sanctioned
 * UoM grouped by {@link UNIT_CATEGORIES} — exactly ONE of:
 *  - `unit`: a FIXED identifier, sanctioned ∩ category — rendered
 *    `style:"unit"` with locale-correct inflection for free.
 *  - `field`: a PER-ROW unit persisted on a SIBLING column, constrained
 *    to the category — the picker needs NO `source`, the category itself
 *    is the option vocabulary.
 * `"custom"`: genuinely non-standard UoM only — exactly ONE of:
 *  - `field` + `source`: a per-row code from a custom vocabulary (`entity`
 *    rows, `api_url`, …); `symbol` overrides the adornment.
 *  - `symbol`: a FIXED arbitrary suffix Intl does not sanction
 *    ("pz", "items", …) — plain suffix display, never `style:"unit"`.
 * `withColumnConstraints` enforces every XOR at meta bind.
 *
 * TAXONOMY (the declaration shapes):
 *  1. UOM TYPE + VALUE both static      → `{kind:'<category>', unit}` /
 *     `{kind:'custom', symbol}`.
 *  2. UOM TYPE static, VALUE per-row    → `{kind:'currency', field}` /
 *     `{kind:'<category>', field}` / `{kind:'custom', field, source}`.
 *  3. UOM TYPE + VALUE both per-row     → RESERVED, not expressible yet:
 *     it needs the KIND itself on a persisted field (e.g.
 *     `uom:{kind_field:'uom_kind', field:'uom_code'}` or `kind:'dynamic'`)
 *     so a row can be currency and the next percent. Zero consumers today;
 *     when one appears, extend this union — never shoehorn it into custom.
 * Absent `uom` → plain decimal, no unit semantics.
 */
export type MetaColumnUom =
  | { kind: "percent" }
  | { kind: "currency"; field: string; source?: "currencies" }
  | { kind: MetaColumnUomKind; unit: string }
  | { kind: MetaColumnUomKind; field: string }
  | { kind: "custom"; field: string; source: MetaColumnUomSource; symbol?: string }
  | { kind: "custom"; symbol: string };

/**
 * Avatar renderer contract — the column renders the user/org avatar
 * (initials + color swatch), NOT a text control. `color_field` names the
 * SIBLING column that persists the per-row avatar color — same pattern
 * `uom.field` uses for the currency code column. The avatar column's own
 * value carries the initials; the sibling carries the color.
 * The sibling requirement is verified by `withColumnConstraints`: an
 * avatar column without its color column is a construction error.
 * `initials_field` (optional) names the sibling column the initials
 * DERIVE from (typically `display_name`): edit surfaces recompute the
 * initials live from it and persist the derived value when that sibling
 * crosses the wire. Same physical-column rule as `color_field`.
 */
export type MetaColumnAvatar = { color_field: string; initials_field?: string };

/**
 * A sibling-value condition — the SAME vocabulary `null_label.when` and
 * `visible_on` already use for row-gated rendering, lifted to form scope.
 * `prop` compares against the pivot ROW's prop (the picked ref option's
 * raw row — e.g. its `code`); absent `prop` compares the pivot's stored
 * value directly. `equals`/`not` take a single literal, `values` a set
 * (IN semantics).
 */
export type MetaColumnDependsCondition = {
  /** Pivot ROW prop to compare — requires the pivot to be `type:"ref"`. */
  prop?: string;
  /** Disabled when the compared value equals this literal. */
  equals?: unknown;
  /** Disabled when the compared value differs from this literal. */
  not?: unknown;
  /** Disabled when the compared value is in this set (IN semantics). */
  values?: readonly unknown[];
  /** Disabled on the pivot's presence — `set:true` = "the pivot carries
   *  a value" (e.g. a `system_key` set gates the code-owned fields of a
   *  system-owned row), `set:false` = "the pivot is still empty". The
   *  only facet that reads a NON-form sibling: a physical column absent
   *  from `page_props.form` still gates, via the served row. */
  set?: boolean;
};

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
  /** Author-asserted total suppression: the column is dropped from the
   *  served meta entirely (never reaches the table, picker, filters or
   *  forms) AND blocks auto-derivation from the entity class. This is the
   *  ONLY opt-out — visibility concerns stay on `default_visible`. */
  hidden?: boolean;
  /** Semantic color TOKEN (`TailwindColorToken`: `"amber"`, `"amber-500"`,
   *  or a semantic tone) for icon/badge accent — resolved at render time
   *  via `colorCssFromToken`/`badgeClassesFromToken` to INLINE styles.
   *  NEVER a `text-*`/`bg-*` class string: served meta is invisible to the
   *  FE content scan, so class-based colors silently dead-render.
   *  Purely cosmetic — never carries semantics the type/format doesn't. */
  color?: string;
  /** Null-state label: when the cell value is null/undefined render this
   *  translation key instead of `"-"`. `when` gates it on a sibling field
   *  (e.g. `{ field: "enabled", equals: false }` → "Disabled" only when
   *  the row is actually disabled, plain `"-"` otherwise).
   *
   *  ⚠️ DESTRUCTIVE PRESENTATION — the cell renders red-italic
   *  (`text-destructive`), an alarm anatomy reserved for noteworthy or
   *  exceptional NULLs. An ordinary "nothing here" MUST render the
   *  standard `"-"`: leave `null_label` unset. Reaching for it without a
   *  `when` gate turns every absent value into a false alarm — the one
   *  legitimate ungated use is a column whose NULL is itself the signal. */
  null_label?: { label_key: string; when?: { field: string; equals?: unknown; not?: unknown } };
  /** System-managed auditing column (created_at, updated_by, …) —
   *  rendered last. */
  audited?: boolean;
  /** Column materialization kind. Absent = physical column.
   *  `"calculated"` — SQL expression projected by the DAL (`@Calculated`
   *    decorator on the entity class): a real result column, so
   *    sortable/filterable/searchable stay ON by default (opt-out allowed).
   *  `"virtual"` — post-query enrichment not backed by SQL (`decorate()`,
   *    external sources like NATS): sortable/filterable/searchable are
   *    FORCED OFF — declaring any of them `true` is a construction error.
   *  Read-only: never required on write, never belongs in `page_props.form`. */
  kind?: "calculated" | "virtual";

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
  /** Server-managed value — the entity class says the database fills it
   *  (`@Key()` with identity generation today). Never client-supplied on
   *  create, never required by write validation; a `keyGenerated:"manual"`
   *  key stays client-writable instead. Derived by
   *  `withColumnConstraints` — authors MUST NOT set it. */
  managed?: boolean;
  /** Authored: set once at creation OR derived by a dedicated process —
   *  never editable afterwards. Editable on `kind:"create"` forms,
   *  rendered disabled on update/detail surfaces, and excluded from
   *  update payloads. Covers both subtypes with ONE behaviour (user
   *  decision): created-and-immutable (idp_username) and derived
   *  (idp_code, avatar_initials, onboarding_completed). Distinct from
   *  `managed` (DB-filled key) and `audited` (lifecycle facts). */
  immutable?: boolean;

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
  /** Unsigned numeric — the control rejects the `-` char AND the wire/form
   *  validators (`checkFieldValue`/`fieldSpecToZod`) reject negative values.
   *  PG has no unsigned types: authored only, never derived. */
  unsigned?: boolean;
  /** Unit-of-measure semantic — see {@link MetaColumnUom}. Applies to
   *  numeric columns only; `currency`/`custom` require the sibling `field`
   *  that persists the UoM code per row. */
  uom?: MetaColumnUom;
  /** Avatar renderer — see {@link MetaColumnAvatar}. Applies to
   *  `type:"avatar"` columns only; `color_field` names the sibling column
   *  that persists the per-row avatar color. */
  avatar?: MetaColumnAvatar;
  /**
   * `depends_on` — ONE declared edge from this column to a SIBLING column
   * (the pivot) on the same record. The pivot's value/row drives this
   * column's behavior — declared once, never the same edge three times:
   *
   *   - `filter_field` — `type:"ref"` only: the TARGET column the options
   *     `/list` filters on (`filters[0][field]=<filter_field>`, op `"="`,
   *     value = the pivot's stored value). First consumer: account
   *     `country → legal_form` (options scoped to the picked country).
   *   - `disabled_when` — gate the whole control while the condition
   *     matches (e.g. `company_dimension` disabled when the picked
   *     `customer_type` row's `code` is `private`).
   *   - `control_prop` — the pivot ROW's prop that resolves this column's
   *     `format` at render time (e.g. `contact.value` → `email`/`phone`/
   *     `text` control from the picked contact_type's `value_kind`).
   *
   * `filter_field`/`control_prop` both imply the control stays disabled
   * while the pivot has no value AND this column's value resets when the
   * pivot changes — a stale dependent value is a silent integrity leak.
   * `disabled_when.prop`/`control_prop` read the pivot's picked ROW —
   * legal only when the pivot column is `type:"ref"` (enforcement is
   * construction-side, in `withColumnConstraints`). Form-surface only:
   * filter columns never carry `depends_on`.
   */
  depends_on?: {
    /** Sibling column key on the same record — the pivot. */
    field: string;
    /** `type:"ref"` — the TARGET entity column the options `/list`
     *  filters on, fed by the pivot's stored value. */
    filter_field?: string;
    /** Disable gate — see {@link MetaColumnDependsCondition}. */
    disabled_when?: MetaColumnDependsCondition;
    /** The pivot ROW's prop resolving `format` at render time. */
    control_prop?: string;
  };
  /** `format:"json"` — JSON Schema driving the editor's lint/completion
   *  AND the structural validation in `buildEntityFormSchema`. */
  json_schema?: Record<string, unknown>;

  /** Explicit control override — key of the host widget registry;
   *  bypasses the `format`→control derivation on EVERY surface (forms
   *  AND filters read the same declaration — it is the column's
   *  semantic input contract, not a page-layout decision). */
  widget?: string;
  /**
   * Dynamic option vocabulary for combo-backed controls — closed union.
   * `"census.emits"`: the union of every module's `events.emits` from
   * the `/modules` discovery payload (already client-side at render
   * time). `"census.callables"`: the union of every module's
   * `callables.callables` — governed LISTEN subjects a rule/scheduler
   * may invoke. Census sources only offer declared values — see
   * `allow_create`.
   */
  options_source?: MetaColumnOptionsSource;
  /**
   * ComboSelect free-entry flag — `true` lets the user type values NOT
   * in the option list. A census source is a CLOSED vocabulary by
   * definition: `options_source:"census.*"` + `allow_create:true` is a
   * construction error (`withColumnConstraints` throws). Absent = free
   * entry disabled.
   * `"audit.actors"`: the DISTINCT vocabulary of the table's own audit
   * actor columns (`created_by`/`updated_by`/`deleted_by`) served by the
   * entity's `/audit-actors` route — uuid actors label-resolved through
   * `user_profile`, fictitious actors (`migration-*`, `initial-setup`)
   * stay raw. Auto-injected by `withColumnConstraints` on auto-derived
   * `*_by` columns — never authored by hand.
   */
  allow_create?: boolean;

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
  /** `type: "ref"` — the cell value identifies a row on ANOTHER entity.
   *  The renderer turns it into a badge linking to the target's
   *  census-declared page (entity name is the only required spec: the FE
   *  resolves routes from the module census, never hardcoded URLs). */
  ref?: {
    /** Target entity API name — the `entity` on its route declaration.
     *  Required UNLESS `entity_field` is declared (XOR): a lazy ref
     *  resolves the target per row instead. */
    entity?: string;
    /** LAZY REF — row column carrying the target entity name
     *  (e.g. `armed_ref_entity` → "job_trigger" | "service_registry").
     *  With this set the ref resolves to 2+ entities, chosen per row —
     *  one column, many drill targets. Mutually exclusive with
     *  `entity` (withColumnConstraints enforces the XOR). The lazy-ref
     *  contract: the CELL value is the display label (usually a
     *  @Calculated column — no `_name` join can decorate N entities),
     *  `key_field` points at the row column carrying the drill key,
     *  and the renderer picks the record sheet by the resolved entity
     *  name (entity-served → `entity.record`; registered non-entity
     *  targets → their panel map entry). */
    entity_field?: string;
    /** Row column holding the per-row DRILL KEY passed to the record
     *  sheet (uuid for entity-record targets, a business key for
     *  non-entity panels — the panel owns the key contract). Default:
     *  the cell value itself (the normal uuid-ref case). Useful both
     *  on lazy refs (entity_field) and on static refs whose visible
     *  cell is a label rather than the target key. */
    key_field?: string;
    /** `'detail'` — the value is the target's `uid`, links to its `[param]`
     *  route. `'list'` — links to the target's list page pre-filtered.
     *  `'none'` — the cell renders the label with NO link (for
     *  `value_field` columns whose stored value can't feed a route).
     *  Default `'detail'`. */
    route?: "detail" | "list" | "none";
    /** `route:"list"` — the TARGET column the cell value filters by
     *  (`filters[0][field]` in the list URL). */
    filter_field?: string;
    /**
     * TARGET row column the stored value comes from — default `meta.uid`
     * (the uuid). `"id"` carries the bigint surrogate key: the contract
     * for TRUE-FK pickers (`customer_accounts.local_address_id` picks an
     * `local_addresses.id` the FK actually constrains). Options fetch,
     * selected-label `IN` lookup and pivot-row resolution all filter on
     * this column instead of `uid`. A non-uid value CANNOT drive
     * `route:"detail"` links (detail params are uids) — declare
     * `route:"list"` + `filter_field` for a truthful link, or
     * `route:"none"` for a label-only cell. `withColumnConstraints`
     * enforces both at construction. Same `value_field` vocabulary as
     * {@link MetaColumnUomSource}'s api_url source.
     */
    value_field?: string;
    /**
     * Cell anatomy — `"link"` (DEFAULT): the two-affordance anatomy
     * (text → record sheet; trailing ExternalLink → target `/list`
     * filtered, `target="_blank"`). `"badge"`: the legacy badge-pill
     * single-link anatomy — explicit opt-in only, never the default.
     * `route:"none"` degrades to a label under both.
     */
    presentation?: "link" | "badge";
  };
  /** `type:"ref_count"` — a 1:N children link, usually on a `virtual`
   *  column. Renders the row's value (service-decorated count, or the
   *  label when undecorated) as a badge linking to the child entity's
   *  list page filtered to this row. */
  reverse_ref?: {
    /** Child entity API name — the `entity` on its route declaration. */
    entity: string;
    /** Child column key filtered to this row (`filters[0][field]`). */
    filter_field: string;
    /** `{field}` template for the filter value — e.g.
     *  `"jobs.schedule.job.{uuid}"`. Default `"{<meta.uid>}"`. */
    value_template?: string;
  };
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
  /** Icon name (Lucide in the reference FE) — absent renders an icon-less CTA. */
  icon?: string;
  /** Semantic color for icon + label together — see `ActionColor`. */
  color?: ActionColor;
  /** Disable the CTA on soft-deleted rows. */
  disabled_when_deleted?: boolean;
  /** Permission required to see/use the action (filtered client-side
   *  against the user's permission set). */
  required_permission?: string | string[];
  /** Row→body binding for endpoint-dispatched actions: the op's request
   *  body receives `{[row_key]: row[row_key]}` — same convention as
   *  sparkline `row_key` (e.g. `schedule_subject`). When absent and the
   *  endpoint path carries `:param` placeholders, params substitute from
   *  the row fields of the same name (`:uuid` ← `meta.uid`). */
  row_key?: string;
  /** Show the CTA only when the row's `status` (or `visible_on.field`)
   *  equals one of these values — e.g. show `resume` only on `paused`
   *  rows. Absent = always visible. Scalar comparison — boolean/number
   *  fields are allowed (e.g. `enabled ∈ [false]` for an Enable CTA). */
  visible_on?: { field: string; values: (string | number | boolean)[] };
}

/** UI configuration for a selection-aware bulk CTA (endpoint-backed op
 *  with no row binding — e.g. `disarm_all`). */
export interface BulkCustomAction {
  /** Action/op name — must resolve to an `entity_op`-declared route. */
  action_name: string;
  /** i18n key for the CTA label. */
  translation_key: string;
  /** Icon name (Lucide in the reference FE) — absent renders an icon-less CTA. */
  icon?: string;
  /** Semantic color for icon + label together — see `ActionColor`. */
  color?: ActionColor;
  /** Permission required to see/use the action. */
  required_permission?: string | string[];
  /** When true, the CTA is enabled only with rows selected and the body
   *  receives `selected_uuids`; false = fires with an empty body
   *  (selection-independent, e.g. `disarm_all`). Default true. */
  requires_selection?: boolean;
  /** Require a step-up MFA challenge before dispatch (destructive bulk). */
  require_step_up?: boolean;
  /** i18n key for a confirmation dialog message — when set, the action
   *  asks before dispatching. */
  confirm_key?: string;
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
  /** UI config for non-standard bulk CTAs rendered in the selection
   *  toolbar (e.g. `disarm_all`) — dispatch rides the same endpoint
   *  contract as row custom actions via `meta.actions`. */
  bulk_custom_actions?: BulkCustomAction[];
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
   * `system.entities.page_title.{list\|create\|edit}` templates interpolated
   * with `{entities_ns}.entities.<translation_key>.{plural\|singular}` —
   * `entities_ns` defaults to `system` for BE/core-owned entities.
   * Set only for custom pages needing a bespoke title — CRUD entity metas
   * must not declare it.
   */
  title_key?: string;
  /** Field key holding the entity primary key (usually `uuid`). */
  uid: string;
  /** Canonical display field — the column key identifying the entity's
   *  human-readable label. Drives first-column/sticky table identity and
   *  default display resolution. OPTIONAL on the wire type only:
   *  `withColumnConstraints` still REQUIRES it on every main-entity meta
   *  (construction gate — a missing key throws), while relation entities
   *  (`@Relation` marker — directed parent→child edges) MUST NOT declare
   *  one: a directed edge has no single-column identity, its display is
   *  viewpoint-dependent (`relation` facet). */
  display_field?: string;
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
 * The materialized display template — `meta.display_name` when authored,
 * `"${" + display_field + "}"` otherwise (the served default). ONE rule
 * used by both the served-meta assembler (EntityMetaResponse.display_name)
 * and the DAL's display-join projection (`<key>_name` columns evaluate the
 * SAME template on the joined row), so titles, combos and ref cells can
 * never diverge.
 */
export function resolveDisplayTemplate(
  meta: Pick<EntityMeta, "display_field" | "display_name">,
): string | null {
  return meta.display_name ?? (meta.display_field ? `\${${meta.display_field}}` : null);
}

/**
 * The `dict` facet — runtime-injected on served meta when the entity
 * class carries the `@Dict` marker (a dict base such as
 * dal-pg `DictEntityBase`). Drives the `kind:"dict"` page archetype:
 * a compact inline-editable list (rows add/edit in place).
 */
export interface DictFacet {
  /** Column key grouping rows into fieldsets — absent renders a FLAT
   *  sequence; grouping is opt-in per entity, never inferred. */
  group_field?: string;
  /** Column key owning row ordering (convention default: `sort` when the
   *  entity declares it). Reorder CTAs mutate it and persist through the
   *  page's atomic bulk save — no dedicated reorder endpoint. */
  order_field?: string;
  /** Directional label pair — declared when the dict rows are link-type
   *  vocabularies consumed by `@Relation` edges. `forward_label_field`
   *  names the column read parent-side ("the child IS a ‹label›"),
   *  `inverse_label_field` names the column read child-side ("the parent
   *  IS a ‹label›"); a NULL inverse label means the type is
   *  self-inverse — same vocabulary read from both ends (e.g. partner).
   *  Fields are PHYSICAL column keys on this dict entity. */
  directional?: {
    forward_label_field: string;
    inverse_label_field: string;
  };
}

/**
 * The `relation` facet — runtime-injected on served meta when the entity
 * class carries the `@Relation` marker (dal-pg). Declares a DIRECTED
 * parent→child edge table (e.g. `customer_link`): rows are typed arcs,
 * never standalone page entities — no `display_field`, no pinned
 * column, viewpoint-dependent display. `parent_field`/`child_field` are
 * the physical `@Ref` column keys forming the arc (immutable after
 * create — repointing is delete+create); `type_field` optionally points
 * at the directional vocabulary entity (a `directional` dict);
 * `hierarchical` opts the table into deep-cycle detection on insert
 * (the 2-cycle is always rejected by the derived unordered-pair unique
 * index — construction-derived, never authored).
 */
export interface RelationFacet {
  parent_field: string;
  child_field: string;
  type_field?: string;
  hierarchical?: boolean;
}

/**
 * The served `GET /api/v1/entities/{entity}/meta` response:
 * static meta + runtime-injected `display_name`, `actions`, `collaboration`.
 */
export type EntityMetaResponse = EntityMeta & {
  /** Materialized display template — `null` on relation entities (a
   *  directed edge has no single display template; consumers read the
   *  `relation` facet for the directional display contract). */
  display_name: string | null;
  actions: EntityAction[];
  collaboration: CollaborationMeta;
  /** Present only on dict-faceted entities — see {@link DictFacet}. */
  dict?: DictFacet;
  /** Present only on relation-faceted entities — see {@link RelationFacet}. */
  relation?: RelationFacet;
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
