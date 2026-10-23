import { describe, expect, it } from "vitest";
import {
	VENDOR_SPECIFIERS,
	diffVendorRequirements,
	resolveVendorSpecifier,
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
};

describe("resolveVendorSpecifier", () => {
	it("externalizes every allowlisted specifier", () => {
		for (const s of VENDOR_SPECIFIERS) {
			expect(resolveVendorSpecifier(s)).toBe("external");
		}
	});
	it("rejects non-allowlisted specifiers inside vendor packages", () => {
		expect(resolveVendorSpecifier("svelte/internal/client/dom/x")).toBe("reject");
		expect(resolveVendorSpecifier("@primebrick/ui/internal")).toBe("reject");
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
});
