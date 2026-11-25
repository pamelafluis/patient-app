import { Hono } from "hono";
import { createPatientInputSchema, MAX_TZ_OFFSET_HOURS, todayIn } from "@patient-app/shared";
import type { ConfigProvider } from "./config.ts";
import { ConfigError } from "./config.ts";
import { describeFhirError } from "./errors.ts";
import { FhirClient, FhirError } from "./fhir/client.ts";
import { CursorError } from "./fhir/paging.ts";
import { chartRoutes } from "./routes/chart.ts";
import { patientRoutes } from "./routes/patients.ts";

export interface AppOptions {
  config: ConfigProvider;
  fetch?: typeof fetch;
  now?: () => Date;
  retryDelayMs?: number;
}

/** Assembles the app: shared middleware, the error handler and the route modules in routes/. */
export function createApp(opts: AppOptions) {
  const now = opts.now ?? (() => new Date());
  const fhir = new FhirClient({ config: opts.config, fetch: opts.fetch, retryDelayMs: opts.retryDelayMs });
  const app = new Hono();

  // DEMO_AS_OF overrides "today" so old sandbox data still looks current.
  const today = async () => (await opts.config.get()).demoAsOf ?? todayIn(now(), 0);
  const writeSchema = createPatientInputSchema({ now, tzOffsetHours: MAX_TZ_OFFSET_HOURS });

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.onError((err, c) => {
    // Messages are chosen here; upstream headers and tokens are never echoed.
    if (err instanceof CursorError) return c.json({ error: "cursor", message: "That page link is no longer valid." }, 400);
    if (err instanceof ConfigError) {
      // ConfigError messages are fixed text from our code, never setting values, so they are safe to log.
      console.error("config error:", err.message);
      return c.json({ error: "config", message: "Server configuration is invalid." }, 500);
    }
    if (err instanceof FhirError) {
      const { status, message } = describeFhirError(err);
      return c.json({ error: err.kind, message }, status);
    }
    console.error("unexpected error", err instanceof Error ? err.name : "unknown");
    return c.json({ error: "internal", message: "Something went wrong." }, 500);
  });

  app.route("/", patientRoutes({ config: opts.config, fhir, today, writeSchema }));
  app.route("/", chartRoutes({ config: opts.config, fhir, today }));

  return app;
}
