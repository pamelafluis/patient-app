import { describe, expect, test } from "bun:test";
import { api, ApiError } from "../src/lib/api.ts";

describe("api client", () => {
  test("a network failure becomes a friendly error", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await api.listPatients({}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Can't reach the server");
    expect(err.status).toBe(0);
  });

  test("server errors keep their message, status and body", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "conflict", message: "Changed", current: { id: "1" } }), { status: 409 })) as unknown as typeof fetch;
    const err = await api.getPatient("1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toBe("Changed");
    expect(err.body.current.id).toBe("1");
  });

  test("sends name and cursor as query parameters", async () => {
    let seen = "";
    globalThis.fetch = (async (u: any) => {
      seen = String(u);
      return new Response("{}");
    }) as unknown as typeof fetch;
    await api.listPatients({ name: "ada lo", cursor: "abc" });
    expect(new URL(seen, "http://x").searchParams.get("name")).toBe("ada lo");
    expect(new URL(seen, "http://x").searchParams.get("cursor")).toBe("abc");
  });
});
