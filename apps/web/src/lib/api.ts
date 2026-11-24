import type { PatientDetail, PatientPage } from "@patient-app/shared";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: any) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("Can't reach the server", 0, null);
  }
  const body = await res.json().catch(() => null);
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
  createPatient: (input: unknown) => call<PatientDetail>("/api/patients", { method: "POST", body: JSON.stringify(input) }),
  updatePatient: (id: string, input: unknown) =>
    call<PatientDetail & { conflictProtection: boolean }>(`/api/patients/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
};
