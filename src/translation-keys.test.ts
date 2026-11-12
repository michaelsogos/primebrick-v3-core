import { describe, expect, it } from "vitest";
import {
  isValidTranslationKey,
  keyNamespaceOf,
  translationKeyGrammarError,
  translationKeyNamespace,
  TRANSLATION_KEY_GRAMMAR,
} from "./index.js";

describe("translation key grammar", () => {
  it("accepts canonical keys", () => {
    for (const k of [
      "app.auth.login.title",
      "system.entities.list.keys.move",
      "crm.entities.customer_type.rows.private",
      "ai.nav",
      "system.settings.config.auth.gateway_secret_header.label",
      "app.error.404",
      "es.entities.email_template.fields.subject",
    ]) {
      expect(isValidTranslationKey(k), k).toBe(true);
      expect(translationKeyGrammarError(k), k).toBeNull();
    }
  });

  it("rejects camelCase and UPPER segments", () => {
    for (const k of [
      "system.entities.versionHistory.title",
      "app.common.moveUp",
      "system.settings.config.typeConfig.label",
      "ai.entities.ai_model.compatibility.COMPATIBLE",
      "app.common.validation.invalidEmail",
    ]) {
      expect(isValidTranslationKey(k), k).toBe(false);
      expect(translationKeyGrammarError(k), k).toMatch(/snake_case/);
    }
  });

  it("rejects malformed shapes", () => {
    expect(translationKeyGrammarError("app")).toMatch(/namespaced/);
    expect(translationKeyGrammarError("app.")).toMatch(/empty segment/);
    expect(translationKeyGrammarError(".app.x")).toMatch(/empty segment/);
    expect(translationKeyGrammarError("app..x")).toMatch(/empty segment/);
    expect(translationKeyGrammarError("app.x-")).toMatch(/snake_case/);
    expect(isValidTranslationKey("app.x y")).toBe(false);
    expect(isValidTranslationKey("APP.x")).toBe(false);
    expect(isValidTranslationKey("")).toBe(false);
  });

  it("grammar constant matches the documented SQL CHECK shape", () => {
    // The CHECK constraint uses: ^<ns>(\.[a-z0-9_]+)+$ — the same
    // acceptance set as TRANSLATION_KEY_GRAMMAR (ns IS the first
    // [a-z0-9_]+ segment). Drift guard: verify a representative set.
    for (const k of ["a.b", "app.x.y.z", "app.a1.b_2"]) {
      expect(TRANSLATION_KEY_GRAMMAR.test(k), k).toBe(true);
    }
  });

  it("namespace helpers stay orthogonal to grammar", () => {
    expect(keyNamespaceOf("app.auth.x")).toBe("app");
    expect(keyNamespaceOf("nodot")).toBeNull();
    expect(translationKeyNamespace("public")).toBe("app");
    expect(translationKeyNamespace("crm")).toBe("crm");
  });
});
