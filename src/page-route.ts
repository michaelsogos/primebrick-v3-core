/**
 * Canonical per-route page declaration — the wire contract between a module's
 * route census contribution and the frontend's page resolution.
 *
 * Env-neutral by design: consumed by the BE (module nav registry + routes
 * census), the FE (census mirror + `RemotePageMount`), and remote module
 * chunks (`ctx.nav` in `mountPage(el, ctx)`). All fields snake_case per the
 * data-model convention. The `kind` axis (archetype) is orthogonal to remote
 * delivery (`component_url`) — a route can be a remote `page` today and a
 * remote `list` tomorrow.
 */

import type { EntityMeta } from "./entity-meta.js";

/** Page archetype vocabulary — what the route renders, regardless of delivery. */
export type PageRouteKind = "list" | "detail" | "create" | "page";

/**
 * Remote component delivery format. Extensible — new literals are additive
 * and non-breaking. `esm-mount`: a precompiled ESM chunk that exports
 * `mountPage(el, ctx)` (or a default component as fallback).
 */
export type PageRouteComponentFormat = "esm-mount";

/**
 * One declared frontend route owned by a module. Modules MUST declare every
 * FE path they own that is not deducible from nav links or entity
 * conventions — the AI route census (derived from the consolidated
 * `GET /api/v1/modules` discovery payload) depends on it.
 * `param` marks dynamic segments using the FE convention ([uuid], [code]).
 */
export type PageRouteDeclaration = {
  route: string;
  kind: PageRouteKind;
  /** Entity code when the route is bound to a CRUD surface. */
  entity?: string;
  /** i18n key for a human-readable label, when available. */
  label_key?: string;
  /**
   * i18n key of the page description line rendered under the header title —
   * route-level, valid on EVERY `kind` (the old `form.description_key`
   * privilege is removed).
   */
  description_key?: string;
  /**
   * Lucide icon name — used by host chrome that renders the route as an
   * action (e.g. the toolbar create CTA for `kind:"create"` routes).
   */
  icon?: string;
  /**
   * Who owns the page header chrome. `"host"` (default): the host shell
   * renders the mandatory PageHeader (breadcrumb, star, title, description,
   * presence) above the page body — including above a remote mount.
   * `"remote"`: the remote chunk owns its chrome and the host header is
   * suppressed for this route. Ignored by host-rendered archetypes — their
   * chrome is always host-owned.
   */
  chrome?: "host" | "remote";
  /**
   * Remote component delivery — when set, the host mounts the chunk at this
   * same-origin URL (typically `/svc/<service>/api/v1/module-assets/…`)
   * instead of resolving a local component.
   */
  component_url?: string;
  /** Delivery format of `component_url` — see {@link PageRouteComponentFormat}. */
  component_format?: PageRouteComponentFormat;
  /**
   * Optional integrity of the `component_url` payload — `sha256-<base64>`
   * (SRI form) or bare lowercase hex. The host verifies the fetched bytes via
   * Web Crypto before importing; a mismatch renders an in-content integrity
   * error and nothing is mounted.
   */
  integrity?: string;
  /**
   * Chrome the route's standard CTAs open in — `"page"` (default): the
   * create/edit CTA navigates to the route; `"sheet"`: it opens the SAME
   * archetype content inside the host sheet surface (the route keeps
   * working when visited directly — the hint only steers CTA behavior).
   * Read by host archetypes and list CTAs, never by remote pages.
   */
  presentation?: "page" | "sheet";
  /**
   * Archetype-agnostic page props — the metadata a route needs beyond the
   * shared fields. `form` carries entity-form placement + policy.
   */
  page_props?: PageRouteProps;
};

/**
 * One field's placement + policy inside an entity form — PAGE-domain
 * metadata: it positions a field the ENTITY owns; it never redefines the
 * field's type or validation (those come from `meta.columns` — class-derived
 * constraints + authored `format`).
 *
 * `key` MUST exist in the served `meta.columns` — the host archetype
 * validates at render time and fails loudly on drift.
 */
