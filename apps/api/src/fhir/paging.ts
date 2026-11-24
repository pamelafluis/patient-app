/**
 * FHIR servers return opaque `next` links. We never hand them to the browser
 * raw: they are checked against the configured server, then signed, so a
 * client cannot make the API fetch an arbitrary address.
 */

export class CursorError extends Error {}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** Throws unless `link` is on the same origin and under the same path as the base URL. */
export function assertSameServer(link: string, baseUrl: string): URL {
  let u: URL;
  const base = new URL(baseUrl);
  try {
    u = new URL(link);
  } catch {
    throw new CursorError("Invalid paging link");
  }
  // Servers behind a TLS-terminating proxy often emit http:// links. Upgrade
  // to https when the host matches; never downgrade, so the token stays encrypted.
  if (u.protocol === "http:" && base.protocol === "https:" && u.host === base.host) u.protocol = "https:";
  const basePath = base.pathname.replace(/\/+$/, "");
  const pathOk = u.pathname === basePath || u.pathname === basePath + "/" || u.pathname.startsWith(basePath + "/");
  if (u.origin !== base.origin || !pathOk || u.username || u.password) {
    throw new CursorError("Paging link does not belong to the configured FHIR server");
  }
  return u;
}

export async function signCursor(nextLink: string, baseUrl: string, secret: string): Promise<string> {
  const u = assertSameServer(nextLink, baseUrl);
  const payload = b64url(enc.encode(u.toString()));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Returns the upstream URL, or throws CursorError if unsigned, altered or foreign. */
export async function verifyCursor(cursor: string, baseUrl: string, secret: string): Promise<string> {
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new CursorError("Invalid cursor");
  const [payload, sig] = parts as [string, string];
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromB64url(sig), enc.encode(payload));
  } catch {
    throw new CursorError("Invalid cursor");
  }
  if (!ok) throw new CursorError("Invalid cursor");
  const url = new TextDecoder().decode(fromB64url(payload));
  return assertSameServer(url, baseUrl).toString();
}

/** Extracts the `next` relation from a searchset Bundle, if any. */
export function nextLinkOf(bundle: { link?: { relation?: string; url?: string }[] }): string | undefined {
  return bundle.link?.find((l) => l.relation === "next")?.url;
}
