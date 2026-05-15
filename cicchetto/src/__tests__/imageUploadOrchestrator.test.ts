import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks — vi.mock factories run before module imports.
vi.mock("../lib/scrollback", () => ({
  sendMessage: vi.fn(async () => {}),
}));

vi.mock("../lib/image-upload", async () => {
  const actual = await vi.importActual<typeof import("../lib/image-upload")>("../lib/image-upload");
  return {
    ...actual,
    activeHost: vi.fn(() => actual.litterboxHost),
  };
});

import { channelKey } from "../lib/channelKey";
import { activeHost, type ImageHost } from "../lib/image-upload";
import {
  acknowledgePrivacy,
  cancelUpload,
  dismissUpload,
  getChosenTtl,
  privacyModalState,
  retryUpload,
  setChosenTtl,
  triggerUpload,
  uploadState,
} from "../lib/imageUploadOrchestrator";
import { sendMessage } from "../lib/scrollback";

const slug = "freenode";
const channel = "#a";
const key = channelKey(slug, channel);

const sampleImage = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screenshot.png", { type: "image/png" });

const sampleNonImage = (): File => new File(["hello"], "notes.txt", { type: "text/plain" });

// Test-controlled host so we can drive resolve/reject deterministically.
type Resolver = {
  resolve: (url: string) => void;
  reject: (err: unknown) => void;
  onProgress: (loaded: number, total: number) => void;
  signal: AbortSignal;
};

let pendingResolvers: Resolver[] = [];

const makeTestHost = (overrides: Partial<ImageHost> = {}): ImageHost => ({
  id: "test-host",
  displayName: "test.host.example",
  retentionStatement: "TEST host — files exist for the next 24 hours.",
  ttlOptions: [
    { value: "1h", label: "1 hour" },
    { value: "24h", label: "24 hours" },
  ],
  defaultTtl: "24h",
  acceptedMimeTypes: ["image/png", "image/jpeg"],
  maxFileSizeBytes: 1024 * 1024,
  upload: (_file, _options, onProgress, signal) =>
    new Promise<string>((resolve, reject) => {
      pendingResolvers.push({
        resolve,
        reject,
        onProgress: (loaded, total) => onProgress({ loaded, total }),
        signal,
      });
    }),
  ...overrides,
});

beforeEach(() => {
  pendingResolvers = [];
  vi.mocked(sendMessage).mockClear();
  // Wipe localStorage between tests so privacy/TTL state doesn't leak.
  localStorage.clear();
  // Reset modal state explicitly — singleton survives across tests.
  dismissUpload(key);
  // Reset to default (litterbox).
  vi.mocked(activeHost).mockReturnValue(makeTestHost());
});

afterEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------------------------
// Privacy modal gating
// --------------------------------------------------------------------

describe("privacy modal gating", () => {
  it("first upload (no localStorage flag) opens the privacy modal + does NOT trigger XHR", () => {
    triggerUpload(key, slug, channel, sampleImage());

    const modal = privacyModalState();
    expect(modal.open).toBe(true);
    expect(modal.host?.id).toBe("test-host");
    expect(pendingResolvers.length).toBe(0); // host.upload not called yet
  });

  it("acknowledgePrivacy(true) writes the per-host localStorage flag + triggers the upload", () => {
    triggerUpload(key, slug, channel, sampleImage());
    acknowledgePrivacy(true);

    expect(localStorage.getItem("image-upload-privacy-acknowledged:test-host")).toBe("1");
    expect(privacyModalState().open).toBe(false);
    expect(pendingResolvers.length).toBe(1);
  });

  it("acknowledgePrivacy(false) triggers the upload but does NOT persist", () => {
    triggerUpload(key, slug, channel, sampleImage());
    acknowledgePrivacy(false);

    expect(localStorage.getItem("image-upload-privacy-acknowledged:test-host")).toBeNull();
    expect(pendingResolvers.length).toBe(1);
  });

  it("subsequent upload with flag set bypasses the modal", () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");

    triggerUpload(key, slug, channel, sampleImage());

    expect(privacyModalState().open).toBe(false);
    expect(pendingResolvers.length).toBe(1);
  });

  it("flag is namespaced per host id — switching hosts re-prompts", () => {
    // Ack on host A.
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    // Now switch to a different host id.
    vi.mocked(activeHost).mockReturnValue(makeTestHost({ id: "other-host" }));

    triggerUpload(key, slug, channel, sampleImage());

    expect(privacyModalState().open).toBe(true);
  });

  it("cancel from privacy modal closes modal and does NOT trigger upload", () => {
    triggerUpload(key, slug, channel, sampleImage());
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

  it("non-image MIME → state has error, no upload", () => {
    triggerUpload(key, slug, channel, sampleNonImage());

    const st = uploadState(key);
    expect(st?.error).toBeTruthy();
    expect(st?.error).toMatch(/image/i);
    expect(pendingResolvers.length).toBe(0);
  });

  it("oversize file → state has error, no upload", () => {
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "big.png", { type: "image/png" });
    triggerUpload(key, slug, channel, big);

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
    triggerUpload(key, slug, channel, sampleImage());

    expect(pendingResolvers.length).toBe(1);
    expect(uploadState(key)?.filename).toBe("screenshot.png");
    expect(uploadState(key)?.error).toBeUndefined();
  });

  it("progress events update uploadState's loaded/total", () => {
    triggerUpload(key, slug, channel, sampleImage());

    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");
    r.onProgress(512, 2048);

    expect(uploadState(key)?.loaded).toBe(512);
    expect(uploadState(key)?.total).toBe(2048);
  });

  it("on resolve, sends PRIVMSG with photocamera-prefixed URL body + clears state", async () => {
    triggerUpload(key, slug, channel, sampleImage());
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
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toBeTruthy();
    expect(uploadState(key)?.error).toMatch(/network/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("on reject (http 413), error message is friendly + mentions size or rejection", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "http", status: 413, body: "Payload Too Large" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/reject|too large|file/i);
  });

  it("on reject (http 5xx), error message mentions service / unavailable", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "http", status: 503, body: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/service|unavailable|server/i);
  });

  it("on reject (abort), state is cleared silently — no error UI", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "abort" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)).toBeNull();
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
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    cancelUpload(key);

    expect(r.signal.aborted).toBe(true);
    expect(uploadState(key)).toBeNull();
  });

  it("dismissUpload clears an error state without triggering anything", async () => {
    triggerUpload(key, slug, channel, sampleImage());
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
    triggerUpload(key, slug, channel, sampleImage());
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
// TTL persistence
// --------------------------------------------------------------------

describe("TTL persistence", () => {
  it("getChosenTtl returns null when no preference saved", () => {
    expect(getChosenTtl()).toBeNull();
  });

  it("setChosenTtl persists per-host, getChosenTtl reads it back", () => {
    setChosenTtl("1h");
    expect(localStorage.getItem("image-upload-ttl:test-host")).toBe("1h");
    expect(getChosenTtl()).toBe("1h");
  });

  it("triggerUpload uses chosen TTL when set, else host.defaultTtl", () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    setChosenTtl("1h");

    let capturedTtl: string | undefined;
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        upload: (_file, options, _onProgress, _signal) => {
          capturedTtl = options.ttl;
          return new Promise<string>(() => {});
        },
      }),
    );

    triggerUpload(key, slug, channel, sampleImage());
    expect(capturedTtl).toBe("1h");
  });

  it("ttl persistence is per-host id", () => {
    setChosenTtl("1h");
    vi.mocked(activeHost).mockReturnValue(makeTestHost({ id: "other-host" }));

    expect(getChosenTtl()).toBeNull();
  });
});
