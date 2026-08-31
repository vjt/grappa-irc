import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks — vi.mock factories run before module imports.
vi.mock("../lib/scrollback", () => ({
  sendMessage: vi.fn(async () => {}),
}));

// UX-4 bucket M (2026-05-19) — server-pref upload-TTL replaces the
// localStorage-keyed one. Mock the REST wrapper so tests don't hit
// the network; the orchestrator's internal signal still updates
// through the cache-mirror hooks.
vi.mock("../lib/userSettings", async () => {
  const actual = await vi.importActual<typeof import("../lib/userSettings")>("../lib/userSettings");
  return {
    ...actual,
    getUploadTtlSeconds: vi.fn(async () => null),
    putUploadTtlSeconds: vi.fn(async (_token: string, seconds: number | null) => seconds),
  };
});

vi.mock("../lib/uploadHost", async () => {
  const actual = await vi.importActual<typeof import("../lib/uploadHost")>("../lib/uploadHost");
  return {
    ...actual,
    activeHost: vi.fn(() => actual.litterboxHost),
  };
});

// Task 6 (2026-06-09) — the video branch awaits transcodeVideo before
// the host POST. Mock at the module boundary: these tests pin the
// orchestrator's dispatch policy (phases, fallback eligibility, cancel
// propagation), videoTranscode.test.ts pins the transcode itself.
// Deferred-resolver shape mirrors `pendingResolvers` below.
//
// Task 6 quality-review follow-up (landed with Task 7, 2026-06-09):
// the policy surface (constants + probe) lives in
// videoPolicy.ts — importActual the constants so the suite can't drift
// from the real MAX_DURATION_SECONDS; only the probe is stubbed. The
// transcode itself is loaded by the orchestrator via dynamic import()
// (mediabunny stays off the main chunk), which vi.mock intercepts too.
const vt = vi.hoisted(() => ({
  transcodes: [] as Array<{
    file: File;
    capBytes: number;
    maxDurationSeconds: number;
    onProgress: (fraction: number) => void;
    signal: AbortSignal;
    resolve: (
      result:
        | { ok: File }
        | { error: { kind: "too_long"; durationSeconds: number } }
        | { error: { kind: "unsupported"; detail: string } }
        | { error: { kind: "failed"; message: string } },
    ) => void;
  }>,
  probeDuration: vi.fn(async (_file: File): Promise<number | null> => null),
}));

vi.mock("../lib/videoPolicy", async () => {
  const actual = await vi.importActual<typeof import("../lib/videoPolicy")>("../lib/videoPolicy");
  return { ...actual, probeDuration: vt.probeDuration };
});

vi.mock("../lib/videoTranscode", () => ({
  transcodeVideo: vi.fn(
    (
      file: File,
      capBytes: number,
      maxDurationSeconds: number,
      onProgress: (fraction: number) => void,
      signal: AbortSignal,
    ) =>
      new Promise((resolve) => {
        vt.transcodes.push({ file, capBytes, maxDurationSeconds, onProgress, signal, resolve });
      }),
  ),
}));

import { type ChannelKey, channelKey } from "../lib/channelKey";
import {
  acceptConfirm,
  type ConfirmAttachment,
  confirmRequest,
  dismissConfirm,
} from "../lib/confirmDialog";
import { sendMessage } from "../lib/scrollback";
import { setServerSettings } from "../lib/serverSettings";
import { activeHost, type UploadHost } from "../lib/uploadHost";
import {
  acknowledgePrivacy,
  cancelUpload,
  dismissUpload,
  loadUploadTtlSeconds,
  privacyModalState,
  resetUploadsForTests,
  resetUploadTtlSecondsForTests,
  retryUpload,
  saveUploadTtlSeconds,
  triggerUpload,
  triggerUploads,
  uploadBatch,
  uploadState,
  uploadTtlSecondsValue,
} from "../lib/uploadOrchestrator";
import * as userSettings from "../lib/userSettings";

const slug = "freenode";
const channel = "#a";
const key = channelKey(slug, channel);

const sampleImage = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screenshot.png", { type: "image/png" });

const sampleNonImage = (): File => new File(["hello"], "notes.txt", { type: "text/plain" });

// #1883 — every trigger surface now opens a Send/Cancel confirm before the
// batch is queued. The tests below pin what happens AFTER the operator says
// Send, so they go through the REAL door and accept inline rather than
// calling a private un-gated entry point: a regression in the gate itself
// then shows up here as well as in the "confirm gate" block at the end.
const triggerUploadConfirmed = (
  k: ChannelKey,
  networkSlug: string,
  channelName: string,
  file: File,
): void => {
  triggerUpload(k, networkSlug, channelName, file);
  acceptConfirm();
};

const triggerUploadsConfirmed = (
  k: ChannelKey,
  networkSlug: string,
  channelName: string,
  files: File[],
): void => {
  triggerUploads(k, networkSlug, channelName, files);
  acceptConfirm();
};

// The orchestrator pulls videoTranscode in via dynamic import() (lazy
// mediabunny chunk) — the transcode mock registers a microtask after
// triggerUpload, never synchronously.
const awaitTranscodeStart = async (n: number): Promise<void> => {
  await vi.waitFor(() => expect(vt.transcodes.length).toBe(n));
};

// Test-controlled host so we can drive resolve/reject deterministically.
// `file` is captured so category-dispatch + #49 tests can assert WHICH
// file actually went over the wire.
type Resolver = {
  file: File;
  resolve: (url: string) => void;
  reject: (err: unknown) => void;
  onProgress: (loaded: number, total: number) => void;
  signal: AbortSignal;
};

let pendingResolvers: Resolver[] = [];

