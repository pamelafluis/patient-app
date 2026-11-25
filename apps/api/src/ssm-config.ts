import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ConfigError, parseConfig, type AppConfig, type ConfigProvider } from "./config.ts";

export interface SsmParamNames {
  baseUrl: string;
  token: string;
  cursorKey: string;
}

export const DEFAULT_PARAM_NAMES: SsmParamNames = {
  baseUrl: "/patient-app/fhir/base-url",
  token: "/patient-app/fhir/token",
  cursorKey: "/patient-app/cursor-key",
};

/** The subset of SSMClient we use, so tests can pass a fake. */
export interface SsmLike {
  send(cmd: GetParametersCommand): Promise<{ Parameters?: { Name?: string; Value?: string }[] }>;
}

export interface SsmConfigOptions {
  names?: SsmParamNames;
  client?: SsmLike;
  demoAsOf?: string;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Reads config from SSM Parameter Store and caches it for 5 minutes. `get(true)` bypasses the
 * cache (used once after an upstream 401). The token parameter is optional: if it is missing, or
 * holds the placeholder "none", no Authorization header is sent.
 */
export function ssmConfigProvider(opts: SsmConfigOptions = {}): ConfigProvider {
  const names = opts.names ?? DEFAULT_PARAM_NAMES;
  const client: SsmLike = opts.client ?? new SSMClient({});
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; cfg: AppConfig } | undefined;
  let inflight: Promise<AppConfig> | undefined;

  async function load(): Promise<AppConfig> {
    const res = await client.send(
      new GetParametersCommand({ Names: [names.baseUrl, names.token, names.cursorKey], WithDecryption: true }),
    );
    const byName = new Map((res.Parameters ?? []).map((p) => [p.Name, p.Value]));
    const rawToken = byName.get(names.token)?.trim();
    const cfg = parseConfig({
      FHIR_BASE_URL: byName.get(names.baseUrl),
      FHIR_BEARER_TOKEN: rawToken && rawToken.toLowerCase() !== "none" ? rawToken : undefined,
      CURSOR_KEY: byName.get(names.cursorKey),
      DEMO_AS_OF: opts.demoAsOf,
    });
    cached = { at: now(), cfg };
    return cfg;
  }

  return {
    async get(force = false) {
      if (!force && cached && now() - cached.at < ttl) return cached.cfg;
      // Concurrent callers share one SSM read.
      inflight ??= load()
        .catch((e) => {
          if (e instanceof ConfigError) throw e;
          // Never surface AWS error text (it can contain parameter names or account details).
          console.error("config load failed", e instanceof Error ? e.name : "unknown");
          throw new ConfigError("Could not read configuration");
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
