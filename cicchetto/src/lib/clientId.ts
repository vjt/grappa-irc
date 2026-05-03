// Per-browser stable identity for the T31 admission-control session
// caps (`X-Client-Id` header). The bouncer fingerprints visitors by
// `(ip, client_id)` to scope per-browser caps independently of the
// per-IP cap; the UUID is generated on first load and persisted in
// localStorage so the same browser keeps the same identity across
// reloads, PWA cold-starts, and "Add to Home Screen" launches.

const STORAGE_KEY = "grappa-client-id";
const VERSION_KEY = "grappa-client-id-version";
const CURRENT_VERSION = "v1";

// L-cic-3 — pre-B2.6 the key was `grappa.client_id`. Renamed to use
// hyphens (matching `grappa-token` and `grappa-subject`); migration
// preserves the existing UUID on first read so admission-control
// session-cap denominators don't briefly inflate after deploy. Drop
// after Phase 5 when log analysis confirms no clients still report
// the legacy key.
const LEGACY_STORAGE_KEY = "grappa.client_id";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// L-cic-1 — Safari Private Browsing zero-quotas localStorage; some
// embedded WebViews scrub it on session end; SecurityError can fire on
// `localStorage.getItem` when the user disables site data. In every
// failure mode we fall back to a process-local UUID so the current tab
// at least has a stable identity for its lifetime — no re-roll on
// every API call. Module-level (not closure-scoped) so re-imports
// during tests can reset it via `__resetClientIdMemoryFallback`.
let memoryFallback: string | null = null;

export function getOrCreateClientId(): string {
  try {
    // L-cic-2 — version key gates the storage-key shape. If a future
    // hardening pass changes the persisted format, bump
    // `CURRENT_VERSION` and stale entries are silently re-rolled
    // instead of half-parsed. Mismatched-or-missing version → wipe.
    const storedVersion = localStorage.getItem(VERSION_KEY);
    if (storedVersion !== CURRENT_VERSION) {
      localStorage.removeItem(STORAGE_KEY);
    }

    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing !== null && UUID_V4_REGEX.test(existing)) return existing;

    // First-read migration from `grappa.client_id`. Preserves identity
    // across the L-cic-3 rename so the per-browser session-cap
    // denominator doesn't inflate post-deploy.
    const migrated = migrateLegacy();
    if (migrated !== null) return migrated;

    const fresh = generateUUIDv4();
    try {
      localStorage.setItem(STORAGE_KEY, fresh);
      localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
    } catch (_) {
      memoryFallback ??= fresh;
      return memoryFallback;
    }
    return fresh;
  } catch (_) {
    // localStorage.getItem itself threw (SecurityError on
    // privacy-restricted browsers, or DOMException on some embedded
    // WebViews). The whole storage path is unusable — pin to memory.
    memoryFallback ??= generateUUIDv4();
    return memoryFallback;
  }
}

function migrateLegacy(): string | null {
  let legacy: string | null;
  try {
    legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch (_) {
    return null;
  }
  if (legacy === null || !UUID_V4_REGEX.test(legacy)) return null;
  try {
    localStorage.setItem(STORAGE_KEY, legacy);
    localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (_) {
    // Migration writes failed — return the legacy value without
    // persisting; next call may retry. Identity is preserved for this
    // tab session at the cost of a re-migration attempt next load.
  }
  return legacy;
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

// Test-only: the in-memory fallback is module-scoped so it survives
// across `localStorage.clear()` + re-call. `vi.resetModules()` would
// rebuild the module, but it's heavy and not the existing test
// pattern here. Instead expose a narrow reset hook prefixed with `__`
// (not part of the production API).
export function __resetClientIdMemoryFallback(): void {
  memoryFallback = null;
}
