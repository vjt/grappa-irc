import { describe, expect, it } from "vitest";

// Guards the setupTests inert-WebSocket contract: vitest must NEVER open a
// real socket. jsdom 29 ships a ws-backed WebSocket that attempts a real
// TCP connect; a phoenix Socket reaching it (any test file where the
// lib/socket module-level token effect fires with a non-null bearer and
// phoenix isn't module-mocked) gets a failed transport, and phoenix's
// reconnect backoff leaves Node-level timers that outlive the file's jsdom
// env — the timer callback then hits the torn-down `location` global and
// crashes the worker with an uncaught ReferenceError attributed to whatever
// test file happens to be running ("location is not defined", flaky full-run
// exit 1, todo 2026-06-09).
describe("inert WebSocket stub", () => {
  it("constructing + waiting never errors, closes, or leaves the CONNECTING state", async () => {
    const ws = new WebSocket("ws://127.0.0.1:9/socket");
    const events: string[] = [];
    ws.onerror = () => events.push("error");
    ws.onclose = () => events.push("close");
    ws.onopen = () => events.push("open");
    // Give a real (ws-backed) implementation ample time to fail the TCP
    // connect to the discard port and fire error/close.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
  });

  it("close() parks the instance in CLOSED without dispatching events", () => {
    const ws = new WebSocket("ws://127.0.0.1:9/socket");
    const events: string[] = [];
    ws.onclose = () => events.push("close");
    ws.close();
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(events).toEqual([]);
  });

  it("send() before open is a no-op instead of an InvalidStateError throw", () => {
    const ws = new WebSocket("ws://127.0.0.1:9/socket");
    expect(() => ws.send("heartbeat")).not.toThrow();
  });
});
