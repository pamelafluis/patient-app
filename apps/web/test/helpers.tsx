
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";


export function renderApp(ui: ReactElement, route = "/patients") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <Notifications />
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

export interface Call {
  method: string;
  url: URL;
  body: any;
}
type Handler = (call: Call) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/** Replaces fetch with a stub. Handlers are looked up by "METHOD /path". */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const handler = routes[`${call.method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ message: "no handler" }), { status: 500 });
    const { status = 200, body } = await handler(call);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

export const patient = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `p${n}`,
  displayName: `Family${n}, Given${n}`,
  gender: "female",
  birthDate: "1990-05-01",
  age: 36,
  ...extra,
});

export const detail = (extra: Record<string, unknown> = {}) => ({
  ...patient(1),
  given: "Given1",
  family: "Family1",
  version: 'W/"3"',
  ...extra,
});