const makeTestHost = (overrides: Partial<UploadHost> = {}): UploadHost => ({
  id: "test-host",
  displayName: "test.host.example",
  retentionStatement: "TEST host — files exist for the next 24 hours.",
  ttlOptions: [
    { value: "1h", label: "1 hour", seconds: 3600 },
    { value: "24h", label: "24 hours", seconds: 86_400 },
  ],
  defaultTtl: "24h",
  acceptedMimeTypes: { image: ["image/png", "image/jpeg"], video: [], document: [], audio: [] },
  maxFileSizeBytes: () => 1024 * 1024,
  supportsProgress: true,
  upload: (file, _options, onProgress, signal) =>
    new Promise<string>((resolve, reject) => {
      pendingResolvers.push({
        file,
        resolve,
        reject,
        onProgress: (loaded, total) => onProgress({ loaded, total }),
        signal,
      });
    }),
  ...overrides,
});

// Host accepting all three categories with distinct per-category caps —
// category-dispatch tests (video+document uploads cluster Task 5,
// 2026-06-09).
const categoryHost = (): UploadHost =>
  makeTestHost({
    acceptedMimeTypes: {
      image: ["image/png", "image/jpeg"],
      video: ["video/mp4"],
      document: ["application/pdf", "text/plain"],
      audio: ["audio/mpeg"],
    },
    maxFileSizeBytes: (category) =>
      ({
        image: 1024 * 1024,
        video: 5 * 1024 * 1024,
        document: 512 * 1024,
        audio: 2 * 1024 * 1024,
      })[category],
  });

beforeEach(() => {
  pendingResolvers = [];
  vt.transcodes = [];
  vt.probeDuration.mockResolvedValue(null);
  vi.mocked(sendMessage).mockClear();
  // Wipe localStorage between tests so privacy state doesn't leak.
  localStorage.clear();
  // Reset ALL per-channel upload state (queue, inflight, modal, entries).
  resetUploadsForTests();
  // Reset to default (litterbox).
  vi.mocked(activeHost).mockReturnValue(makeTestHost());
  // UX-4 bucket M — reset the server-pref cache so each test starts
  // from "no preference set" (host default).
  resetUploadTtlSecondsForTests();
  vi.mocked(userSettings.getUploadTtlSeconds).mockResolvedValue(null);
  vi.mocked(userSettings.putUploadTtlSeconds).mockImplementation(async (_, s) => s);
});

afterEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------------------------
// Privacy modal gating
// --------------------------------------------------------------------

describe("privacy modal gating", () => {
  it("first upload (no localStorage flag) opens the privacy modal + does NOT trigger XHR", () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());

    const modal = privacyModalState();
    expect(modal.open).toBe(true);
    expect(modal.host?.id).toBe("test-host");
    expect(pendingResolvers.length).toBe(0); // host.upload not called yet
  });

  it("acknowledgePrivacy(true) writes the per-host localStorage flag + triggers the upload", () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    acknowledgePrivacy(true);

    expect(localStorage.getItem("image-upload-privacy-acknowledged:test-host")).toBe("1");
    expect(privacyModalState().open).toBe(false);
    expect(pendingResolvers.length).toBe(1);
  });

  it("acknowledgePrivacy(false) triggers the upload but does NOT persist", () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    acknowledgePrivacy(false);

    expect(localStorage.getItem("image-upload-privacy-acknowledged:test-host")).toBeNull();
    expect(pendingResolvers.length).toBe(1);
  });

  it("subsequent upload with flag set bypasses the modal", () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");

    triggerUploadConfirmed(key, slug, channel, sampleImage());

    expect(privacyModalState().open).toBe(false);
    expect(pendingResolvers.length).toBe(1);
  });

  it("flag is namespaced per host id — switching hosts re-prompts", () => {
    // Ack on host A.
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    // Now switch to a different host id.
    vi.mocked(activeHost).mockReturnValue(makeTestHost({ id: "other-host" }));

    triggerUploadConfirmed(key, slug, channel, sampleImage());

    expect(privacyModalState().open).toBe(true);
  });

  it("cancel from privacy modal closes modal and does NOT trigger upload", () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    dismissUpload(key);

    expect(privacyModalState().open).toBe(false);
    expect(pendingResolvers.length).toBe(0);
  });
});

// --------------------------------------------------------------------
// MIME + size gating
// --------------------------------------------------------------------

describe("MIME + size pre-checks", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  it("MIME outside the host's accepted lists → error listing supported extensions, no upload", () => {
    // text/plain is a document-category MIME, but the default test host
    // accepts no documents — generalized unsupported-type message lists
    // the extensions the host DOES take.
    triggerUploadConfirmed(key, slug, channel, sampleNonImage());

    const st = uploadState(key);
    expect(st?.error).toBeTruthy();
    expect(st?.error).toMatch(/png/);
    expect(st?.error).toMatch(/jpg/);
    expect(pendingResolvers.length).toBe(0);
  });

  it("oversize file → state has error, no upload", () => {
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "big.png", { type: "image/png" });
    triggerUploadConfirmed(key, slug, channel, big);

    const st = uploadState(key);
    expect(st?.error).toBeTruthy();
    expect(st?.error).toMatch(/size|large/i);
    expect(pendingResolvers.length).toBe(0);
  });
});

// --------------------------------------------------------------------
// Upload lifecycle
// --------------------------------------------------------------------

