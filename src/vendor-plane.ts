/**
 * Vendor plane — the closed, host-owned library surface that remote module
 * chunks resolve through the document import map.
 *
 * Contract:
 * - The host prebundles each specifier into a versioned `/vendor/*.js`
 *   bundle and publishes a static import map (`app.html`) plus a
 *   `vendor-manifest.json` carrying the resolved versions.
 * - A remote chunk emits bare imports ONLY for specifiers in
 *   {@link VENDOR_SPECIFIERS} — resolved to the host bundles at runtime.
 * - A bare specifier inside a vendor top-level package but NOT in the list
 *   (e.g. `svelte/internal/client/dom/x`) is a build error, not a bundled
 *   fallback: bundling a second copy of a runtime package creates a split
 *   instance (duplicate caches, broken context identity).
 * - Leaf deps (clsx, tailwind-merge, module-private libs) bundle inside the
 *   importer's own file — they carry no instance semantics.
 * - Each remote chunk emits a sibling `<chunk>.deps.json`
 *   ({@link RemoteDepsManifest}); before importing, the host loader diffs its
 *   `vendor_requires` against `vendor-manifest.json` and shows a graceful
 *   error panel on mismatch instead of an opaque import failure.
 */

/**
 * Closed allowlist of bare specifiers remote chunks may import. A
 * package's specifiers normally union into ONE bundle file so the browser
 * dedupes by URL — a single runtime instance is guaranteed. Exception:
 * `svelte`'s public subpaths (events/reactivity/store/attachments) get
 * their own files — their export names collide with the internal signal
 * API (`get`/`derived` exist in both), and a flat union module cannot hold
 * both. Shared internals still dedupe through the bundler's shared chunks.
 */
export const VENDOR_SPECIFIERS = [
	"svelte",
	"svelte/internal/client",
	"svelte/internal/disclose-version",
	// emitted by the svelte compiler into .svelte output that touches
	// legacy-mode constructs (bits-ui compiled sources)
	"svelte/internal/flags/legacy",
	// public svelte subpaths vendored libs (and remote components) legally
	// import — unioned into the single svelte.js bundle like the internals.
	// ('svelte/elements' is types-only — no runtime export exists.)
	"svelte/events",
	"svelte/reactivity",
	"svelte/store",
	"svelte/attachments",
	"svelte/motion",
	"svelte/easing",
	"@primebrick/core",
	"@primebrick/ui",
	"@primebrick/ui/vendor/transformers",
	"@primebrick/ui/vendor/clsx",
	"@primebrick/ui/vendor/tailwind-merge",
	"@primebrick/ui/vendor/tailwind-variants",
	"@primebrick/ui/vendor/lucide",
	"@primebrick/ui/vendor/bits-ui",
] as const;

export type VendorSpecifier = (typeof VENDOR_SPECIFIERS)[number];

/**
 * Packages that MUST NOT be imported raw inside a remote chunk — they are
 * already served through a sanctioned vendor specifier (e.g. transformers is
 * vendored behind `@primebrick/ui/vendor/transformers`). A raw import would bundle
 * a second runtime copy (split caches, split env config) — reject it.
 */
export const VENDOR_BLOCKED_PACKAGES = [
	"@huggingface/transformers",
	"clsx",
	"tailwind-merge",
	"tailwind-variants",
	"@lucide/svelte",
	"bits-ui",
] as const;

/** Top-level npm package of a specifier ('svelte/internal/client' → 'svelte'). */
export function specifierTopPackage(specifier: string): string {
	return specifier.startsWith("@")
		? specifier.split("/").slice(0, 2).join("/")
		: specifier.split("/")[0];
}

const VENDOR_TOP_PACKAGES = new Set(
	VENDOR_SPECIFIERS.map(specifierTopPackage)
);

export type VendorResolution =
	| "external" // exact allowlist hit — emit bare, resolved via import map
	| "reject" // vendor package, non-allowlisted specifier — build error
	| "bundle"; // leaf dep — inline into the importing chunk

/**
 * How a remote chunk's bundler must treat a bare import specifier. Both the
 * host vendor build and every module chunk build derive behavior from this
 * single function so the plane stays deterministic.
 */
export function resolveVendorSpecifier(specifier: string): VendorResolution {
	if ((VENDOR_SPECIFIERS as readonly string[]).includes(specifier)) {
		return "external";
	}
	const top = specifierTopPackage(specifier);
	if (
		VENDOR_TOP_PACKAGES.has(top) ||
		(VENDOR_BLOCKED_PACKAGES as readonly string[]).includes(top)
	) {
		return "reject";
	}
	return "bundle";
}

/**
 * `<chunk>.deps.json` — emitted next to each remote chunk at build time,
 * declaring the vendor specifiers/versions it was compiled against.
 */
export type RemoteDepsManifest = {
	vendor_requires?: Record<string, string>;
};

/** Host `vendor-manifest.json` — specifier → published vendor asset. */
export type VendorManifest = Record<
	string,
	{ url: string; version: string }
>;

export type VendorMismatch =
	| { specifier: string; kind: "missing"; required: string }
	| { specifier: string; kind: "version"; required: string; provided: string };

/**
 * Vendor compatibility check — exact-match policy. A remote chunk compiled
 * against a different version of a vendored package is incompatible:
 * `svelte/internal/*` is not a stable API and each union bundle's export set
 * may change between versions. The remedy is rebuilding the remote chunk —
 * a semver-tolerant handshake would only defer an opaque import failure.
 */
export function diffVendorRequirements(
	requires: Record<string, string>,
	manifest: VendorManifest,
): VendorMismatch[] {
	const mismatches: VendorMismatch[] = [];
	for (const [specifier, required] of Object.entries(requires)) {
		const provided = manifest[specifier]?.version;
		if (provided == null) {
			mismatches.push({ specifier, kind: "missing", required });
		} else if (provided !== required) {
			mismatches.push({ specifier, kind: "version", required, provided });
		}
	}
	return mismatches;
}
