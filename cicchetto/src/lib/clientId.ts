const STORAGE_KEY = "grappa.client_id";

export function getOrCreateClientId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const fresh = generateUUIDv4();
  localStorage.setItem(STORAGE_KEY, fresh);
  return fresh;
}

// `crypto.randomUUID` is only available in secure contexts (HTTPS or
// localhost). The bouncer runs on plain HTTP behind nginx until Phase 5
// hardening lands TLS, so on `http://grappa.bad.ass` the call throws
// `crypto.randomUUID is not a function` and login becomes impossible.
// `crypto.getRandomValues` IS available on insecure origins, so we
// build the v4 UUID byte-shape by hand when the convenience method is
// missing. Both paths produce RFC 4122-compliant v4 UUIDs.
function generateUUIDv4(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
