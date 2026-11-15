/**
 * Supported languages — THE canonical vocabulary for the whole platform.
 *
 * BCP-47 full tags (language + region) — en-GB and en-US are distinct
 * first-class locales because they carry different date/number/address
 * formatting, not just different dictionaries.
 *
 * Consumers:
 * - `@primebrick/sdk`/`@primebrick/ui` re-export (BE routers, FE pickers)
 * - `check-standards` lint (relative-path import, sibling checkout)
 * - DB `CHECK (language IN (...))` constraints on `*.translations` —
 *   the SQL literals must mirror this list; the lint enforces it.
 *
 * Adding a language = add the tag here + seed translations + bump the
 * CHECK constraints — a deliberate release-scoped change, never data.
 */
export const SUPPORTED_LANGUAGES = [
  "en-GB",
  "en-US",
  "it-IT",
  "fr-FR",
  "es-ES",
  "de-DE",
  "pt-PT",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const SUPPORTED_LANGUAGE_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

/** Type guard — is `tag` one of the platform-supported language tags? */
export function isSupportedLanguage(tag: string): tag is SupportedLanguage {
  return SUPPORTED_LANGUAGE_SET.has(tag);
}
