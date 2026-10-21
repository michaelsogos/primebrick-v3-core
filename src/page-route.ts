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
   * Lucide icon name — used by host chrome that renders the route as an
   * action (e.g. the toolbar create CTA for `kind:"create"` routes).
   */
  icon?: string;
  /**
   * Remote component delivery — when set, the host mounts the chunk at this
   * same-origin URL (typically `/ws/<service>/api/v1/module-assets/…`)
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
   * Access-axis gate — `access.{app}.{module}.{page}` key (see
   * `ModuleNavDeclaration.access`). Absent = open to authenticated users.
   */
  access?: string;
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
   * Access-axis gate — `access.{app}.{module}.{page}` key. The nav link (and
   * the page it points to) is visible only when the user's grants cover it;
   * absent = open to any authenticated user.
   */
  access?: string;
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
   * Module-level access gate — the `access.{app}.{module}` key a user must
   * hold to see the module AT ALL (whole subtree; e.g.
   * `access.system.settings`). A page grant alone (`access.system.job.runs`)
   * does NOT satisfy a module-level gate — use nav/route-level `access`
   * for partial visibility instead. Absent = module visible to any
   * authenticated user; its nav/routes may still filter per-page.
   *
   * The access axis is a separate vocabulary inside the same permission
   * pipeline as entity RBAC (`role_mappings` grants, wildcard matching) —
   * `is_admin` implies `access.system.*` ONLY; other roots need explicit
   * grants even for admins.
   */
  access?: string;
  /** Sidebar nav links shown while this module is active. */
  nav: ModuleNavLink[];
  /** Full route census — nav-declared AND non-derivable paths. */
  routes?: PageRouteDeclaration[];
  /** Shell-reserved module (e.g. settings) — never set by services. */
  is_reserved?: boolean;
};

/**
 * Notification payload accepted by `ctx.notify` — the minimal shape of the
 * host's `pushNotification` input. Plain values only.
 */
export type ModulePageNotifyInput = {
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
 * Host-side context handed to a remote page's `mountPage(el, ctx)`.
 * Versioned via `host_version` — remote chunks can refuse incompatible hosts.
 *
 * HARD CONSTRAINT — plain values and functions ONLY: Svelte rune state
 * (`$state`/`$derived`/`$effect`) is bundle-local and cannot cross this
 * boundary. UI building blocks come from `@primebrick/ui` bundled inside the
 * remote chunk, not from ctx; `components` is reserved for the few
 * host-coupled cases (see `ModulePageHost.components`).
 */
export type ModulePageHost = {
  host_version: 1;
  /** This page's own route declaration as resolved by the host. */
  nav: PageRouteDeclaration;
  /** Entity metadata, present when the route is entity-bound. */
  meta?: EntityMeta;
  /**
   * Authenticated fetch bound to the owning service's `/ws/<code>` base when
   * derivable (paths are service-relative), else the host's raw API base.
   */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** Translation fn (evaluated per call) + the current locale code. */
  i18n: {
    t: (key: string, params?: Record<string, unknown>) => string;
    locale: string;
  };
  /** `pushNotification` equivalent — toasts + error-panel event cards. */
  notify: (input: ModulePageNotifyInput) => void;
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
   */
  components?: Record<string, unknown>;
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
 */
export type MountPageFn = (el: HTMLElement, ctx: ModulePageHost) => unknown;
