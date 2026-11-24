import type { FhirError } from "./fhir/client.ts";

const MESSAGES = {
  auth: [502, "FHIR credentials rejected"],
  conflict: [409, "This record changed since you opened it"],
  "not-found": [404, "Patient not found"],
  throttled: [503, "The FHIR server is busy. Try again shortly."],
  timeout: [504, "The FHIR server timed out"],
  upstream: [502, "The FHIR server returned an error"],
} as const;

/** Status and message for an upstream failure. Messages are ours; upstream text and headers are never echoed. */
export function describeFhirError(err: FhirError): { status: 409 | 404 | 502 | 503 | 504; message: string } {
  const [status, message] = MESSAGES[err.kind];
  return { status, message };
}
