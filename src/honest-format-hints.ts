/**
 * The name→format honesty matrix — the single source of truth consumed by:
 *   - `schemaHonestyIssue` in ./field-validation.ts (runtime contract),
 *   - the sdk enrollment validators (registry gate),
 *   - the check-standards lint (`schema-honest-format`), which imports this
 *     file BY RELATIVE PATH so the tool stays zero-dep and CI can run it
 *     against bare checkouts with no install.
 * A new dishonesty case is added HERE — never re-invented per surface.
 */
export const HONEST_FORMAT_HINTS: { re: RegExp; formats: readonly string[]; why: string }[] = [
  { re: /_at$|At$/, formats: ["date-time"], why: "timestamp" },
  { re: /_by$|By$/, formats: ["uuid"], why: "actor/uuid" },
  { re: /uuid/i, formats: ["uuid"], why: "uuid" },
  { re: /(?:^|_)e?_?mails?(?:_|$)|emails?$/i, formats: ["email"], why: "email" },
  { re: /(?:^|_)(?:phones?|tel|mobile)(?:_|$)|phones?$/i, formats: ["phone"], why: "phone" },
  { re: /(?:^|_)(?:urls?|uris?)$|[Uu]rls?$|[Uu]ris?$/, formats: ["url", "uri"], why: "url" },
  { re: /(?:^|_)locales?$|language_?isos?$|locales?$/i, formats: ["lang"], why: "locale/language" },
];