describe("upload lifecycle", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  it("triggers host.upload with the file + chosen TTL", () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());

    expect(pendingResolvers.length).toBe(1);
    expect(uploadState(key)?.filename).toBe("screenshot.png");
    expect(uploadState(key)?.error).toBeUndefined();
    // Task 5 (2026-06-09): every entry carries a phase; "transcoding"
    // is wired by the Task 6 video transcode.
    expect(uploadState(key)?.phase).toBe("uploading");
  });

  it("progress events update uploadState's loaded/total", () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());

    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");
    r.onProgress(512, 2048);

    expect(uploadState(key)?.loaded).toBe(512);
    expect(uploadState(key)?.total).toBe(2048);
  });

  it("on resolve, sends PRIVMSG with photocamera-prefixed URL body + clears state", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.resolve("https://litter.catbox.moe/abc.png");
    // Allow microtask queue to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "📸 https://litter.catbox.moe/abc.png");
    expect(uploadState(key)).toBeNull();
  });

  it("on reject (network), state has error string + does NOT auto-send", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toBeTruthy();
    expect(uploadState(key)?.error).toMatch(/network/i);
    // No progress was ever OBSERVED (e.g. supportsProgress: false
    // hosts) — the copy must stay generic, not claim "no bytes were
    // sent" when megabytes may have flowed unobserved.
    expect(uploadState(key)?.error).not.toMatch(/no bytes/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // XHR network errors carry no status — the only forensic signal the
  // client has is how far the upload got. The 2026-06-10 nginx 4m edge
  // cut surfaced as a bare "network error" after megabytes had flowed;
  // the copy must distinguish dropped-mid-upload from never-connected.
  it("on reject (network) after progress, error says how much was sent", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.onProgress(12 * 1024 * 1024, 52 * 1024 * 1024);
    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/dropped/i);
    expect(uploadState(key)?.error).toMatch(/12 of 52 MB/);
  });

  it("on reject (network) with zero bytes sent, error suggests unreachable", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.onProgress(0, 52 * 1024 * 1024);
    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/no bytes/i);
    expect(uploadState(key)?.error).toMatch(/unreachable/i);
  });

  it("network-error progress context resets between attempts", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const first = pendingResolvers[0];
    if (!first) throw new Error("expected resolver");

    first.onProgress(12 * 1024 * 1024, 52 * 1024 * 1024);
    first.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();
    expect(uploadState(key)?.error).toMatch(/12 of 52 MB/);

    // Retry fails with no progress observed — stale bytes-sent from
    // attempt #1 must not leak into attempt #2's message, and "never
    // observed" must NOT claim "no bytes were sent" (hosts with
    // supportsProgress: false never fire progress at all).
    retryUpload(key);
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(2));
    const second = pendingResolvers[1];
    if (!second) throw new Error("expected resolver");

    second.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/network error/i);
    expect(uploadState(key)?.error).not.toMatch(/12 of 52 MB/);
    expect(uploadState(key)?.error).not.toMatch(/no bytes/i);
  });

  it("on reject (http 413), error message is friendly + mentions size or rejection", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "http", status: 413, body: "Payload Too Large" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/reject|too large|file/i);
  });

  it("on reject (http 5xx), error message mentions service / unavailable", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "http", status: 503, body: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/service|unavailable|server/i);
  });

  it("on reject (abort), state is cleared silently — no error UI", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "abort" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)).toBeNull();
  });
});

// --------------------------------------------------------------------
// #364 bucket H (cross-surface S4) — the embedded upload host
// (/api/uploads) rejects with a JSON body `{error: "<token>", ...}` the
// FallbackController comments promise cic renders per-token. Pre-fix the
// `http` arm branched only on numeric status: every 4xx → "try a
// different file" (wrong for metadata_strip_failed), 507 → "Retry?"
// (retry can't fix a full disk). These assert the token now drives the
// copy, and a token-less body still falls through to the status generic.
// --------------------------------------------------------------------

describe("embedded-host token error copy (#364 S4)", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  const rejectWith = async (body: string, status: number): Promise<void> => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");
    r.reject({ kind: "http", status, body });
    await Promise.resolve();
    await Promise.resolve();
  };

  it("file_too_large renders the server max_bytes threshold", async () => {
    await rejectWith(JSON.stringify({ error: "file_too_large", max_bytes: 5 * 1024 * 1024 }), 413);
    expect(uploadState(key)?.error).toMatch(/too large/i);
    expect(uploadState(key)?.error).toMatch(/max 5 MB/i);
  });

  it("file_too_large spells a sub-MB cap in adaptive units (formatBytes, not fixed MB)", async () => {
    // #411 — the cap spelling on the live upload path is unified onto
    // formatBytes (base-1024, adaptive), matching friendlyApiError. A 512 KB
    // admin cap must read "512 KB", not the old fixed-MB "0.5 MB" that
    // understated the unit. (The "X of Y" progress line keeps mbLabel's fixed
    // MB — a deliberate, separate contract left untouched.)
    await rejectWith(JSON.stringify({ error: "file_too_large", max_bytes: 512 * 1024 }), 413);
    expect(uploadState(key)?.error).toMatch(/too large/i);
    expect(uploadState(key)?.error).toMatch(/max 512 KB/i);
  });

  it("insufficient_storage points at the admin — never suggests retry", async () => {
    await rejectWith(JSON.stringify({ error: "insufficient_storage" }), 507);
    expect(uploadState(key)?.error).toMatch(/full|admin/i);
    expect(uploadState(key)?.error).not.toMatch(/retry/i);
  });

  it("metadata_strip_failed explains metadata — not 'try a different file'", async () => {
    await rejectWith(JSON.stringify({ error: "metadata_strip_failed" }), 422);
    expect(uploadState(key)?.error).toMatch(/metadata/i);
    expect(uploadState(key)?.error).not.toMatch(/try a different file/i);
  });

  it("unsupported_media_type names the type problem", async () => {
    await rejectWith(JSON.stringify({ error: "unsupported_media_type" }), 415);
    expect(uploadState(key)?.error).toMatch(/type/i);
  });

  it("a token-less / non-JSON 4xx body falls through to the status generic", async () => {
    await rejectWith("Payload Too Large", 413);
    expect(uploadState(key)?.error).toMatch(/reject|too large|file/i);
  });

  it("a token-less 5xx body falls through to the service-unavailable generic", async () => {
    await rejectWith("", 503);
    expect(uploadState(key)?.error).toMatch(/service|unavailable|server/i);
  });
});

// --------------------------------------------------------------------
// Cancel + dismiss + retry
// --------------------------------------------------------------------

