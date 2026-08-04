import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_FETCH_ATTEMPTS,
  BOOT_FETCH_BACKOFF_MS,
  BOOT_FETCH_TIMEOUT_MS,
  bootFetch,
} from "./bootFetch";

// #717 — the three boot fetches (`me`, `listNetworks`, `listChannels`) are the
// ones the CRT splash gates on. Unbounded, a single stalled request kept the
// splash up forever with no recovery. These tests pin the transport policy:
// every attempt is time-bounded, a transport failure is retried, and an HTTP
// response — whatever its status — is an ANSWER and must not be retried.

const totalBackoffMs = BOOT_FETCH_BACKOFF_MS.reduce((a, b) => a + b, 0);

// Explicit rather than `calls[i]?.[1]`: an optional chain feeding a member
// access reads as "may be absent" while still throwing a bare TypeError if it
// is, which tells you nothing about which call was missing.
function initOfCall(calls: readonly unknown[][], index: number): RequestInit {
  const call = calls[index];
  if (call === undefined) throw new Error(`expected a fetch call at index ${index}`);
  return call[1] as RequestInit;
}

describe("bootFetch (#717 — bounded, retrying boot transport)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the response and calls fetch once when the first attempt succeeds", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchMock = vi.fn(async () => ok);
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootFetch("/me", {})).resolves.toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an HTTP error response — a status is an answer, not a stall", async () => {
    const boom = new Response("{}", { status: 503 });
    const fetchMock = vi.fn(async () => boom);
    vi.stubGlobal("fetch", fetchMock);

    // Returned, not thrown: the caller's own `!res.ok` arm owns status
    // handling (and 401 already has its dedicated path through on401).
    await expect(bootFetch("/me", {})).resolves.toBe(boom);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transport failure and returns the eventual success", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = bootFetch("/me", {});
    await vi.advanceTimersByTimeAsync(totalBackoffMs);

    await expect(promise).resolves.toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt and rejects with the transport error", async () => {
    const err = new TypeError("Failed to fetch");
    const fetchMock = vi.fn<() => Promise<Response>>().mockRejectedValue(err);
    vi.stubGlobal("fetch", fetchMock);

    const promise = bootFetch("/me", {});
    const settled = expect(promise).rejects.toBe(err);
    await vi.advanceTimersByTimeAsync(totalBackoffMs);
    await settled;

    // Bounded: the retry loop must terminate, or it becomes the very hang it
    // exists to prevent.
    expect(fetchMock).toHaveBeenCalledTimes(BOOT_FETCH_ATTEMPTS);
  });

  it("bounds every attempt with an abort signal", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await bootFetch("/me", { headers: { authorization: "Bearer t" } });

    const init = initOfCall(fetchMock.mock.calls, 0);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The caller's own init must survive — dropping the bearer here would
    // 401 every boot.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
  });

  it("bounds each attempt with the configured timeout, not an arbitrary one", async () => {
    // Without this, BOOT_FETCH_TIMEOUT_MS could be deleted and every other
    // test here would still pass. It asserts the WIRING (the constant reaches
    // the platform call); the wall-clock abort itself is the platform's
    // contract, which `vi.useFakeTimers` does not drive.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    await bootFetch("/me", {});

    expect(timeoutSpy).toHaveBeenCalledWith(BOOT_FETCH_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  it("treats an attempt killed by its own timeout as retryable", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      // What the platform hands back when an AbortSignal.timeout fires.
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = bootFetch("/me", {});
    await vi.advanceTimersByTimeAsync(totalBackoffMs);

    await expect(promise).resolves.toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries an attempt whose BODY aborts, and hands back a body the caller can read", async () => {
    // #779.4 — `fetch` resolves at the HEADERS and the signal stays live on the
    // Response, but every caller (`me`, `listNetworks`, `listChannels`) reads
    // the body AFTER bootFetch has returned. A body still streaming when the
    // per-attempt budget expires aborted out there, where the retry loop could
    // not see it: a boot that failed and never tried again. Plausible on a slow
    // link with a large `/me` envelope (read_cursors + unread_counts).
    const aborting = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        },
      }),
      { status: 200 },
    );
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(aborting)
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = bootFetch("/me", {});
    await vi.advanceTimersByTimeAsync(totalBackoffMs);
    const res = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("gives each attempt its own signal, so attempt 1's timeout cannot abort attempt 2", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = bootFetch("/me", {});
    await vi.advanceTimersByTimeAsync(totalBackoffMs);
    await promise;

    const first = initOfCall(fetchMock.mock.calls, 0).signal;
    const second = initOfCall(fetchMock.mock.calls, 1).signal;
    expect(first).not.toBe(second);
  });
});
