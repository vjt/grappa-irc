// Pluggable upload-host transport — images cluster I-1 (2026-05-15),
// generalized to video + document categories (uploads cluster Task 4,
// 2026-06-09; formerly `image-upload.ts` / `ImageHost`).
//
// Defines an `UploadHost` interface that abstracts the multipart upload
// to a public file-hosting service, and ships the litterbox.catbox.moe
// implementation (`litterboxHost`) + the embedded grappa-serves-it
// implementation (`embeddedHost`, UX-6-B2 2026-05-21).
//
// Why an interface (not just a litterbox-specific helper). litterbox's
// API differs in shape from every other plausible provider (imgur
// returns JSON + needs a Client-ID bearer; 0x0.st gates TTL via a
// header; catbox-permanent uses a userhash). The interface encodes
// the dimensions on which providers vary — endpoint, request shape,
// response shape, TTL options, per-category MIME accept lists + size
// caps, retention copy — so swapping providers tomorrow is "write a
// second impl, swap `activeHost()`" with zero changes downstream.
//
// IRC stays text-only. The only thing this module produces is a
// public URL string; how that URL gets into a PRIVMSG body
// (`📸 <url>`) is I-2's job. There is no inline image rendering
// anywhere in cic. See CLAUDE.md "IRC stays text only" rule (added
// in I-3).
//
// XMLHttpRequest, not fetch. fetch's Response stream lacks upload
// progress events across the browser targets we care about; XHR's
// `upload.addEventListener("progress")` is the only way to drive a
// multi-MB iPhone screenshot's progress bar in real time.
//
// CORS preflight gotcha: attaching a listener to `XMLHttpRequestUpload`
// promotes the request from "simple" to "non-simple" CORS, triggering
// an OPTIONS preflight even when the body itself (multipart/form-data)
// would not. Hosts that do not advertise CORS preflight headers
// (litterbox.catbox.moe — empirically tested 2026-05-16) reject the
// preflight and the actual POST never fires; cic surfaces "network
// error" with no useful diagnostic. The `supportsProgress` flag on
// `UploadHost` documents this per-host posture: when `false`, the
// progress listener is NOT attached and uploads use the simple CORS
// path. UI falls back to indeterminate progress (`<progress>` with
// no value attribute renders as indeterminate per HTML spec).

import { serverSettings } from "./serverSettings";
import {
  AUDIO_MIMES,
  DOCUMENT_MIMES_OFFICE,
  DOCUMENT_MIMES_PORTABLE,
  IMAGE_MIMES,
  type UploadCategory,
  VIDEO_MIMES,
} from "./uploadCategory";

export type UploadProgress = { loaded: number; total: number };

export type UploadError =
  | { kind: "network" }
  | { kind: "http"; status: number; body: string }
  | { kind: "abort" }
  | { kind: "invalid_response"; body: string }
  | { kind: "provider"; message: string };

export type TtlOption = {
  /** Host-specific token spelling (e.g. `"24h"` for litterbox's form
   *  `time=` field). What the host's `upload()` actually sends. */
  value: string;
  /** UI label (e.g. `"24 hours"`). */
  label: string;
  /** UX-4 bucket M (2026-05-19) — integer seconds equivalent of `value`.
   *  The server-side preference is stored as an integer (seconds); cic
   *  translates between the host token and seconds at the SettingsDrawer
   *  boundary so the server stays oblivious to per-host token spellings.
   *  Used by `uploadOrchestrator` to pick a matching `value` from
   *  the active host's ladder given a stored-seconds preference. */
  seconds: number;
};

export type UploadOptions = {
  /** A `value` from the host's `ttlOptions`. Falls back to
   *  `host.defaultTtl` when omitted (or omitted from the wire when the
   *  host doesn't expose TTL choices). */
  ttl?: string;
};

