export interface FhirConfig {
  /** Base URL without a trailing slash, e.g. https://hapi.fhir.org/baseR4 */
  baseUrl: string;
  /** Optional bearer token. Absent means no Authorization header is sent. */
  token?: string;
}

export interface AppConfig {
  fhir: FhirConfig;
  cursorKey: string;
  /** Optional "today" override (YYYY-MM-DD) for demos on old sandbox data. */
  demoAsOf?: string;
}

/** Where configuration comes from: .env locally, SSM Parameter Store on AWS. */
export interface ConfigProvider {
  /** `force` bypasses any cache, used after an upstream 401. */
  get(force?: boolean): Promise<AppConfig>;
}

export class ConfigError extends Error {}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("FHIR_BASE_URL is not a valid URL");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ConfigError("FHIR_BASE_URL must use https (http is allowed only for localhost)");
  }
  if (url.username || url.password) throw new ConfigError("FHIR_BASE_URL must not contain credentials");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const baseUrl = normalizeBaseUrl(env.FHIR_BASE_URL ?? "");
  const token = env.FHIR_BEARER_TOKEN?.trim() || undefined;
  const cursorKey = env.CURSOR_KEY?.trim() ?? "";
  if (cursorKey.length < 32) throw new ConfigError("CURSOR_KEY must be at least 32 characters");
  const demoAsOf = env.DEMO_AS_OF?.trim() || undefined;
  if (demoAsOf && !/^\d{4}-\d{2}-\d{2}$/.test(demoAsOf)) throw new ConfigError("DEMO_AS_OF must be YYYY-MM-DD");
  return { fhir: { baseUrl, token }, cursorKey, demoAsOf };
}

/** Reads process.env on every call, so tests and local runs need no cache. */
export function envConfigProvider(env: Record<string, string | undefined> = process.env): ConfigProvider {
  return { get: async () => parseConfig(env) };
}