describe("cancel + dismiss + retry", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  it("cancelUpload aborts the host's signal + clears state", () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    cancelUpload(key);

    expect(r.signal.aborted).toBe(true);
    expect(uploadState(key)).toBeNull();
  });

  it("dismissUpload clears an error state without triggering anything", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");
    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toBeTruthy();

    dismissUpload(key);
    expect(uploadState(key)).toBeNull();
  });

  it("retryUpload re-triggers with the original file after an error", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");
    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    retryUpload(key);

    expect(pendingResolvers.length).toBe(2);
    expect(uploadState(key)?.error).toBeUndefined();
  });
});

// --------------------------------------------------------------------
// Category dispatch — video+document uploads cluster Task 5 (2026-06-09)
//
// Single pipeline: categoryOf → host accept gate → transform hook
// (identity until the Task 6 video transcode) → per-category cap →
// upload → emoji-prefixed PRIVMSG (📸/🎬/📄).
// --------------------------------------------------------------------

describe("category dispatch", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    vi.mocked(activeHost).mockReturnValue(categoryHost());
  });

  it("document upload → host.upload called + 📄-prefixed PRIVMSG", async () => {
    const pdf = new File(["%PDF-1.4"], "notes.pdf", { type: "application/pdf" });
    triggerUploadConfirmed(key, slug, channel, pdf);

    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.pdf");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "📄 https://litter.catbox.moe/abc.pdf");
    expect(uploadState(key)).toBeNull();
  });

  it("image upload → 📸-prefixed PRIVMSG (via the emoji map)", async () => {
    triggerUploadConfirmed(key, slug, channel, sampleImage());

    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.png");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "📸 https://litter.catbox.moe/abc.png");
  });

  it("audio upload → host.upload called + 🎵-prefixed PRIVMSG", async () => {
    const mp3 = new File([new Uint8Array([0x49, 0x44, 0x33])], "voice.mp3", { type: "audio/mpeg" });
    triggerUploadConfirmed(key, slug, channel, mp3);

    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.mp3");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "🎵 https://litter.catbox.moe/abc.mp3");
    expect(uploadState(key)).toBeNull();
  });

  it("relabels an octet-stream .m4r to audio/mp4 so it uploads (iOS ringtone ext)", async () => {
    // iOS gives the rare .m4r extension an empty/octet-stream file.type,
    // not audio/mp4 — so categoryOf would reject it client-side before it
    // ever reaches the server's octet-stream rescue. cic relabels by
    // extension (mirror of the server @audio_ext_canonical_mime) so both
    // the category gate AND the uploaded Content-Type are audio/mp4.
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        acceptedMimeTypes: { image: [], video: [], document: [], audio: ["audio/mp4"] },
      }),
    );
    const m4r = new File([new Uint8Array([0, 0, 0, 0])], "ring.m4r", {
      type: "application/octet-stream",
    });
    triggerUploadConfirmed(key, slug, channel, m4r);

    expect(pendingResolvers.length).toBe(1);
    expect(pendingResolvers[0]?.file.type).toBe("audio/mp4");
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/ring.m4r");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      slug,
      channel,
      "🎵 https://litter.catbox.moe/ring.m4r",
    );
  });

  it("video upload → routed through the transcode → 🎬-prefixed PRIVMSG", async () => {
    const clip = new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" });
    triggerUploadConfirmed(key, slug, channel, clip);

    // Task 6: the transform hook is the transcode now — the host POST
    // only fires once the transcode resolves.
    await awaitTranscodeStart(1);
    expect(pendingResolvers.length).toBe(0);
    const out = new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" });
    vt.transcodes[0]?.resolve({ ok: out });
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(1));

    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.mp4");
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        slug,
        channel,
        "🎬 https://litter.catbox.moe/abc.mp4",
      ),
    );
  });

  it("unknown MIME → error listing supported types, host.upload NOT called", () => {
    const exe = new File([new Uint8Array(4)], "setup.exe", {
      type: "application/x-msdownload",
    });
    triggerUploadConfirmed(key, slug, channel, exe);

    const st = uploadState(key);
    expect(st?.error).toMatch(/png/);
    expect(st?.error).toMatch(/mp4/);
    expect(st?.error).toMatch(/pdf/);
    expect(pendingResolvers.length).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("document over the document cap → cap error message, no upload", () => {
    // 1MB pdf vs the categoryHost's 512KB document cap (image cap is
    // 1MB — a flat cap would let this through).
    const big = new File([new Uint8Array(1024 * 1024)], "big.pdf", { type: "application/pdf" });
    triggerUploadConfirmed(key, slug, channel, big);

    const st = uploadState(key);
    expect(st?.error).toMatch(/too large/i);
    expect(pendingResolvers.length).toBe(0);
  });
});

// --------------------------------------------------------------------
// Video transcode branch — Task 6 (2026-06-09)
//
// Policy split lives here: too_long is POLICY (hard reject, no
// fallback); unsupported/failed are CAPABILITY (fall back to the
// original under the same duration + cap gates, console.warn the
// reason — no silent swallow). Cancel during a transcode aborts the
// transcode signal and clears state without falling back.
// --------------------------------------------------------------------