export interface UploadHost {
  /** Stable identifier — used as a localStorage key suffix
   *  (`image-upload-privacy-acknowledged:<id>`) so per-host UI state
   *  doesn't leak across providers. */
  readonly id: string;
  /** Hostname or short label, surfaced in the privacy modal. */
  readonly displayName: string;
  /** Privacy-modal sentence fragment after "Files you upload here go
   *  to {displayName} — ". Includes retention window + audience. */
  readonly retentionStatement: string;
  /** TTL choices for the upload UI dropdown. Empty → dropdown hidden
   *  entirely (e.g. imgur, where uploads are permanent until manual
   *  delete). */
  readonly ttlOptions: ReadonlyArray<TtlOption>;
  /** Default TTL — must match a `ttlOptions.value`, or be null when
   *  `ttlOptions` is empty. */
  readonly defaultTtl: string | null;
  /** Per-category MIME types fed into `<input accept>` and the
   *  drag-drop / paste gate. A host that cannot take a category lists
   *  it empty — `categoryOf()` (uploadCategory.ts) is the global
   *  MIME→category map; this record is the per-host subset. */
  readonly acceptedMimeTypes: Readonly<Record<UploadCategory, ReadonlyArray<string>>>;
  /** Client-side pre-check ceiling per category. `null` = unknown /
   *  no enforced cap (still gated by the host's actual upload limit
   *  on rejection). Function, not literal: the embedded host reads
   *  the reactive serverSettings() signal so admin-tuned caps apply
   *  live. */
  maxFileSizeBytes(category: UploadCategory): number | null;
  /** Whether attaching an `xhr.upload` progress listener is safe with
   *  this host's CORS posture. `false` → host does not advertise CORS
   *  preflight headers, so attaching the listener (which promotes the
   *  request to "non-simple" and triggers an OPTIONS preflight) makes
   *  every upload fail. The progress bar falls back to indeterminate.
   *  See the moduledoc note on the CORS preflight gotcha. */
  readonly supportsProgress: boolean;

  /** Upload `file`, resolving with the public URL string. Provider
   *  decides request body shape, headers, and response parsing.
   *  Implementations MUST honour `signal` (immediate rejection if
   *  pre-aborted; abort the in-flight XHR otherwise) and call
   *  `onProgress` for every upload-progress event the transport
   *  emits. */
  upload(
    file: File,
    options: UploadOptions,
    onProgress: (p: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<string>;
}

// --------------------------------------------------------------------
// Internal — XHR plumbing shared across providers.
//
// Keeps the abort + progress + error wiring in one place; each
// provider's `upload` only has to: build a FormData body, set any
// custom headers, dispatch via `xhrUpload`, and parse the response
// text into a URL string (or a typed UploadError).
// --------------------------------------------------------------------

type ResponseParser = (status: number, body: string) => string | UploadError;

export type XhrUploadArgs = {
  url: string;
  body: FormData;
  headers?: Record<string, string>;
  onProgress: (p: UploadProgress) => void;
  signal: AbortSignal;
  parseResponse: ResponseParser;
  /** Mirror of `UploadHost.supportsProgress`. When `false`, the
   *  `xhr.upload` progress listener is NOT attached so the request
   *  stays a "simple" CORS request and avoids the OPTIONS preflight
   *  that hosts like litterbox cannot answer. */
  supportsProgress: boolean;
};

export function xhrUpload(args: XhrUploadArgs): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (args.signal.aborted) {
      reject({ kind: "abort" } satisfies UploadError);
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", args.url);
    if (args.headers) {
      for (const [k, v] of Object.entries(args.headers)) xhr.setRequestHeader(k, v);
    }

    if (args.supportsProgress) {
      xhr.upload.addEventListener("progress", (ev) => {
        args.onProgress({ loaded: ev.loaded, total: ev.total });
      });
    }

    xhr.addEventListener("load", () => {
      const result = args.parseResponse(xhr.status, xhr.responseText);
      if (typeof result === "string") resolve(result);
      else reject(result);
    });

    xhr.addEventListener("error", () => {
      reject({ kind: "network" } satisfies UploadError);
    });

    xhr.addEventListener("abort", () => {
      reject({ kind: "abort" } satisfies UploadError);
    });

    args.signal.addEventListener("abort", () => {
      xhr.abort();
    });

    xhr.send(args.body);
  });
}

// --------------------------------------------------------------------
// litterbox.catbox.moe — temporary image host, no auth, multipart in
// + plain-text URL out. Response URL host is `litter.catbox.moe`
// (verified empirically during I-CSP — see infra/snippets/security-
// headers.conf moduledoc).
// --------------------------------------------------------------------

const LITTERBOX_ENDPOINT = "https://litterbox.catbox.moe/resources/internals/api.php";

