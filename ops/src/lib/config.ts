// Reading configuration: settings from the `config` table, secrets from the
// Worker's bindings. The two never mix: a secret key is refused by every
// Config reader, and `secret()` refuses a setting.
//
// Port of the old per-module `configValue_(key, default)` (src/Auth.gs:38 and
// six copies): a missing row, a NULL (the Sheet's empty cell) or '' gives the
// default; anything else comes back exactly as stored, with no trimming.
//
// `loadConfig` is called once per request and returns a frozen snapshot. There
// is no module-level cache: a Worker serves many requests, and a changed
// setting must show on the next one.
//
// Error messages name keys and binding names only, never a value.
import type { Db } from "../db/client";
import { SECRET_KEYS, configKeySpec, type ConfigKey, type ConfigKeySpec } from "./config-keys";

export class UnknownConfigKeyError extends Error {
  constructor(key: string) {
    super(`"${key}" is not a known config key (see src/lib/config-keys.ts)`);
    this.name = "UnknownConfigKeyError";
  }
}

export class SecretInConfigError extends Error {
  constructor(key: string) {
    super(`"${key}" is a secret: read it with secret(env, "${key}"), never from the config table`);
    this.name = "SecretInConfigError";
  }
}

export class SettingAsSecretError extends Error {
  constructor(key: string) {
    super(`"${key}" is a setting, not a secret: read it from the config table`);
    this.name = "SettingAsSecretError";
  }
}

export class MissingSecretError extends Error {
  readonly binding: string;
  constructor(binding: string) {
    super(`Secret binding ${binding} is missing or empty`);
    this.name = "MissingSecretError";
    this.binding = binding;
  }
}

function settingSpec(key: string): ConfigKeySpec {
  const spec = configKeySpec(key);
  if (!spec) throw new UnknownConfigKeyError(key);
  if (spec.kind === "secret") throw new SecretInConfigError(key);
  return spec;
}

export interface ConfigRow {
  readonly key: string;
  readonly value: string | null;
}

export class Config {
  readonly #rows: ReadonlyMap<string, string | null>;

  private constructor(rows: ReadonlyMap<string, string | null>) {
    this.#rows = rows;
    Object.freeze(this);
  }

  /** A snapshot of the given rows (copied). `loadConfig` is the normal way in; tests use this directly. */
  static fromRows(rows: Iterable<ConfigRow>): Config {
    const map = new Map<string, string | null>();
    for (const r of rows) map.set(r.key, r.value);
    return new Config(map);
  }

  /**
   * The old `configValue_`: the stored text exactly as stored, or the default
   * (the caller's, else the registry's) when the row is missing, NULL or ''.
   * A single space is a value.
   */
  value(key: ConfigKey, defaultValue?: string): string {
    const spec = settingSpec(key);
    const stored = this.#rows.get(key);
    if (stored !== undefined && stored !== null && stored !== "") return stored;
    return defaultValue !== undefined ? defaultValue : spec.default;
  }

  /**
   * `Number(configValue_(key, D)) || D` (src/Auth.gs:97 and ten more sites):
   * blank, non-numeric and an explicit 0 all give the default; a negative or
   * fractional number is kept.
   */
  number(key: ConfigKey, defaultValue?: number): number {
    const fallbackText = defaultValue !== undefined ? String(defaultValue) : settingSpec(key).default;
    return Number(this.value(key, fallbackText)) || Number(fallbackText);
  }

  /**
   * `raw === true || String(raw).toLowerCase() === 'true'` (src/Clover.gs:29,
   * src/Notifier.gs:36). Case-insensitive, no trimming; '1' is not true.
   */
  boolean(key: ConfigKey, defaultValue?: boolean | string): boolean {
    const fallbackText = defaultValue !== undefined ? String(defaultValue) : settingSpec(key).default;
    return this.value(key, fallbackText).toLowerCase() === "true";
  }

  /** `String(raw || '').split(/[,;\s]+/).map(trim).filter(Boolean)` (src/Notifier.gs:143). */
  list(key: ConfigKey, defaultValue?: string): string[] {
    return this.value(key, defaultValue)
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Registry secret keys that have a non-blank row in the table: names only, in registry order. */
  secretsFoundInTable(): string[] {
    return SECRET_KEYS.filter((key) => {
      const v = this.#rows.get(key);
      return typeof v === "string" && v.trim() !== "";
    });
  }
}

/** One query for the whole table; an immutable snapshot for the current request. */
export async function loadConfig(db: Db): Promise<Config> {
  const rows = await db.query<ConfigRow>("select key, value from ops.config");
  return Config.fromRows(rows);
}

function bindingFor(key: string): string {
  const spec = configKeySpec(key);
  if (!spec) throw new UnknownConfigKeyError(key);
  if (spec.kind !== "secret") throw new SettingAsSecretError(key);
  return key.toUpperCase();
}

/** The Worker secret for a registry secret key, or null when absent, empty or not a string. */
export function maybeSecret(env: Readonly<Record<string, unknown>>, key: ConfigKey): string | null {
  const binding = bindingFor(key);
  const v = env[binding];
  return typeof v === "string" && v !== "" ? v : null;
}

/** As `maybeSecret`, but throws MissingSecretError (binding name only) when there is none. */
export function secret(env: Readonly<Record<string, unknown>>, key: ConfigKey): string {
  const v = maybeSecret(env, key);
  if (v === null) throw new MissingSecretError(key.toUpperCase());
  return v;
}