export type FormFieldPlacement = {
  /** Entity column key — resolves against served `meta.columns`. */
  key: string;
  /** `grid-column` start (2-col standard grid) — overrides auto-flow. */
  col?: number;
  /** `grid-column` span — `span: 2` = full-width row. */
  span?: number;
  /** `grid-row` span. */
  row_span?: number;
  /** Section id grouping fields under a shared header (i18n key resolved
   *  by the host archetype). */
  section?: string;
  /** Initial value prefill — page-domain form UX (never the DB default). */
  default_value?: unknown;
  /** i18n key of the control placeholder. */
  placeholder_key?: string;
  /** Required override — defaults to the class-derived `nullable`
   *  (`false` → required). May only LOOSEN to optional, never tighten
   *  past the physical contract. */
  required?: boolean;
  /** Render the control read-only (e.g. audit-ish fields on edit). */
  readonly?: boolean;
  /** Explicit control override — key of the host widget registry; bypasses
   *  the `format`→control mapping for this field only. */
  widget?: string;
  /**
   * Dynamic option vocabulary for ComboSelect fields — closed union.
   * `"census.emits"`: the union of every module's `events.emits` from the
   * `/modules` discovery payload (already client-side at render time).
   * Free entry stays allowed for wildcard/dynamic subjects.
   */
  options_source?: "census.emits";
};

/**
 * `page_props.form` — the entity-form page declaration. `fields` is the
 * ORDERED placement list: only declared keys render (absent columns are
 * simply not editable on this surface). `validators` names closed-vocab
 * cross-field rules implemented host-side (e.g. `target_matches_lane`) —
 * the host rejects unknown validator keys.
 */
export type FormPageDecl = {
  fields: FormFieldPlacement[];
  /** Closed-vocab cross-field validator keys — host-implemented registry. */
  validators?: string[];
};

/** `page_props` — free-form per-route metadata with a typed `form` axis. */
export type PageRouteProps = {
  /** `kind:"create"|"detail"` entity forms — field placement + form policy. */
  form?: FormPageDecl;
};

/** Sheet side — the two chrome slots the host sheet engine owns. */
export type ModuleSheetSide = "left" | "right";

/**
 * Chrome defaults a sheet declaration may suggest. The caller's `openSheet`
 * options always win over these — they are a hint, not a policy.
 * `content_class` maps to the host engine's `contentClass` option.
 */
export type ModuleSheetDefaults = {
  side?: ModuleSheetSide;
  modal?: boolean;
  content_class?: string;
};

/**
 * A remote sheet panel declared by a service inside `endpoints.nav.sheets`
 * — the sheet analogue of a remote {@link PageRouteDeclaration}: the host
 * owns the sheet ENGINE (open/close/chrome/state), the owning service owns
 * the CONTENT — an `esm-mount` chunk exporting `mountSheet(el, ctx)`,
 * mounted at runtime into the host's global sheet surface.
 *
 * `key` is the open-sheet address, `<module>.<name>` namespaced so a
 * declared key can never collide across services (enforced at enrollment
 * by the nav-declaration validator). Anyone holding the key can open it —
 * host `openSheet`, `ctx.components.openSheet` — visibility is gated by
 * the sheet's derived access key (`access.<ns>.<name>`), never by import
 * reachability.
 */
export type ModuleSheetDecl = {
  /** The open-sheet address — `<module>.<name>` (validator-enforced). */
  key: string;
  /** Remote sheet chunk — same-origin `/svc/<service>/api/v1/module-assets/…`. */
  component_url: string;
  /** Delivery format — see {@link PageRouteComponentFormat}. */
  component_format?: PageRouteComponentFormat;
  /** Optional sha256 integrity of `component_url` — same verify path as pages. */
  integrity?: string;
  /** i18n key for a human-readable title, when available. */
  label_key?: string;
  /** Suggested chrome — overridden by the caller's open options. */
  default_options?: ModuleSheetDefaults;
};

/**
 * One sidebar navigation link contributed by a module. `children` is the
 * collapsible-group mechanism (the shell renders children under the parent).
 */
export type ModuleNavLink = {
  id: string;
  label_key: string;
  href: string;
  icon?: string;
  /**
   * Marks the module's DEFAULT leaf — exactly one leaf nav item must carry
   * it (validator-enforced). GOTO(module) resolves the default leaf's
   * href; when the user's grants filter that leaf out, the first
   * accessible leaf wins. Leaf items only — never on a parent carrying
   * `children`.
   */
  default?: boolean;
  children?: ModuleNavLink[];
};

