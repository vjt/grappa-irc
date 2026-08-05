// #806 — the peer's inbound-PRIVMSG wait is the instrument a routing
// regression (#373) is judged by, so its failure message has to be
// evidence, not a shrug. These run under the cic vitest project (see
// vitest.config.ts) because the wait is deliberately free of the
// e2e-only `irc-framework` dependency.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PrivmsgEvent, awaitPrivmsg, type PrivmsgSource } from "./privmsgWait";

type FakeSource = PrivmsgSource & {
  emit: (nick: string, message: string) => void;
  attached: () => number;
};

function fakeSource(): FakeSource {
  const handlers = new Set<(event: PrivmsgEvent) => void>();
  return {
    on: (_event, handler) => {
      handlers.add(handler);
    },
    removeListener: (_event, handler) => {
      handlers.delete(handler);
    },
    emit: (nick, message) => {
      for (const handler of [...handlers]) handler({ nick, message });
    },
    attached: () => handlers.size,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Every rejection assertion goes through this: `.rejects` needs the
// promise to already be rejected by the time we await it, and the
// rejection is driven by fake timers.
async function failureOf(wait: Promise<void>): Promise<string> {
  try {
    await wait;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the wait to reject, but it resolved");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("awaitPrivmsg", () => {
  it("resolves when the expected message arrives", async () => {
    const source = fakeSource();
    const wait = awaitPrivmsg(source, {
      fromNick: "vjt-grappa",
      body: "followup",
      timeoutMs: 1_000,
      trigger: () => {},
    });
    await vi.advanceTimersByTimeAsync(10);
    source.emit("vjt-grappa", "followup-abc123");
    await expect(wait).resolves.toBeUndefined();
  });

  it("is already listening while the trigger runs, so a fast reply cannot race it", async () => {
    const source = fakeSource();
    const wait = awaitPrivmsg(source, {
      fromNick: "vjt-grappa",
      body: "followup",
      timeoutMs: 1_000,
      // The reply lands DURING the trigger — the listener must already
      // be attached, which is why arming stays ahead of the trigger.
      trigger: () => source.emit("vjt-grappa", "followup-abc123"),
    });
    await expect(wait).resolves.toBeUndefined();
  });

  it("clocks the timeout from the trigger, not from the arm", async () => {
    const source = fakeSource();
    // Trigger costs 900ms; delivery then costs 900ms. Clocked from the
    // arm that is 1800ms against a 1000ms budget — a false red. Clocked
    // from the trigger the delivery had 900 of its 1000ms.
    const wait = awaitPrivmsg(source, {
      fromNick: "vjt-grappa",
      body: "followup",
      timeoutMs: 1_000,
      trigger: () => sleep(900),
    });
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(900);
    source.emit("vjt-grappa", "followup-abc123");
    await expect(wait).resolves.toBeUndefined();
  });

  it("reports arrival offsets from the trigger, not from the arm", async () => {
    // Same reason the deadline is clocked from the trigger: an offset
    // measured from the arm silently includes however long the caller's
    // trigger took, which is exactly the confusion this instrument exists
    // to remove. Trigger costs 300ms, the noise lands 100ms after it.
    const source = fakeSource();
    const settled = failureOf(
      awaitPrivmsg(source, {
        fromNick: "vjt-grappa",
        body: "followup",
        timeoutMs: 1_000,
        trigger: () => sleep(300),
      }),
    );
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(100);
    source.emit("someone-else", "noise");
    await vi.advanceTimersByTimeAsync(5_000);
    const failure = await settled;
    expect(failure).toContain("+100ms");
    expect(failure).not.toContain("+400ms");
  });

  it("names the sender it actually saw when the message came from someone else", async () => {
    const source = fakeSource();
    const settled = failureOf(
      awaitPrivmsg(source, {
        fromNick: "vjt-grappa",
        body: "followup",
        timeoutMs: 1_000,
        trigger: () => {},
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    source.emit("vjt-grappa_", "followup-abc123");
    await vi.advanceTimersByTimeAsync(5_000);
    const failure = await settled;
    expect(failure).toContain("vjt-grappa_");
    expect(failure).toMatch(/OTHER SENDERS/);
    expect(failure).toContain("followup-abc123");
  });

  it("says WRONG BODY when the right sender said something else", async () => {
    const source = fakeSource();
    const settled = failureOf(
      awaitPrivmsg(source, {
        fromNick: "vjt-grappa",
        body: "followup",
        timeoutMs: 1_000,
        trigger: () => {},
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    source.emit("vjt-grappa", "some other line");
    await vi.advanceTimersByTimeAsync(5_000);
    const failure = await settled;
    expect(failure).toMatch(/WRONG BODY/);
    expect(failure).toContain("some other line");
  });

  it("says SILENCE when nothing at all reached the peer", async () => {
    const source = fakeSource();
    const settled = failureOf(
      awaitPrivmsg(source, {
        fromNick: "vjt-grappa",
        body: "followup",
        timeoutMs: 1_000,
        trigger: () => {},
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const failure = await settled;
    expect(failure).toMatch(/SILENCE/);
  });

  it("distinguishes a message that was merely late from one that never came", async () => {
    const source = fakeSource();
    const settled = failureOf(
      awaitPrivmsg(source, {
        fromNick: "vjt-grappa",
        body: "followup",
        timeoutMs: 1_000,
        trigger: () => {},
      }),
    );
    await vi.advanceTimersByTimeAsync(1_008);
    source.emit("vjt-grappa", "followup-abc123");
    await vi.advanceTimersByTimeAsync(5_000);
    const failure = await settled;
    expect(failure).toMatch(/LATE/);
    expect(failure).toContain("8ms");
    expect(failure).not.toMatch(/SILENCE/);
  });

  it("detaches its listener when the wait succeeds", async () => {
    const source = fakeSource();
    const wait = awaitPrivmsg(source, {
      fromNick: "vjt-grappa",
      body: "followup",
      timeoutMs: 1_000,
      trigger: () => {},
    });
    await vi.advanceTimersByTimeAsync(10);
    source.emit("vjt-grappa", "followup-abc123");
    await wait;
    expect(source.attached()).toBe(0);
  });

  it("detaches its listener when the wait times out", async () => {
    const source = fakeSource();
    const settled = failureOf(
      awaitPrivmsg(source, {
        fromNick: "vjt-grappa",
        body: "followup",
        timeoutMs: 1_000,
        trigger: () => {},
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(source.attached()).toBe(0);
  });

  it("propagates a failing trigger and detaches instead of waiting out the budget", async () => {
    const source = fakeSource();
    const boom = new Error("composeSend blew up");
    const settled = failureOf(
      awaitPrivmsg(source, {
        fromNick: "vjt-grappa",
        body: "followup",
        timeoutMs: 1_000,
        trigger: () => Promise.reject(boom),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toBe("composeSend blew up");
    expect(source.attached()).toBe(0);
  });
});
