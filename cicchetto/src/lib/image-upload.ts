// Pluggable image-host upload — images cluster I-1 (2026-05-15).
//
// Defines an `ImageHost` interface that abstracts the multipart upload
// to a public image-hosting service, and ships the litterbox.catbox.moe
// implementation (`litterboxHost`) as the first concrete provider.
//
// Why an interface (not just a litterbox-specific helper). litterbox's
// API differs in shape from every other plausible provider (imgur
// returns JSON + needs a Client-ID bearer; 0x0.st gates TTL via a
// header; catbox-permanent uses a userhash). The interface encodes
// the dimensions on which providers vary — endpoint, request shape,
// response shape, TTL options, MIME accept list, retention copy — so
// swapping providers tomorrow is "write a second impl, swap
// `activeHost()`" with zero changes downstream.
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
// `ImageHost` documents this per-host posture: when `false`, the
// progress listener is NOT attached and uploads use the simple CORS
// path. UI falls back to indeterminate progress (`<progress>` with
// no value attribute renders as indeterminate per HTML spec).

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
   *  Used by `imageUploadOrchestrator` to pick a matching `value` from
   *  the active host's ladder given a stored-seconds preference. */
  seconds: number;
};

export type UploadOptions = {
  /** A `value` from the host's `ttlOptions`. Falls back to
   *  `host.defaultTtl` when omitted (or omitted from the wire when the
   *  host doesn't expose TTL choices). */
  ttl?: string;
};

export interface ImageHost {
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
  /** MIME types fed into `<input accept>` and the drag-drop / paste
   *  gate. Cluster scope is images; do not list non-image types. */
  readonly acceptedMimeTypes: ReadonlyArray<string>;
  /** Client-side pre-check ceiling. `null` = unknown / no enforced
   *  cap (still gated by the host's actual upload limit on rejection). */
  readonly maxFileSizeBytes: number | null;
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
  /** Mirror of `ImageHost.supportsProgress`. When `false`, the
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

export const litterboxHost: ImageHost = {
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
  acceptedMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/apng"],
  // Litterbox accepts up to ~1GiB but cic's practical ceiling is much
  // lower — multi-MB phone screenshots are the realistic upper bound;
  // 100MiB is generous + lets cic warn before initiating an upload
  // that's almost certainly user error.
  maxFileSizeBytes: 100 * 1024 * 1024,
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
// Registry + active host selector.
//
// Module-level for now. A future SettingsDrawer "image upload host"
// dropdown can write the operator's pick to localStorage and have
// `activeHost()` read it; until then, litterbox is the only choice.
// --------------------------------------------------------------------

export const availableHosts: ReadonlyArray<ImageHost> = [litterboxHost];

export function activeHost(): ImageHost {
  return litterboxHost;
}