/**
 * A module's self-described navigation declaration — the payload a service
 * publishes in `service.register` (`endpoints.nav`) so the FE can render
 * the module's sidebar nav and the census can resolve its routes WITHOUT
 * the BE hardcoding another module's pages. This is the wiring that lets
 * each module present its own nav — a remote page is owned by the service
 * that ships it, never declared inside a host module's registry.
 *
 * `route_prefixes` drive active-module resolution (longest-prefix match —
 * a page under a shared prefix like `/system/jobs` resolves to the owning
 * module, not to the module owning the broader `/system` prefix).
 */
export type ModuleNavDeclaration = {
  /** Module code — implicit when declared on a service's registry row. */
  module?: string;
  /** FE path prefixes this module owns (longest match wins). */
  route_prefixes: string[];
  /**
   * The module's access NAMESPACE — REQUIRED. The `access.{app}.{module}`
   * prefix under which every leaf key is derived (`accessLeafKey`):
   * `/system/job/rules` ⇒ `access.system.job.rules`,
   * `job.runDetail` ⇒ `access.system.job.runDetail`. A module that
   * declares nav/routes/sheets is exposed surface, so the namespace is
   * mandatory and must equal `accessNamespace(code, part_of)` (validated
   * at enrollment AND by write-time decl tests).
   *
   * Module visibility is DERIVED, never a gate key: the module exists for
   * a user iff at least one of its leaf keys is covered by their grants.
   * Coverage is exact-or-wildcard only — `access.system.job` bare is a
   * namespace, not a grant; `access.system.job.*` covers every leaf.
   *
   * The access axis is a separate vocabulary inside the same permission
   * pipeline as entity RBAC (`role_mappings` grants, wildcard matching) —
   * `is_admin` implies NOTHING here: access grants are always explicit.
   */
  access: string;
  /** Sidebar nav links shown while this module is active. */
  nav: ModuleNavLink[];
  /** Full route census — nav-declared AND non-derivable paths. */
  routes?: PageRouteDeclaration[];
  /**
   * Remote sheet panels this module owns — engine is host-side, content
   * is service-delivered (`mountSheet` chunks). Travels the same
   * discovery channel as `routes`; access-filtered per decl.
   */
  sheets?: ModuleSheetDecl[];
  /** Shell-reserved module (e.g. settings) — never set by services. */
  is_reserved?: boolean;
};

/**
 * A module's emitted-event declaration — `endpoints.events` in
 * `service.register` → `service_registry.endpoints.events` → the
 * `/modules` discovery payload.
 *
 * `emits` lists the NATS subjects the service PUBLISHES as domain events
 * (wildcards allowed: `customer.*`, `crm.customers.changed`) — the
 * decoupled vocabulary other modules and host pickers (e.g. job rules
 * `event_subject`/`source_subject`) consume to offer real subjects.
 * A module never declares who subscribes — that stays decoupled by design.
 * Subscription-side subjects (`NatsRoute[]`) are internal and never
 * declared here.
 */
/**
 * One published subject — the ConfigEntry display anatomy mirrored:
 * `label_key` = short translated display name (primary line), `description_key`
 * = human description (small secondary line), `subject` = the raw key (mono
 * line). Both keys point at translations in the EMITTING module's namespace
 * (`<ns>.events.<name>`); pickers render label + desc + subject.
 */
export type EmitDecl = {
  /** Published subject — concrete or wildcard (`*` segment, `>` tail). */
  subject: string;
  /** i18n key of the short display name (primary option line). */
  label_key?: string;
  /** i18n key of the human description, in the module's own translations. */
  description_key?: string;
};

export type ModuleEventsDecl = {
  /** Published subjects — concrete or wildcard (`*` segment, `>` tail). */
  emits?: EmitDecl[];
};

/**
 * `ctx.components.mfaStepUp` — host-bound step-up MFA bridge. The remote
 * calls it exactly like the host's `useMfaStepUp().executeWithToken`:
 * `requestFn` runs once with `token = null`; on a `403` response carrying
 * `mfa_step_up_required` the host shows ITS OWN step-up dialog (host root,
 * host runtime — nothing crosses the boundary), awaits verification, then
 * retries `requestFn` with the action-authorization token. The promise
 * resolves with the final Response — success or failure.
 */
