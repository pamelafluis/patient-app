import { handle } from "hono/aws-lambda";
import { createApp } from "./app.ts";
import { DEFAULT_PARAM_NAMES, ssmConfigProvider } from "./ssm-config.ts";

// Same Hono app as local.ts; only the config source and the entry point differ.
// Login is enforced by the API Gateway JWT authorizer before this function runs.
const param = (key: string, fallback: string) => process.env[key] || fallback;

const app = createApp({
  config: ssmConfigProvider({
    names: {
      baseUrl: param("SSM_FHIR_BASE_URL", DEFAULT_PARAM_NAMES.baseUrl),
      token: param("SSM_FHIR_TOKEN", DEFAULT_PARAM_NAMES.token),
      cursorKey: param("SSM_CURSOR_KEY", DEFAULT_PARAM_NAMES.cursorKey),
    },
    demoAsOf: process.env.DEMO_AS_OF || undefined,
  }),
});

export const handler = handle(app);
