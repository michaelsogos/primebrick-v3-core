import { describe, expect, it } from "vitest";
import {
	VENDOR_SPECIFIERS,
	diffVendorRequirements,
	lucideIconSpecifier,
	resolveVendorSpecifier,
	rewriteLucideBarrelImports,
	specifierTopPackage,
	type VendorManifest,
} from "./vendor-plane.js";

const manifest: VendorManifest = {
	svelte: { url: "/vendor/svelte.js", version: "5.57.2" },
	"svelte/internal/client": { url: "/vendor/svelte.js", version: "5.57.2" },
	"svelte/internal/disclose-version": {
		url: "/vendor/svelte.js",
		version: "5.57.2",
	},
	"@primebrick/ui": { url: "/vendor/primebrick-ui.js", version: "3.0.0" },
	"@primebrick/ui/vendor/transformers": {
		url: "/vendor/vendor-transformers.js",
		version: "4.3.1",
	},
	"@primebrick/ui/vendor/lucide/icons/": {
		url: "/vendor/icons/lucide/",
		version: "1.59.0",
	},
};

describe("resolveVendorSpecifier", () => {
	it("externalizes every allowlisted specifier", () => {
		for (const s of VENDOR_SPECIFIERS) {
			expect(resolveVendorSpecifier(s)).toBe("external");
		}
	});
	it("externalizes every specifier under a sanctioned prefix", () => {
		expect(
			resolveVendorSpecifier("@primebrick/ui/vendor/lucide/icons/cpu.js"),
		).toBe("external");
		expect(
			resolveVendorSpecifier("@primebrick/ui/vendor/lucide/icons/alarm-check.js"),
		).toBe("external");
		// the bare prefix itself is not a specifier
		expect(
			resolveVendorSpecifier("@primebrick/ui/vendor/lucide/icons/"),
		).not.toBe("external");
	});
	it("rejects non-allowlisted specifiers inside vendor packages", () => {
		expect(resolveVendorSpecifier("svelte/internal/client/dom/x")).toBe("reject");
		expect(resolveVendorSpecifier("@primebrick/ui/internal")).toBe("reject");
		// the lucide barrel is gone — emitting it must fail, not resolve
		expect(resolveVendorSpecifier("@primebrick/ui/vendor/lucide")).toBe("reject");
	});
	it("rejects blocked direct package imports", () => {
		expect(resolveVendorSpecifier("@huggingface/transformers")).toBe("reject");
		// raw vendor libs are served through their sanctioned subpaths —
		// a raw import would bundle a second copy (split instances)
		expect(resolveVendorSpecifier("clsx")).toBe("reject");
		expect(resolveVendorSpecifier("tailwind-merge")).toBe("reject");
		expect(resolveVendorSpecifier("tailwind-variants")).toBe("reject");
		expect(resolveVendorSpecifier("@lucide/svelte")).toBe("reject");
		expect(resolveVendorSpecifier("bits-ui")).toBe("reject");
	});
	it("bundles leaf deps", () => {
		expect(resolveVendorSpecifier("zod")).toBe("bundle");
	});
});

describe("specifierTopPackage", () => {
	it("handles scoped and unscoped names", () => {
		expect(specifierTopPackage("svelte/internal/client")).toBe("svelte");
		expect(specifierTopPackage("@primebrick/ui/vendor/transformers")).toBe("@primebrick/ui");
	});
});

describe("diffVendorRequirements", () => {
	it("returns no mismatches when every requirement is satisfied", () => {
		expect(
			diffVendorRequirements(
				{ svelte: "5.57.2", "@primebrick/ui": "3.0.0" },
				manifest,
			),
		).toEqual([]);
	});
	it("flags a version mismatch with both sides", () => {
		expect(diffVendorRequirements({ svelte: "5.58.0" }, manifest)).toEqual([
			{ specifier: "svelte", kind: "version", required: "5.58.0", provided: "5.57.2" },
		]);
	});
	it("flags a specifier the host does not vendor", () => {
		expect(diffVendorRequirements({ "@primebrick/core": "3.0.0" }, manifest)).toEqual([
			{ specifier: "@primebrick/core", kind: "missing", required: "3.0.0" },
		]);
	});
	it("reports every mismatch, not just the first", () => {
		const mismatches = diffVendorRequirements(
			{ svelte: "5.58.0", "@primebrick/core": "3.0.0" },
			manifest,
		);
		expect(mismatches).toHaveLength(2);
	});
	it("satisfies prefix-manifest specifiers and flags stale versions", () => {
		expect(
			diffVendorRequirements(
				{ "@primebrick/ui/vendor/lucide/icons/cpu.js": "1.59.0" },
				manifest,
			),
		).toEqual([]);
		expect(
			diffVendorRequirements(
				{ "@primebrick/ui/vendor/lucide/icons/cpu.js": "1.60.0" },
				manifest,
			),
		).toEqual([
			{
				specifier: "@primebrick/ui/vendor/lucide/icons/cpu.js",
				kind: "version",
				required: "1.60.0",
				provided: "1.59.0",
			},
		]);
	});
});

describe("lucideIconSpecifier", () => {
	it("converts export names to dist filenames", () => {
		expect(lucideIconSpecifier("Cpu")).toBe(
			"@primebrick/ui/vendor/lucide/icons/cpu.js",
		);
		expect(lucideIconSpecifier("CheckCircle2")).toBe(
			"@primebrick/ui/vendor/lucide/icons/check-circle-2.js",
		);
		expect(lucideIconSpecifier("AArrowDown")).toBe(
			"@primebrick/ui/vendor/lucide/icons/a-arrow-down.js",
		);
		expect(lucideIconSpecifier("CircleGauge")).toBe(
			"@primebrick/ui/vendor/lucide/icons/circle-gauge.js",
		);
	});
});

describe("rewriteLucideBarrelImports", () => {
	const P = "@primebrick/ui/vendor/lucide";
	it("decomposes named imports into per-icon specifiers", () => {
		const { code, icon_specifiers } = rewriteLucideBarrelImports(
			`import { Cpu, CheckCircle2 as Ok } from '${P}';\n`,
		);
		expect(code).toBe(
			`import { default as Cpu } from '${P}/icons/cpu.js';\n` +
				`import { default as Ok } from '${P}/icons/check-circle-2.js';\n`,
		);
		expect(icon_specifiers).toEqual([
			`${P}/icons/cpu.js`,
			`${P}/icons/check-circle-2.js`,
		]);
	});
	it("strips whole-statement and inline type imports", () => {
		const { code, icon_specifiers } = rewriteLucideBarrelImports(
			`import type { IconNode } from '${P}';\n` +
				`import { Cpu, type IconProps } from '${P}';\n`,
		);
		expect(icon_specifiers).toEqual([`${P}/icons/cpu.js`]);
		expect(code).not.toContain("IconNode");
		expect(code).not.toContain("IconProps");
	});
	it("returns input untouched when the barrel is absent", () => {
		const src = `import { Cpu } from './local.js';\n`;
		expect(rewriteLucideBarrelImports(src).code).toBe(src);
	});
	it("throws on non-decomposable barrel forms", () => {
		expect(() =>
			rewriteLucideBarrelImports(`import Lucide from '${P}';\n`),
		).toThrow("named imports only");
		expect(() =>
			rewriteLucideBarrelImports(`import * as L from '${P}';\n`),
		).toThrow("named imports only");
	});
});
