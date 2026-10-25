/**
 * ConfigEntry wire contract — the `config_entry` entity shape served by
 * `GET /api/v1/entities/config_entry/*` (BE auth_configurations — Config
 * Table standard). Env-neutral shared contract: BE, FE, ui composables
 * (`useConfigEntries`) and remote chunks all consume the same type.
 * Field names stay snake_case end-to-end per the data-model convention.
 */

/**
 * Config value type vocabulary — drives widget selection and validation.
 * Mirrors the SDK `ConfigType` and the BE `type` column.
 *
 * - `bigint`: integer values backed by JS `BigInt` (renamed from `integer`)
 * - `number`: decimal/float values backed by JS `Number`
 * - `money`:  numeric amount with currency metadata in `type_config`
 */
export type ConfigEntryType =
	| 'string'
	| 'text'
	| 'boolean'
	| 'bigint'
	| 'number'
	| 'money'
	| 'badge'
	| 'single_select'
	| 'multi_select'
	| 'url'
	| 'secret'
	| 'json'
	| 'date'
	| 'datetime'
	| 'time'
	| 'email'
	| 'phone';

/**
 * Standard Config Table entry.
 *
 * The BE coerces `value` to its native JS type before serialization:
 *   - `bigint` → native `bigint` (preserved by ext-json response parsing)
 *   - `number` → native `number`
 *   - `money`  → native `number` (amount only; currency is in `type_config`)
 *   - `secret` → `null` (masked by BE)
 *   - other    → `string`
 *
 * Write path: callers send the native type (bigint/number/string); the BE
 * serializes it to the DB string form via `serializeConfigValue`.
 */
export type ConfigEntry = {
	uuid: string;
	key: string;
	value: string | bigint | number | null;
	type: ConfigEntryType;
	type_config?: string | null;
	label_key?: string | null;
	description_key?: string | null;
	group_key?: string | null;
	reserved: boolean;
	version: number;
	updated_at?: string;
	updated_by?: string;
	updated_by_name?: string | null;
};
