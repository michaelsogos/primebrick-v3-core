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
 * conventions — the AI route census (GET /system/routes) depends on it.
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
   * Optional host-coupled components (opaque values at this boundary — they
   * are host-compiled Svelte components). Only for cases the remote page
   * cannot self-render; NOT for sharing rune state.
   */
  components?: Record<string, unknown>;
};

/**
 * The `esm-mount` chunk's entry contract — `export function mountPage(el, ctx)`.
 * May return the `mount()` result (disposed via `unmount()`), a custom dispose
 * function, or a promise of either.
 */
export type MountPageFn = (el: HTMLElement, ctx: ModulePageHost) => unknown;