describe("video transcode branch", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const videoClip = (bytes = 16): File =>
    new File([new Uint8Array(bytes)], "clip.mp4", { type: "video/mp4" });

  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    vi.mocked(activeHost).mockReturnValue(categoryHost());
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    setServerSettings(null);
  });

  // #201 — the duration ceiling is a server setting. These pin the
  // three things that broke when it was a compile-time const: the
  // value handed to the transcoder, the value the reject GATE uses on
  // the capability-fallback path, and the value the operator READS in
  // the error copy.
  const settingsWithVideoDuration = (seconds: number): void => {
    setServerSettings({
      uploadActiveHost: "embedded",
      uploadPerFileCapBytes: { image: 1, video: 5 * 1024 * 1024, document: 1, audio: 1 },
      uploadGlobalCapBytes: 1,
      uploadVideoMaxDurationSeconds: seconds,
      httpHostAliases: [],
    });
  };

  it("#201: the live server ceiling is what reaches transcodeVideo", async () => {
    settingsWithVideoDuration(45);
    triggerUploadConfirmed(key, slug, channel, videoClip());

    await awaitTranscodeStart(1);
    expect(vt.transcodes[0]?.maxDurationSeconds).toBe(45);
  });

  it("#201: with no settings snapshot yet, the 120s fallback reaches transcodeVideo", async () => {
    triggerUploadConfirmed(key, slug, channel, videoClip());

    await awaitTranscodeStart(1);
    expect(vt.transcodes[0]?.maxDurationSeconds).toBe(120);
  });

  it("#201: the too-long copy names the LIVE ceiling, not the constant", async () => {
    settingsWithVideoDuration(45);
    triggerUploadConfirmed(key, slug, channel, videoClip());

    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "too_long", durationSeconds: 90 } });

    await vi.waitFor(() =>
      expect(uploadState(key)?.error).toBe("Video too long (max 45 seconds)."),
    );
  });

  it("#201: a whole-minute ceiling still reads in minutes", async () => {
    settingsWithVideoDuration(60);
    triggerUploadConfirmed(key, slug, channel, videoClip());

    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "too_long", durationSeconds: 90 } });

    await vi.waitFor(() => expect(uploadState(key)?.error).toBe("Video too long (max 1 minute)."));
  });

  it("#201: the capability-fallback gate rejects against the LIVE ceiling", async () => {
    // 90s is under the 120s fallback constant, so only the admin-set
    // 60s ceiling can reject it on the fallback path.
    settingsWithVideoDuration(60);
    triggerUploadConfirmed(key, slug, channel, videoClip());

    vt.probeDuration.mockResolvedValue(90);
    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "failed", message: "encoder blew up" } });

    await vi.waitFor(() => expect(uploadState(key)?.error).toBe("Video too long (max 1 minute)."));
    expect(pendingResolvers.length).toBe(0);
  });

  it("happy path: transcoding phase first, host receives the TRANSCODED file, 🎬 PRIVMSG", async () => {
    const clip = videoClip();
    triggerUploadConfirmed(key, slug, channel, clip);

    // Transcoding entry is visible before any upload starts.
    expect(uploadState(key)?.phase).toBe("transcoding");
    expect(uploadState(key)?.filename).toBe("clip.mp4");
    expect(pendingResolvers.length).toBe(0);
    await awaitTranscodeStart(1);
    expect(vt.transcodes[0]?.file).toBe(clip);
    // The video cap (categoryHost: 5MB) drives the bitrate budget.
    expect(vt.transcodes[0]?.capBytes).toBe(5 * 1024 * 1024);

    // Transcode progress lands in the entry as a 0..1 fraction.
    vt.transcodes[0]?.onProgress(0.5);
    expect(uploadState(key)?.loaded).toBe(0.5);
    expect(uploadState(key)?.total).toBe(1);

    const out = new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" });
    vt.transcodes[0]?.resolve({ ok: out });
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(1));

    // Referential check — the host uploads the transcode OUTPUT.
    expect(pendingResolvers[0]?.file).toBe(out);
    expect(uploadState(key)?.phase).toBe("uploading");

    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.mp4");
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        slug,
        channel,
        "🎬 https://litter.catbox.moe/abc.mp4",
      ),
    );
    expect(uploadState(key)).toBeNull();
  });

  it("too_long is POLICY: hard reject, no fallback, host.upload never called", async () => {
    triggerUploadConfirmed(key, slug, channel, videoClip());

    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "too_long", durationSeconds: 300 } });
    await vi.waitFor(() => expect(uploadState(key)?.error).toBe("Video too long (max 2 minutes)."));

    expect(pendingResolvers.length).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("unsupported + small original → ORIGINAL uploads, reason console.warn'd", async () => {
    const clip = videoClip();
    triggerUploadConfirmed(key, slug, channel, clip);

    vt.probeDuration.mockResolvedValue(30);
    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({
      error: { kind: "unsupported", detail: "no H.264 encoder (WebCodecs)" },
    });
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(1));

    expect(pendingResolvers[0]?.file).toBe(clip);
    expect(warnSpy).toHaveBeenCalledWith("video transcode unavailable, uploading original:", {
      kind: "unsupported",
      detail: "no H.264 encoder (WebCodecs)",
    });
  });

  it("unsupported + oversize original → COMBINED error: transcode reason + cap, no upload", async () => {
    // 6MB original vs the categoryHost 5MB video cap. iOS Safari has
    // no console — the transcode-failure reason must ride the error UI
    // alongside the cap rejection (2026-06-10 dogfood).
    triggerUploadConfirmed(key, slug, channel, videoClip(6 * 1024 * 1024));

    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({
      error: { kind: "unsupported", detail: "no H.264 encoder (WebCodecs)" },
    });
    await vi.waitFor(() =>
      expect(uploadState(key)?.error).toMatch(/no H\.264 encoder \(WebCodecs\)/),
    );
    expect(uploadState(key)?.error).toMatch(/too large \(max 5 MB\)/i);

    expect(pendingResolvers.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("failed + oversize original → COMBINED error carries the failure message", async () => {
    triggerUploadConfirmed(key, slug, channel, videoClip(6 * 1024 * 1024));

    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "failed", message: "encoder blew up" } });
    await vi.waitFor(() => expect(uploadState(key)?.error).toMatch(/encoder blew up/));
    expect(uploadState(key)?.error).toMatch(/too large \(max 5 MB\)/i);

    expect(pendingResolvers.length).toBe(0);
  });

  it("failed + original over the 2-minute ceiling → too-long error, no fallback upload", async () => {
    triggerUploadConfirmed(key, slug, channel, videoClip());

    vt.probeDuration.mockResolvedValue(200);
    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "failed", message: "encoder blew up" } });
    await vi.waitFor(() => expect(uploadState(key)?.error).toBe("Video too long (max 2 minutes)."));

    expect(pendingResolvers.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("cancel during transcode → state cleared, transcode signal aborted, no fallback", async () => {
    triggerUploadConfirmed(key, slug, channel, videoClip());
    expect(uploadState(key)?.phase).toBe("transcoding");
    await awaitTranscodeStart(1);

    cancelUpload(key);

    expect(vt.transcodes[0]?.signal.aborted).toBe(true);
    expect(uploadState(key)).toBeNull();

    // The aborted conversion eventually settles as failed — the stale-
    // controller guard must NOT resurrect state or fall back.
    vt.transcodes[0]?.resolve({ error: { kind: "failed", message: "conversion canceled" } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)).toBeNull();
    expect(pendingResolvers.length).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("re-trigger during an in-flight transcode queues behind it (#118 — no abort, no orphaned encode)", async () => {
    triggerUploadConfirmed(key, slug, channel, videoClip());
    await awaitTranscodeStart(1);
    expect(vt.transcodes[0]?.signal.aborted).toBe(false);

    // Second selection on the same channel while the first transcode is
    // still running: #118 queues it behind the first instead of aborting —
    // the first upload is never lost, and only ONE transcode runs at a time.
    triggerUploadConfirmed(key, slug, channel, videoClip());
    await Promise.resolve();
    await Promise.resolve();
    expect(vt.transcodes.length).toBe(1);
    expect(vt.transcodes[0]?.signal.aborted).toBe(false);

    // First transcode completes → its upload runs → on success the queue
    // pumps and the SECOND transcode finally starts.
    const out = new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" });
    vt.transcodes[0]?.resolve({ ok: out });
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(1));
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/clip1.mp4");
    await awaitTranscodeStart(2);
    expect(vt.transcodes[1]?.signal.aborted).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------
// #49 — stale retry buffer
//
// lastAttempt must record the user's LATEST selection BEFORE any gate
// can reject. Pre-fix it was written only after the pre-check passed,
// so the error box's retry button re-dispatched the PREVIOUS file.
// --------------------------------------------------------------------

describe("#49 — stale retry buffer", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  it("retry after a pre-check rejection retries the REJECTED file, not a prior one", async () => {
    // 1) Successful small upload — pre-fix this poisons lastAttempt.
    const small = new File([new Uint8Array(4)], "small.png", { type: "image/png" });
    triggerUploadConfirmed(key, slug, channel, small);
    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/small.png");
    await Promise.resolve();
    await Promise.resolve();

    // 2) Oversized file → pre-check rejection (host cap is 1MB).
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "big.png", { type: "image/png" });
    triggerUploadConfirmed(key, slug, channel, big);
    expect(uploadState(key)?.error).toMatch(/too large/i);

    // 3) Retry must re-attempt big.png — which fails the pre-check
    // AGAIN, with big.png's name in the error box…
    retryUpload(key);
    expect(uploadState(key)?.filename).toBe("big.png");
    expect(uploadState(key)?.error).toMatch(/too large/i);
    // …and must NOT re-dispatch small.png to the host.
    expect(pendingResolvers.length).toBe(1);
  });

  it("a new selection after a failed POST replaces the retry payload", async () => {
    const a = new File([new Uint8Array(4)], "a.png", { type: "image/png" });
    triggerUploadConfirmed(key, slug, channel, a);
    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.reject({ kind: "http", status: 413, body: "Payload Too Large" });
    await Promise.resolve();
    await Promise.resolve();
    expect(uploadState(key)?.error).toBeTruthy();

    const b = new File([new Uint8Array(4)], "b.png", { type: "image/png" });
    triggerUploadConfirmed(key, slug, channel, b);
    expect(pendingResolvers.length).toBe(2);
    expect(pendingResolvers[1]?.file.name).toBe("b.png");
    pendingResolvers[1]?.resolve("https://litter.catbox.moe/b.png");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "📸 https://litter.catbox.moe/b.png");
    expect(uploadState(key)).toBeNull();
  });
});

// --------------------------------------------------------------------
// TTL persistence — UX-4 bucket M (2026-05-19)
//
// Server is the authoritative source. The orchestrator caches the
// preference in a cic-side signal that SettingsDrawer reads/writes
// via loadUploadTtlSeconds/saveUploadTtlSeconds. Dispatching an
// upload translates the cached integer seconds into the active host's
// ttlOption.value token; falls back to host.defaultTtl when no
// preference (or no matching ladder entry).
// --------------------------------------------------------------------

describe("TTL persistence", () => {
  it("uploadTtlSecondsValue starts null when never loaded", () => {
    expect(uploadTtlSecondsValue()).toBeNull();
  });

  it("loadUploadTtlSeconds populates the cache from the server", async () => {
    vi.mocked(userSettings.getUploadTtlSeconds).mockResolvedValueOnce(3600);
    await loadUploadTtlSeconds("tok");
    expect(uploadTtlSecondsValue()).toBe(3600);
  });

  it("saveUploadTtlSeconds round-trips via the REST wrapper + mirrors the cache", async () => {
    await saveUploadTtlSeconds("tok", 43_200);
    expect(userSettings.putUploadTtlSeconds).toHaveBeenCalledWith("tok", 43_200);
    expect(uploadTtlSecondsValue()).toBe(43_200);
  });

  it("triggerUpload uses cached pref when matched to host ladder", async () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    // 3600 seconds matches the test host's "1h" token.
    await saveUploadTtlSeconds("tok", 3600);

    let capturedTtl: string | undefined;
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        upload: (_file, options, _onProgress, _signal) => {
          capturedTtl = options.ttl;
          return new Promise<string>(() => {});
        },
      }),
    );

    triggerUploadConfirmed(key, slug, channel, sampleImage());
    expect(capturedTtl).toBe("1h");
  });

  it("triggerUpload falls back to host.defaultTtl when no pref cached", () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");

    let capturedTtl: string | undefined;
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        defaultTtl: "24h",
        upload: (_file, options, _onProgress, _signal) => {
          capturedTtl = options.ttl;
          return new Promise<string>(() => {});
        },
      }),
    );

    triggerUploadConfirmed(key, slug, channel, sampleImage());
    expect(capturedTtl).toBe("24h");
  });

  it("triggerUpload falls back to host.defaultTtl when cached pref doesn't match the host ladder", async () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    // 9999s isn't in the ladder.
    await saveUploadTtlSeconds("tok", 9999);

    let capturedTtl: string | undefined;
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        defaultTtl: "24h",
        upload: (_file, options, _onProgress, _signal) => {
          capturedTtl = options.ttl;
          return new Promise<string>(() => {});
        },
      }),
    );

    triggerUploadConfirmed(key, slug, channel, sampleImage());
    expect(capturedTtl).toBe("24h");
  });

  it("loadUploadTtlSeconds swallows REST errors silently (cache stays null)", async () => {
    vi.mocked(userSettings.getUploadTtlSeconds).mockRejectedValueOnce(new Error("network"));
    await loadUploadTtlSeconds("tok");
    expect(uploadTtlSecondsValue()).toBeNull();
  });
});

