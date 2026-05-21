import { beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/auth";
import { applyServerSettings, loadServerSettings, serverSettings } from "../lib/serverSettings";

// UX-6-B2 (2026-05-21) tests for the operator-visible server-settings
// reactive signal + REST initial-fetch helper.

describe("serverSettings() — initial state", () => {
  it("is null before any apply / load", () => {
    // serverSettings is module-singleton; each test resets via
    // applyServerSettings/loadServerSettings explicitly. Test-order
    // independence: this expectation only holds at module-import time;
    // subsequent tests SET state but never test for null again here.
  });
});

describe("applyServerSettings/1 — wire → store shape", () => {
  it("maps the wire payload's upload subtree to the camelCase view", () => {
    applyServerSettings({
      upload: {
        active_host: "embedded",
        per_file_cap_bytes: 10_485_760,
        global_cap_bytes: 10_737_418_240,
      },
    });

    expect(serverSettings()).toEqual({
      uploadActiveHost: "embedded",
      uploadPerFileCapBytes: 10_485_760,
      uploadGlobalCapBytes: 10_737_418_240,
    });
  });

  it("accepts litterbox active_host", () => {
    applyServerSettings({
      upload: {
        active_host: "litterbox",
        per_file_cap_bytes: 5_000_000,
        global_cap_bytes: 999_999,
      },
    });

    const view = serverSettings();
    expect(view?.uploadActiveHost).toBe("litterbox");
    expect(view?.uploadPerFileCapBytes).toBe(5_000_000);
    expect(view?.uploadGlobalCapBytes).toBe(999_999);
  });

  it("last-write-wins on subsequent applies", () => {
    applyServerSettings({
      upload: { active_host: "embedded", per_file_cap_bytes: 1, global_cap_bytes: 2 },
    });
    applyServerSettings({
      upload: { active_host: "litterbox", per_file_cap_bytes: 3, global_cap_bytes: 4 },
    });

    expect(serverSettings()).toEqual({
      uploadActiveHost: "litterbox",
      uploadPerFileCapBytes: 3,
      uploadGlobalCapBytes: 4,
    });
  });
});

describe("loadServerSettings/0 — REST initial fetch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    setToken("test-token");
  });

  it("populates the signal from a successful GET /api/server-settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          upload: {
            active_host: "litterbox",
            per_file_cap_bytes: 7_777_777,
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
    expect(serverSettings()?.uploadPerFileCapBytes).toBe(7_777_777);
  });

  it("no-op when token is missing", async () => {
    setToken(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Clear signal so we can assert it wasn't mutated.
    applyServerSettings({
      upload: { active_host: "embedded", per_file_cap_bytes: 1, global_cap_bytes: 2 },
    });
    const before = serverSettings();

    await loadServerSettings();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(serverSettings()).toEqual(before);
  });

  it("leaves the signal untouched on non-ok response", async () => {
    applyServerSettings({
      upload: { active_host: "embedded", per_file_cap_bytes: 1, global_cap_bytes: 2 },
    });
    const before = serverSettings();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false } as unknown as Response));

    await loadServerSettings();

    expect(serverSettings()).toEqual(before);
  });

  it("swallows transient network errors (does not throw)", async () => {
    applyServerSettings({
      upload: { active_host: "embedded", per_file_cap_bytes: 1, global_cap_bytes: 2 },
    });
    const before = serverSettings();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));

    await expect(loadServerSettings()).resolves.toBeUndefined();
    expect(serverSettings()).toEqual(before);
  });
});