const URL_PATTERN = /^https?:\/\/\S+$/;

function parseLitterboxResponse(status: number, body: string): string | UploadError {
  if (status < 200 || status >= 300) {
    return { kind: "http", status, body };
  }
  const trimmed = body.trim();
  if (trimmed === "" || !URL_PATTERN.test(trimmed)) {
    return { kind: "invalid_response", body: trimmed };
  }
  return trimmed;
}

export const litterboxHost: UploadHost = {
  id: "litterbox",
  displayName: "litterbox.catbox.moe",
  retentionStatement:
    "a public temporary host. Anyone with the URL can view files there for the next 24 hours.",
  ttlOptions: [
    { value: "1h", label: "1 hour", seconds: 3600 },
    { value: "12h", label: "12 hours", seconds: 43_200 },
    { value: "24h", label: "24 hours", seconds: 86_400 },
    { value: "72h", label: "72 hours", seconds: 259_200 },
  ],
  defaultTtl: "24h",
  acceptedMimeTypes: {
    image: IMAGE_MIMES,
    video: VIDEO_MIMES,
    // litterbox blocks .doc* host-side (FAQ, verified 2026-06-09) —
    // office formats are embedded-only.
    document: DOCUMENT_MIMES_PORTABLE,
    audio: AUDIO_MIMES,
  },
  // Litterbox accepts up to ~1GiB but cic's practical ceilings are
  // much lower — phone screenshots / short transcoded clips are the
  // realistic upper bound; the per-category caps are generous + let
  // cic warn before initiating an upload that's almost certainly
  // user error.
  maxFileSizeBytes: (category) =>
    ({
      image: 100 * 1024 * 1024,
      video: 50 * 1024 * 1024,
      document: 10 * 1024 * 1024,
      audio: 25 * 1024 * 1024,
    })[category],
  // Litterbox does not advertise CORS preflight headers; attaching a
  // progress listener triggers OPTIONS preflight and breaks every
  // upload. Verified empirically 2026-05-16. Future hosts (catbox-
  // permanent, 0x0.st) that DO advertise CORS preflight can flip this
  // to true and get the real progress bar back.
  supportsProgress: false,
  upload: (file, options, onProgress, signal) => {
    const ttl = options.ttl ?? litterboxHost.defaultTtl ?? "24h";
    const body = new FormData();
    body.append("reqtype", "fileupload");
    body.append("time", ttl);
    body.append("fileToUpload", file);
    return xhrUpload({
      url: LITTERBOX_ENDPOINT,
      body,
      onProgress,
      signal,
      parseResponse: parseLitterboxResponse,
      supportsProgress: litterboxHost.supportsProgress,
    });
  },
};

// --------------------------------------------------------------------
// Embedded — grappa itself serves the file (UX-6 bucket B, 2026-05-20).
//
// Same-origin POST to `/api/uploads` with `Authorization: Bearer
// <token>`. The server returns `{slug, url, expires_at}` with `url`
// already absolute (Endpoint.url() + slug), so the per-host
// retention copy reflects the grappa server itself rather than a
// public-temp host.
//
// `supportsProgress: true` — same-origin requests have no CORS
// preflight surface; `xhr.upload.addEventListener("progress")` works
// natively without the OPTIONS gotcha that the catbox path documents.
//
// `maxFileSizeBytes` is a dynamic per-category lookup against the
// reactive `serverSettings()` signal so an admin-tuned per-file cap
// takes effect in ComposeBox's pre-check without a page reload.
// Pre-snapshot fallback: the server-side defaults (mirror
// `Grappa.ServerSettings` `@default_upload_*_cap_bytes`).
//
// ## Authorization vs the litterbox shape
//
// `token()` (from auth.ts) is the operator's bearer; visitor + user
// subjects both carry one. The server's `:authn` pipeline gates
// `/api/uploads` so an unauthenticated upload returns 401 without
// touching disk — same authz model as every other authn'd REST verb.
//
// ## Response shape
//
// `201 {slug, url, expires_at}`. We resolve with `url`; cic ignores
// `slug`/`expires_at` for now (the URL is the only thing that lands
// in the PRIVMSG body). Adding a future image-pin / image-extend
// surface would parse these from a richer wire shape; for B2 the
// existing `Promise<string>` contract is sufficient.
// --------------------------------------------------------------------

