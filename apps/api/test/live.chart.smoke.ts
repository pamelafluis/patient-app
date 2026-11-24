// Manual read-only smoke test of the chart routes: bun apps/api/test/live.chart.smoke.ts [baseUrl]
// GET requests only (not part of `bun test`). Uses synthetic public data.
import { createApp } from "../src/app.ts";
import { envConfigProvider } from "../src/config.ts";

const base = process.argv[2] ?? "https://r4.smarthealthit.org";
const app = createApp({ config: envConfigProvider({ FHIR_BASE_URL: base, CURSOR_KEY: "x".repeat(40) }) });
const get = async (path: string) => {
  const t = performance.now();
  const res = await app.request(path);
  return { status: res.status, ms: Math.round(performance.now() - t), body: (await res.json()) as any };
};

const list = await get("/api/patients");
console.log("list", list.status, list.ms + "ms", list.body.items?.length, "patients");
let withBp = 0;
for (const p of list.body.items.slice(0, 6)) {
  const s = await get(`/api/patients/${p.id}/summary`);
  const v = s.body.vitals;
  const got = v.status === "ok" ? Object.entries(v.data).filter(([, r]) => r).map(([k, r]: any) => `${k}=${r.text}${r.unit}@${r.date?.slice(0, 10)}`) : [`vitals ${v.message}`];
  if (v.status === "ok" && v.data.bp) withBp++;
  console.log(p.id, s.status, s.ms + "ms", "|", got.join(" "), "| conditions", s.body.conditions.status === "ok" ? s.body.conditions.data.items.length : "ERR", "| meds", s.body.medications.status === "ok" ? s.body.medications.data.items.length : "ERR");
  if (v.status === "ok" && v.data.bp) {
    const t = await get(`/api/patients/${p.id}/vitals/bp`);
    console.log("   bp trend", t.status, t.body.readings?.length, "readings, next:", !!t.body.nextCursor);
  }
  for (const section of ["conditions", "medications", "allergies", "encounters", "procedures", "immunizations"]) {
    const h = await get(`/api/patients/${p.id}/history/${section}`);
    process.stdout.write(`   ${section}:${h.status === 200 ? h.body.items.length + (h.body.nextCursor ? "+" : "") : "ERR" + h.status}`);
  }
  console.log();
}
console.log("patients with BP in sample:", withBp);
