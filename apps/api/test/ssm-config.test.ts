import { describe, expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { ConfigError } from "../src/config.ts";
import { DEFAULT_PARAM_NAMES as N, ssmConfigProvider, type SsmLike } from "../src/ssm-config.ts";

const KEY = "k".repeat(40);
function fake(values: Record<string, string>, calls = { n: 0 }): SsmLike & { calls: { n: number } } {
  return {
    calls,
    async send() {
      calls.n++;
      return { Parameters: Object.entries(values).map(([Name, Value]) => ({ Name, Value })) };
    },
  };
}
const base = { [N.baseUrl]: "https://fhir.example.org/r4/", [N.cursorKey]: KEY };

describe("ssmConfigProvider", () => {
  test("reads and normalizes the three parameters", async () => {
    const cfg = await ssmConfigProvider({ client: fake({ ...base, [N.token]: " abc " }) }).get();
    expect(cfg.fhir).toEqual({ baseUrl: "https://fhir.example.org/r4", token: "abc" });
    expect(cfg.cursorKey).toBe(KEY);
  });

  test("missing or 'none' token means no Authorization header", async () => {
    expect((await ssmConfigProvider({ client: fake(base) }).get()).fhir.token).toBeUndefined();
    expect((await ssmConfigProvider({ client: fake({ ...base, [N.token]: "None" }) }).get()).fhir.token).toBeUndefined();
  });

  test("caches for 5 minutes, and force bypasses the cache", async () => {
    let t = 0;
    const c = fake(base);
    const p = ssmConfigProvider({ client: c, now: () => t });
    await p.get();
    t = 299_000;
    await p.get();
    expect(c.calls.n).toBe(1);
    await p.get(true);
    expect(c.calls.n).toBe(2);
    t = 299_000 + 301_000;
    await p.get();
    expect(c.calls.n).toBe(3);
  });

  test("concurrent callers share one read", async () => {
    const c = fake(base);
    const p = ssmConfigProvider({ client: c });
    await Promise.all([p.get(), p.get(), p.get()]);
    expect(c.calls.n).toBe(1);
  });

  test("invalid values and AWS failures become ConfigError without leaking details", async () => {
    await expect(ssmConfigProvider({ client: fake({ [N.cursorKey]: KEY, [N.baseUrl]: "http://insecure.example.org" }) }).get()).rejects.toBeInstanceOf(ConfigError);
    const failing: SsmLike = { send: async () => { throw new Error("AccessDenied arn:aws:ssm:secret-details"); } };
    const err = await ssmConfigProvider({ client: failing }).get().catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).not.toContain("arn:");
  });

  test("a bad setting is logged by name, without its value", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = ssmConfigProvider({ client: fake({ ...base, [N.baseUrl]: "http://insecure.example.org" }) });
      const res = await createApp({ config }).request("/api/patients");
      expect(res.status).toBe(500);
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("FHIR_BASE_URL must use https");
      expect(logged).not.toContain("insecure.example.org");
    } finally {
      log.mockRestore();
    }
  });

  test("a failed load is retried next time", async () => {
    let fail = true;
    const client: SsmLike = { send: async () => (fail ? Promise.reject(new Error("x")) : { Parameters: Object.entries(base).map(([Name, Value]) => ({ Name, Value })) }) };
    const p = ssmConfigProvider({ client });
    await expect(p.get()).rejects.toBeInstanceOf(ConfigError);
    fail = false;
    expect((await p.get()).fhir.baseUrl).toBe("https://fhir.example.org/r4");
  });
});