export type MfaStepUpFn = (
  requestFn: (token: string | null) => Promise<Response>,
  context: { action: string; target_resource: string },
) => Promise<Response>;

/**
 * `ctx.components.openSheet` — opens a sheet panel by key: a host-registered
 * panel (`shell.*`/`entity.*`/`config.*`) or a remote-declared sheet
 * (`<module>.<name>` from `nav.sheets[]`, mounted at runtime). The panel
 * registry, remote declarations and sheet state all live in the host — a
 * remote page requests the panel, it never ships the engine. `props` are
 * plain values (callback fns are allowed — they cross the boundary);
 * `options` are the host's sheet options (`side`, `contentClass`, `modal`,
 * `keepMountedState`). Unknown keys are rejected with a host notification —
 * the remote cannot smuggle an undeclared panel.
 */
export type OpenSheetFn = (
  panelKey: string,
  props?: Record<string, unknown>,
  options?: Record<string, unknown>,
) => void;

/**
 * `ctx.components.hostApi` — the host's authenticated full-path fetch
 * (`apiFetch`): reaches BE-owned `/api/v1/…` endpoints that `ctx.api`
 * (ws-bound to the owning service) cannot. Remote pages bind it through
 * `bindRemoteCtx(ctx)` → `getServiceApi('host')`.
 */
export type HostApiFn = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * `ctx.components` — the reserved well-known keys plus open caller-provided
 * entries. `remote` is assigned by the host loader after the chunk
 * resolves; `mfaStepUp`/`openSheet`/`hostApi` are built-ins the host
 * always provides (a caller may override them in tests).
 */
export type ModuleHostComponents = {
  remote?: unknown;
  mfaStepUp?: MfaStepUpFn;
  openSheet?: OpenSheetFn;
  hostApi?: HostApiFn;
  [key: string]: unknown;
};

/**
 * Notification payload accepted by `ctx.notify` — the minimal shape of the
 * host's `pushNotification` input. Plain values only.
 */
export type ModuleNotifyInput = {
  impact: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";
  message?: string;
  messageKey?: string;
  scope?: string;
  scopeKey?: string;
  detail?: string;
  toast?: boolean;
  [key: string]: unknown;
};

/**
 * Host-side context base handed to EVERY remote mount — pages
 * (`mountPage`) and sheets (`mountSheet`) alike. Versioned via
 * `host_version` — remote chunks can refuse incompatible hosts.
 *
 * HARD CONSTRAINT — plain values and functions ONLY: Svelte rune state
 * (`$state`/`$derived`/`$effect`) is bundle-local and cannot cross this
 * boundary. UI building blocks come from `@primebrick/ui` bundled inside
 * the remote chunk, not from ctx; `components` is reserved for the few
 * host-coupled cases (see `components` doc).
 */
export type ModuleHostBase = {
  host_version: 1;
  /**
   * Authenticated fetch bound to the owning service's `/svc/<code>` base when
   * derivable (paths are service-relative), else the host's raw API base.
   */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** Translation fn (evaluated per call) + the current locale code. */
  i18n: {
    t: (key: string, params?: Record<string, unknown>) => string;
    locale: string;
  };
  /** `pushNotification` equivalent — toasts + error-panel event cards. */
  notify: (input: ModuleNotifyInput) => void;
  /**
   * Optional host-coupled components and helpers (opaque values at this
   * boundary — components are host-compiled Svelte components, helpers are
   * plain functions). Only for cases the remote page cannot self-render;
   * NOT for sharing rune state.
   *
   * `components` MAY also carry remote-agnostic plain functions the host
   * owns (e.g. `appendListFilterParams`, `settingsTabMenuSegment`).
   *
   * SNIPPETS DO NOT CROSS — in either direction. A Svelte snippet invoked
   * under the other bundle's render reads its own runtime's
   * `active_effect` (null while the other bundle is rendering) and dies on
   * `Cannot read properties of null (reading 'nodes')`. Verified by live
   * E2E — what worked in the synchronous-mount spike fails in production
   * render order. The supported bridges are `mount_host` (host root inside
   * remote DOM) and the symmetric remote-mount slot (remote root inside
   * host DOM, see `components.remote` below).
   *
   * Reserved key: `remote` — the host loader assigns the imported module
   * namespace to `components.remote` after the chunk resolves, so
   * host-side code (e.g. shim snippets running under host render) can
   * reach additional chunk exports such as a `cell_mount(el, props)`
   * function for remote content inside host trees.
   *
   * Built-in keys the host always provides: `mfaStepUp` (step-up MFA for
   * guarded remote ops), `openSheet` (sheet panels) and `hostApi`
   * (full-path BE fetch) — see {@link ModuleHostComponents} /
   * {@link MfaStepUpFn} / {@link OpenSheetFn} / {@link HostApiFn}.
   */
  components?: ModuleHostComponents;
  /**
   * Mount a host-compiled component as a separate Svelte root inside remote
   * DOM. Rendering a host component inline (`<HostComp/>`) inside remote
   * markup CANNOT work — each bundle has its own Svelte runtime/component
   * internals; this host-bound `mount()` bridge is the supported path.
   *
   * The returned handle pushes prop updates reactively (`update`) and
   * destroys the root (`destroy`). Props are plain values — NOT remote
   * snippets (see the `components` doc: cross-bundle snippet invocation
   * crashes; remote content inside the mounted host tree goes through a
   * remote `cell_mount`-style export + a host anchor component instead).
   */
  mount_host?: (
    component: unknown,
    el: HTMLElement,
    props: Record<string, unknown>
  ) => HostMountHandle;
};

