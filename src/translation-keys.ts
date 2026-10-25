/**
 * Translation key namespace ↔ owning PG schema — the write-boundary rule.
 *
 * A module stores translations ONLY inside its own PG schema, and only
 * keys namespaced for that schema:
 *   public   → `app.*`      (the only namespace with a static FE fallback file)
 *   system   → `system.*`   (includes `system.entities.*`, `system.settings.*`)
 *   custom   → `custom.*`   (user-created keys — never seed/module-owned)
 *   <svc>    → `<svc>.*`    (every registered service owns `<code>.translations`)
 *
 * WRITE boundary (enforced by the translation CRUD gateway and by the
 * check-standards `i18n-sql-ns` rule on db-meta patches): a service must
 * never register/seed/create a key outside its own namespace — that is how
 * cross-module dictionary collisions become impossible by construction.
 *
 * REFERENCE boundary (meta-declared `*_key` values, nav `label_key`):
 * references are not writes — a module may cite its own namespace plus the
 * CORE namespaces (`app.*`, `system.*`). Foreign non-core namespaces are
 * forbidden until declared module dependencies exist.
 */

/** Owning PG schema → the only translation-key namespace writable there. */
export function translationKeyNamespace(schema: string): string {
  return schema === "public" ? "app" : schema;
}

/**
 * Namespaces a module's meta/nav declarations may REFERENCE — the module's
 * own namespace plus the CORE vocabularies (`app`, `system`).
 */
export function allowedKeyNamespaces(moduleCode: string): ReadonlySet<string> {
  return new Set([moduleCode, "app", "system"]);
}

/** First dotted segment of a translation key — `job.entities.x` → `job`. */
export function keyNamespaceOf(key: string): string | null {
  const i = key.indexOf(".");
  return i > 0 ? key.slice(0, i) : null;
}