const EMBEDDED_ENDPOINT = "/api/uploads";

type EmbeddedSuccessResponse = {
  slug: string;
  url: string;
  expires_at: string;
};

function parseEmbeddedResponse(status: number, body: string): string | UploadError {
  if (status < 200 || status >= 300) {
    return { kind: "http", status, body };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid_response", body };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "invalid_response", body };
  }
  const p = parsed as Partial<EmbeddedSuccessResponse>;
  if (typeof p.url !== "string" || !URL_PATTERN.test(p.url)) {
    return { kind: "invalid_response", body };
  }
  return p.url;
}

export const embeddedHost: UploadHost = {
  id: "embedded",
  displayName: "this grappa server",
  retentionStatement:
    "this grappa server. The URL is public — anyone with it can view the file for the chosen lifetime.",
  ttlOptions: [
    { value: "3600", label: "1 hour", seconds: 3600 },
    { value: "43200", label: "12 hours", seconds: 43_200 },
    { value: "86400", label: "24 hours", seconds: 86_400 },
    { value: "259200", label: "72 hours", seconds: 259_200 },
  ],
  defaultTtl: "86400",
  acceptedMimeTypes: {
    image: IMAGE_MIMES,
    video: VIDEO_MIMES,
    document: [...DOCUMENT_MIMES_PORTABLE, ...DOCUMENT_MIMES_OFFICE],
    audio: AUDIO_MIMES,
  },
  // Reactive per-category cap — falls back to the server-side defaults
  // (mirrors Grappa.ServerSettings @default_upload_*_cap_bytes) before
  // the WS snapshot lands.
  maxFileSizeBytes: (category) =>
    serverSettings()?.uploadPerFileCapBytes[category] ??
    {
      image: 10 * 1024 * 1024,
      video: 50 * 1024 * 1024,
      document: 10 * 1024 * 1024,
      audio: 25 * 1024 * 1024,
    }[category],
  // Same-origin POST — no CORS preflight. Real progress bar works.
  supportsProgress: true,
  upload: (file, options, onProgress, signal) => {
    const ttl = options.ttl ?? embeddedHost.defaultTtl ?? "86400";
    const body = new FormData();
    body.append("file", file);
    body.append("expire", ttl);
    const bearer = readToken();
    return xhrUpload({
      url: EMBEDDED_ENDPOINT,
      body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
      onProgress,
      signal,
      parseResponse: parseEmbeddedResponse,
      supportsProgress: embeddedHost.supportsProgress,
    });
  },
};

// Token reader extracted so tests can inject without hauling in the
// whole `auth.ts` module graph (vitest jsdom + localStorage is the
// canonical bearer storage; production reads via `token()` accessor
// from auth.ts). Same shape as `archive.ts`'s `loadArchive` token
// peek. Test-only override via `__setUploadTokenReader` lives below.
let _tokenReader: () => string | null = () => {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem("grappa-token");
};

function readToken(): string | null {
  return _tokenReader();
}

// Test seam — vitest sets / clears the reader per test. Production
// never calls this. Mirrors `bundleHash.ts`'s `__resetBundleHashForTests`
// pattern.
export function __setUploadTokenReader(fn: (() => string | null) | null): void {
  _tokenReader =
    fn ??
    (() => {
      if (typeof localStorage === "undefined") return null;
      return localStorage.getItem("grappa-token");
    });
}

// --------------------------------------------------------------------
// Registry + active host selector.
//
// UX-6-B2 (2026-05-21): `availableHosts` lists embedded FIRST so it's
// the default pick whenever the reactive `serverSettings()` signal is
// null (pre-snapshot, or admin hasn't explicitly set the host).
// `activeHost()` reads the signal reactively — admin flips host →
// fan-out broadcast lands in cic → `applyServerSettings/1` writes the
// signal → `activeHost()` re-evaluates → ComposeBox + SettingsDrawer
// re-render with the new host's TTL ladder + retention copy.
// --------------------------------------------------------------------

export const availableHosts: ReadonlyArray<UploadHost> = [embeddedHost, litterboxHost];

export function activeHost(): UploadHost {
  const view = serverSettings();
  if (view?.uploadActiveHost === "litterbox") return litterboxHost;
  // Default + explicit "embedded" both land on embeddedHost.
  return embeddedHost;
}