// --------------------------------------------------------------------
// Sequential multi-file queue (#118)
// --------------------------------------------------------------------

describe("sequential multi-file queue (#118)", () => {
  const ackPrivacy = () => localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  const img = (name: string): File =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

  it("uploads queued files one at a time, auto-sending each in order", async () => {
    ackPrivacy();
    triggerUploadsConfirmed(key, slug, channel, [img("a.png"), img("b.png"), img("c.png")]);

    // Only the first file is in flight.
    expect(pendingResolvers.length).toBe(1);
    expect(pendingResolvers[0]?.file.name).toBe("a.png");

    pendingResolvers[0]?.resolve("https://h/a");
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(2));
    expect(pendingResolvers[1]?.file.name).toBe("b.png");

    pendingResolvers[1]?.resolve("https://h/b");
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(3));
    expect(pendingResolvers[2]?.file.name).toBe("c.png");

    pendingResolvers[2]?.resolve("https://h/c");
    await vi.waitFor(() => expect(vi.mocked(sendMessage).mock.calls.length).toBe(3));
    expect(vi.mocked(sendMessage).mock.calls.map((c) => c[2])).toEqual([
      "📸 https://h/a",
      "📸 https://h/b",
      "📸 https://h/c",
    ]);
  });

  it("reports (index/total) and clears the counter when drained", async () => {
    ackPrivacy();
    triggerUploadsConfirmed(key, slug, channel, [img("a.png"), img("b.png")]);
    expect(uploadBatch(key)).toEqual({ index: 1, total: 2 });

    pendingResolvers[0]?.resolve("https://h/a");
    await vi.waitFor(() => expect(uploadBatch(key)).toEqual({ index: 2, total: 2 }));

    pendingResolvers[1]?.resolve("https://h/b");
    await vi.waitFor(() => expect(uploadBatch(key)).toBeNull());
  });

  it("a failed file pauses the batch; dismiss continues with the rest", async () => {
    ackPrivacy();
    triggerUploadsConfirmed(key, slug, channel, [img("a.png"), img("b.png")]);
    expect(pendingResolvers.length).toBe(1);

    pendingResolvers[0]?.reject({ kind: "network" });
    await vi.waitFor(() => expect(uploadState(key)?.error).toBeTruthy());
    expect(pendingResolvers.length).toBe(1); // paused — b not started

    dismissUpload(key);
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(2));
    expect(pendingResolvers[1]?.file.name).toBe("b.png");

    pendingResolvers[1]?.resolve("https://h/b");
    await vi.waitFor(() => expect(vi.mocked(sendMessage).mock.calls.length).toBe(1));
    expect(vi.mocked(sendMessage).mock.calls[0]?.[2]).toBe("📸 https://h/b");
  });

  it("cancel stops the whole batch — no further dispatch", async () => {
    ackPrivacy();
    triggerUploadsConfirmed(key, slug, channel, [img("a.png"), img("b.png"), img("c.png")]);
    expect(pendingResolvers.length).toBe(1);
    const sig = pendingResolvers[0]?.signal;

    cancelUpload(key);
    expect(sig?.aborted).toBe(true);
    expect(uploadBatch(key)).toBeNull();

    // Settle nothing further; assert the queue did not advance.
    await Promise.resolve();
    expect(pendingResolvers.length).toBe(1);
  });

  it("retry re-runs the failed file, then continues the queue", async () => {
    ackPrivacy();
    triggerUploadsConfirmed(key, slug, channel, [img("a.png"), img("b.png")]);
    pendingResolvers[0]?.reject({ kind: "network" });
    await vi.waitFor(() => expect(uploadState(key)?.error).toBeTruthy());

    retryUpload(key);
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(2));
    expect(pendingResolvers[1]?.file.name).toBe("a.png"); // retried first

    pendingResolvers[1]?.resolve("https://h/a2");
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(3));
    expect(pendingResolvers[2]?.file.name).toBe("b.png"); // queue continues

    pendingResolvers[2]?.resolve("https://h/b");
    await vi.waitFor(() => expect(vi.mocked(sendMessage).mock.calls.length).toBe(2));
  });
});

