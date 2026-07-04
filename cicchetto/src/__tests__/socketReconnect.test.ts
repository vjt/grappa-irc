import { describe, expect, it } from "vitest";
import { haltForOffline, kickReconnect, type ReconnectableSocket } from "../lib/socket";

// #119 (vjt refinement) — connectivity-driven reconnect kick. phoenix.js
// auto-reconnects natively with backoff; the DELTA we add is: on `online`
// force an IMMEDIATE reconnect (disconnect+connect) rather than waiting out
// the pending native backoff, and on `offline` disconnect() to halt futile
// retries on a dead network. These pure functions are the unit-testable seam
// (the real window listeners in socket.ts pass the live `_socket`).

function fakeSocket(connected: boolean): ReconnectableSocket & {
  connectCalls: number;
  disconnectCalls: number;
} {
  return {
    connected,
    connectCalls: 0,
    disconnectCalls: 0,
    isConnected(): boolean {
      return this.connected;
    },
    connect(): void {
      this.connectCalls++;
      this.connected = true;
    },
    disconnect(): void {
      this.disconnectCalls++;
      this.connected = false;
    },
  } as ReconnectableSocket & { connected: boolean; connectCalls: number; disconnectCalls: number };
}

describe("kickReconnect (online)", () => {
  it("is a no-op when no socket has been built yet", () => {
    expect(() => kickReconnect(null)).not.toThrow();
  });

  it("does not tear down a socket that is already connected", () => {
    const s = fakeSocket(true);
    kickReconnect(s);
    expect(s.disconnectCalls).toBe(0);
    expect(s.connectCalls).toBe(0);
  });

  it("forces an immediate reconnect (disconnect+connect) when the socket is down", () => {
    const s = fakeSocket(false);
    kickReconnect(s);
    expect(s.disconnectCalls).toBe(1);
    expect(s.connectCalls).toBe(1);
  });
});

describe("haltForOffline (offline)", () => {
  it("is a no-op when no socket has been built yet", () => {
    expect(() => haltForOffline(null)).not.toThrow();
  });

  it("disconnects to halt futile retries on a dead network", () => {
    const s = fakeSocket(true);
    haltForOffline(s);
    expect(s.disconnectCalls).toBe(1);
    expect(s.connectCalls).toBe(0);
  });
});
