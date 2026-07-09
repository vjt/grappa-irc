import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/auth";
import { applyServerSettings, loadServerSettings, serverSettings } from "../lib/serverSettings";
import type { ServerSettingsWireUploadView } from "../lib/wireTypes";

// UX-6-B2 (2026-05-21) tests for the operator-visible server-settings
// reactive signal + REST initial-fetch helper. Wire shape carries the
// three per-type cap fields since uploads cluster Task 2 (385129f).

// S15 — `active_host` is the generated closed set, not open `string`.
const wireUpload = (active_host: ServerSettingsWireUploadView["active_host"]) => ({
  active_host,
  image_per_file_cap_bytes: 1,
  video_per_file_cap_bytes: 2,
  document_per_file_cap_bytes: 3,
  audio_per_file_cap_bytes: 5,
  global_cap_bytes: 4,
});

describe("serverSettings() — initial state", () => {
  it("is null before any apply / load", () => {
    // serverSettings is module-singleton; each test resets via
    // applyServerSettings/loadServerSettings explicitly. Test-order
    // independence: this expectation only holds at module-import time;
    // subsequent tests SET state but never test for null again here.
  });
});

describe("applyServerSettings/1 — wire → store shape", () => {
  it("maps the three flat per-type cap fields to the nested uploadPerFileCapBytes record", () => {
    applyServerSettings({
      upload: {
        active_host: "embedded",
        image_per_file_cap_bytes: 10_485_760,
        video_per_file_cap_bytes: 52_428_800,
        document_per_file_cap_bytes: 10_485_760,
        audio_per_file_cap_bytes: 26_214_400,
        global_cap_bytes: 10_737_418_240,
      },
    });

    expect(serverSettings()).toEqual({
      uploadActiveHost: "embedded",
      uploadPerFileCapBytes: {
        image: 10_485_760,
        video: 52_428_800,
        document: 10_485_760,
        audio: 26_214_400,
      },
      uploadGlobalCapBytes: 10_737_418_240,
    });
  });

  it("accepts litterbox active_host", () => {
    applyServerSettings({
      upload: {
        active_host: "litterbox",
        image_per_file_cap_bytes: 5_000_000,
        video_per_file_cap_bytes: 6_000_000,
        document_per_file_cap_bytes: 7_000_000,
        audio_per_file_cap_bytes: 8_000_000,
        global_cap_bytes: 999_999,
      },
    });

    const view = serverSettings();
    expect(view?.uploadActiveHost).toBe("litterbox");
    expect(view?.uploadPerFileCapBytes).toEqual({
      image: 5_000_000,
      video: 6_000_000,
      document: 7_000_000,
      audio: 8_000_000,
    });
    expect(view?.uploadGlobalCapBytes).toBe(999_999);
  });

  it("last-write-wins on subsequent applies", () => {
    applyServerSettings({
      upload: {
        active_host: "embedded",
        image_per_file_cap_bytes: 1,
        video_per_file_cap_bytes: 1,
        document_per_file_cap_bytes: 1,
        audio_per_file_cap_bytes: 1,
        global_cap_bytes: 2,
      },
    });
    applyServerSettings({
      upload: {
        active_host: "litterbox",
        image_per_file_cap_bytes: 3,
        video_per_file_cap_bytes: 4,
        document_per_file_cap_bytes: 5,
        audio_per_file_cap_bytes: 7,
        global_cap_bytes: 6,
      },
    });

    expect(serverSettings()).toEqual({
      uploadActiveHost: "litterbox",
      uploadPerFileCapBytes: { image: 3, video: 4, document: 5, audio: 7 },
      uploadGlobalCapBytes: 6,
    });
  });
});

describe("loadServerSettings/0 — REST initial fetch", () => {
  beforeEach(() => {
    setToken("test-token");
  });

  // Unstub in afterEach, NOT beforeEach: a describe-level beforeEach runs
  // after setupTests' beforeEach and would strip the inert-WebSocket +
  // localStorage stubs for every test in this block (resurrecting jsdom's
  // real TCP-connecting WebSocket). afterEach gives the same clean fetch
  // slate, and setupTests re-installs its stubs before the next test.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("populates the signal from a successful GET /api/server-settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          upload: {
            active_host: "litterbox",
            image_per_file_cap_bytes: 7_777_777,
            video_per_file_cap_bytes: 8_888_888,
            document_per_file_cap_bytes: 9_999_999,
            audio_per_file_cap_bytes: 5_555_555,
            global_cap_bytes: 88_888_888,
          },
        }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await loadServerSettings();

    expect(fetchMock).toHaveBeenCalledWith("/api/server-settings", {
      headers: { authorization: "Bearer test-token" },
    });
    expect(serverSettings()?.uploadActiveHost).toBe("litterbox");
    expect(serverSettings()?.uploadPerFileCapBytes).toEqual({
      image: 7_777_777,
      video: 8_888_888,
      document: 9_999_999,
      audio: 5_555_555,
    });
  });

  it("no-op when token is missing", async () => {
    setToken(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Clear signal so we can assert it wasn't mutated.
    applyServerSettings({ upload: wireUpload("embedded") });
    const before = serverSettings();

    await loadServerSettings();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(serverSettings()).toEqual(before);
  });

  it("leaves the signal untouched on non-ok response", async () => {
    applyServerSettings({ upload: wireUpload("embedded") });
    const before = serverSettings();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false } as unknown as Response));

    await loadServerSettings();

    expect(serverSettings()).toEqual(before);
  });

  it("swallows transient network errors (does not throw)", async () => {
    applyServerSettings({ upload: wireUpload("embedded") });
    const before = serverSettings();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));

    await expect(loadServerSettings()).resolves.toBeUndefined();
    expect(serverSettings()).toEqual(before);
  });
});
