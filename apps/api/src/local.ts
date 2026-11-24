import { createApp } from "./app.ts";
import { envConfigProvider } from "./config.ts";

// Local development only: no login. Refuses to run inside Lambda.
if (process.env.AWS_LAMBDA_FUNCTION_NAME) throw new Error("local.ts must not run on Lambda");

const app = createApp({ config: envConfigProvider() });
const port = Number(process.env.PORT ?? 8787);
Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`API listening on http://127.0.0.1:${port}`);