/**
 * Host ctx handed to a remote page's `mountPage(el, ctx)` — the shared
 * {@link ModuleHostBase} plus the page's own route axis (`nav`/`meta`).
 */
export type ModulePageHost = ModuleHostBase & {
  /** This page's own route declaration as resolved by the host. */
  nav: PageRouteDeclaration;
  /** Entity metadata, present when the route is entity-bound. */
  meta?: EntityMeta;
};

/**
 * Host ctx handed to a remote sheet's `mountSheet(el, ctx)` — the shared
 * {@link ModuleHostBase} plus the `sheet` control surface: the declared
 * key, the caller's props (opaque at the boundary — the owning module
 * knows their shape), the current chrome, and the commands to mutate the
 * host-owned frame. No `nav`/`meta` — a sheet is not a route; domain
 * context arrives through `sheet.props`.
 */
export type ModuleSheetHost = ModuleHostBase & {
  sheet: {
    /** The declared sheet key (`<module>.<name>`) as resolved by the host. */
    key: string;
    /** Caller props forwarded verbatim — functions may cross. */
    props: Record<string, unknown>;
    side: ModuleSheetSide;
    modal: boolean;
    /** Close the sheet — equivalent to the host close affordance. */
    close: () => void;
    /** Replace this sheet's props — the host remounts the sheet content. */
    replace: (props: Record<string, unknown>) => void;
    /** Expanded chrome mode — widens the surface, implies modal. */
    setExpanded: (expanded: boolean) => void;
  };
};

/**
 * Handle returned by `ModulePageHost.mount_host` — imperative channel to a
 * host-mounted component root.
 */
export type HostMountHandle = {
  /** Push new props — the host applies them reactively. */
  update: (props: Record<string, unknown>) => void;
  /** Destroy the mounted root (unmount + cleanup). */
  destroy: () => void | Promise<void>;
};

/**
 * The `esm-mount` chunk's entry contract — `export function mountPage(el, ctx)`.
 * May return the `mount()` result (disposed via `unmount()`), a custom dispose
 * function, or a promise of either.
 *
 * NOTE: a raw `mount()` result is only safe when it was registered by the
 * SAME svelte module instance that will call `unmount()` on it. Remote
 * chunks resolve svelte through the vendor import map while the host runs
 * its own bundled copy — two `mounted_components` registries — so chunk
 * code MUST go through `mountModuleContent` (or return an equivalent
 * dispose closure over the mounting bundle's `unmount`), never hand the
 * host a foreign mount record.
 */
export type MountPageFn = (el: HTMLElement, ctx: ModulePageHost) => unknown;

/**
 * The sheet chunk's entry contract — `export function mountSheet(el, ctx)`.
 * The chunk is declared in `endpoints.nav.sheets[]` ({@link ModuleSheetDecl})
 * and mounted inside the host's global sheet surface. Same dispose rules as
 * {@link MountPageFn}.
 */
export type MountSheetFn = (el: HTMLElement, ctx: ModuleSheetHost) => unknown;
