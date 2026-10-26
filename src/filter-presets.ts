/**
 * filter-presets — resolution helpers for `meta.table.filter_presets`.
 *
 * A filter preset is a mutually-exclusive toolbar selector whose active
 * option's `where` conditions are appended to EVERY `/list` request
 * (leading `filters[i]` slots, AND connector — same slot `fixedFilters`
 * occupies). Exactly one option is always selected: the persisted choice,
 * `default_option` when absent/invalid, and there is no "clear" affordance.
 * Options may declare `where: []` as the "all" escape — still a selection.
 *
 * Canonical home shared by the host `useEntityList` and remote module
 * mirrors — selection semantics must never drift between them.
 */
import type { FilterCondition, FilterPreset } from "./entity-meta.js";

/**
 * Resolve a preset's active option id — the caller-provided selection when
 * it names a declared option, otherwise `default_option` (itself falling
 * back to the first option when misconfigured, keeping the always-one
 * invariant rather than failing closed).
 */
export function resolvePresetSelection(
  preset: FilterPreset,
  selected: string | undefined,
): string {
  if (selected && preset.options.some((o) => o.id === selected)) {
    return selected;
  }
  if (preset.options.some((o) => o.id === preset.default_option)) {
    return preset.default_option;
  }
  return preset.options[0]?.id ?? "";
}

/**
 * Flatten the WHERE conditions of every preset's ACTIVE option — the
 * conditions AND-ed into every `/list` call. `selections` maps
 * preset.id → option id; invalid/absent ids resolve per
 * {@link resolvePresetSelection}.
 */
export function resolvePresetConditions(
  presets: readonly FilterPreset[] | undefined,
  selections: Record<string, string>,
): FilterCondition[] {
  const out: FilterCondition[] = [];
  for (const preset of presets ?? []) {
    const optionId = resolvePresetSelection(preset, selections[preset.id]);
    const option = preset.options.find((o) => o.id === optionId);
    for (const cond of option?.where ?? []) out.push(cond);
  }
  return out;
}

/**
 * Service API base of an entity list basePath — strips the trailing
 * `/entities/<entity>` segment so service-relative endpoints declared in
 * meta (e.g. sparkline `endpoint: "/actions/job-run-stats"`) resolve to
 * `/svc/<svc>/api/v1/actions/…` or `/api/v1/actions/…` for BE entities.
 */
export function serviceApiBase(listBasePath: string): string {
  return listBasePath.replace(/\/entities\/[^/]+\/?$/, "");
}
