import type { ChartSummary, HistoryPage, HistorySection, PatientDetail, PatientPage, VitalHistory, VitalKind } from "@patient-app/shared";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: any) {
    super(message);
  }
}

// Set by the login gate; unset in local development, where /api is open.
let handlers: { getToken: () => string | undefined; onUnauthorized: () => void } = { getToken: () => undefined, onUnauthorized: () => {} };
export function setAuthHandlers(h: typeof handlers) {
  handlers = h;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = handlers.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    res = await fetch(path, { ...init, headers });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("Can't reach the server", 0, null);
  }
  const body = await res.json().catch(() => null);
  // API Gateway answers 401 itself when the session has expired; sign in again.
  if (res.status === 401) handlers.onUnauthorized();
  if (!res.ok) throw new ApiError(body?.message ?? `Request failed (${res.status})`, res.status, body);
  return body as T;
}

export const api = {
  listPatients: (p: { name?: string; cursor?: string }, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (p.name) q.set("name", p.name);
    if (p.cursor) q.set("cursor", p.cursor);
    return call<PatientPage>(`/api/patients?${q}`, { signal });
  },
  getPatient: (id: string) => call<PatientDetail>(`/api/patients/${encodeURIComponent(id)}`),
  getSummary: (id: string, signal?: AbortSignal) => call<ChartSummary>(`/api/patients/${encodeURIComponent(id)}/summary`, { signal }),
  getVitals: (id: string, kind: VitalKind, cursor?: string, signal?: AbortSignal) =>
    call<VitalHistory>(`/api/patients/${encodeURIComponent(id)}/vitals/${kind}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal }),
  getHistory: (id: string, section: HistorySection, cursor?: string, signal?: AbortSignal) =>
    call<HistoryPage>(`/api/patients/${encodeURIComponent(id)}/history/${section}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal }),
  createPatient: (input: unknown) => call<PatientDetail>("/api/patients", { method: "POST", body: JSON.stringify(input) }),
  updatePatient: (id: string, input: unknown) =>
    call<PatientDetail & { conflictProtection: boolean }>(`/api/patients/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
};