// --------------------------------------------------------------------
// The confirm gate (#1883)
// --------------------------------------------------------------------
//
// Inherited from #1884's `pickerUpload.test.ts`, which mocked the whole
// orchestrator and asserted "triggerUploads was called". That boundary no
// longer exists: the gate IS `triggerUploads`, so these run against the real
// pipeline and assert on the HOST — nothing may reach `host.upload` until
// Send. That is a stronger claim than the one they replace, and the only one
// that still means anything once the two modules are one.

describe("the confirm gate (#1883)", () => {
  const ackPrivacy = () => localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  const img = (name: string): File =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
  const attachments = (): ConfirmAttachment[] => confirmRequest()?.attachments?.items() ?? [];

  it("an empty pick opens no dialog and uploads nothing", () => {
    triggerUploads(key, slug, channel, []);
    expect(confirmRequest()).toBeNull();
    expect(pendingResolvers.length).toBe(0);
  });

  it("a pick opens a confirm and uploads NOTHING until it is answered", () => {
    ackPrivacy();
    triggerUpload(key, slug, channel, sampleImage());
    // The destination is on screen — the whole point of the step. It lives in
    // the title, which is also the dialog's aria-label.
    expect(confirmRequest()?.title).toContain(channel);
    // The privacy ack is no longer enough to put bytes on the wire.
    expect(pendingResolvers.length).toBe(0);
    // …and nothing took the channel's upload slot either: the queue is the
    // thing #1884 argued an unauthorised batch must stay out of.
    expect(uploadBatch(key)).toBeNull();
  });

  it("the confirm lists every picked file by name and size", () => {
    triggerUploads(key, slug, channel, [img("a.png"), img("b.png")]);
    expect(attachments().map((a) => a.label)).toEqual(["a.png", "b.png"]);
    expect(attachments().every((a) => a.detail !== "")).toBe(true);
  });

  it("an image carries a thumbnail source; a non-image carries none", () => {
    triggerUploads(key, slug, channel, [img("a.png"), sampleNonImage()]);
    expect(attachments()[0]?.thumbnail).not.toBeNull();
    expect(attachments()[1]?.thumbnail).toBeNull();
  });

  it("Send uploads exactly the picked files to the picked window", () => {
    ackPrivacy();
    triggerUploads(key, slug, channel, [img("a.png"), img("b.png")]);
    acceptConfirm();
    expect(pendingResolvers[0]?.file.name).toBe("a.png");
    expect(uploadBatch(key)).toEqual({ index: 1, total: 2 });
  });

  it("Cancel / Esc / backdrop upload NOTHING", async () => {
    ackPrivacy();
    triggerUploads(key, slug, channel, [img("a.png"), img("b.png")]);
    dismissConfirm();
    expect(pendingResolvers.length).toBe(0);
    expect(uploadBatch(key)).toBeNull();
    // And it stays dropped — no deferred pump resurrects it.
    await Promise.resolve();
    expect(pendingResolvers.length).toBe(0);
    expect(vi.mocked(sendMessage).mock.calls.length).toBe(0);
  });

  it("removing one file drops it from the batch — Send posts only the rest", () => {
    ackPrivacy();
    triggerUploads(key, slug, channel, [img("a.png"), img("b.png")]);
    const doomed = attachments()[0]?.id as string;
    confirmRequest()?.attachments?.onRemove(doomed);
    expect(attachments().map((a) => a.label)).toEqual(["b.png"]);
    acceptConfirm();
    expect(pendingResolvers.length).toBe(1);
    expect(pendingResolvers[0]?.file.name).toBe("b.png");
    expect(uploadBatch(key)).toEqual({ index: 1, total: 1 });
  });

  it("removing the LAST file closes the dialog and uploads nothing", () => {
    ackPrivacy();
    triggerUpload(key, slug, channel, img("only.png"));
    confirmRequest()?.attachments?.onRemove(attachments()[0]?.id as string);
    expect(confirmRequest()).toBeNull();
    expect(pendingResolvers.length).toBe(0);
  });

  it("two picks with the same filename stay separately removable", () => {
    ackPrivacy();
    triggerUploads(key, slug, channel, [img("IMG_0001.png"), img("IMG_0001.png")]);
    const ids = attachments().map((a) => a.id);
    expect(new Set(ids).size).toBe(2);
    confirmRequest()?.attachments?.onRemove(ids[0] as string);
    expect(attachments().length).toBe(1);
  });

  it("does NOT pre-filter by category — an iOS .m4r still reaches the host", () => {
    ackPrivacy();
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        acceptedMimeTypes: { image: [], video: [], document: [], audio: ["audio/mp4"] },
      }),
    );
    const m4r = new File([new Uint8Array([0, 0, 0, 0])], "ring.m4r", {
      type: "application/octet-stream",
    });
    triggerUpload(key, slug, channel, m4r);
    acceptConfirm();
    // normalizeUploadFile runs BEFORE the preview, so the dialog and the wire
    // agree on the type — this is why the picker must not route via dropUpload.
    expect(pendingResolvers[0]?.file.type).toBe("audio/mp4");
  });

  it("a second pick replaces the pending confirm rather than stacking one", () => {
    triggerUpload(key, slug, channel, img("first.png"));
    triggerUpload(key, slug, channel, img("second.png"));
    expect(attachments().map((a) => a.label)).toEqual(["second.png"]);
  });

  it("gates the drop/paste path too — the door #1884 left open", () => {
    ackPrivacy();
    // dropUpload/pasteRoute/share-target all land on triggerUploads (#351), so
    // asserting the plural entry asserts every one of them.
    triggerUploads(key, slug, channel, [img("dropped.png")]);
    expect(pendingResolvers.length).toBe(0);
    expect(confirmRequest()).not.toBeNull();
  });

  it("has no remember-me door — a second pick confirms again", () => {
    ackPrivacy();
    triggerUploads(key, slug, channel, [img("a.png")]);
    acceptConfirm();
    pendingResolvers[0]?.resolve("https://h/a");
    triggerUpload(key, slug, channel, img("b.png"));
    expect(confirmRequest()).not.toBeNull();
  });
});
