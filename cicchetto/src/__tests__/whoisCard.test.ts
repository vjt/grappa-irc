import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhoisBundle } from "../lib/api";

// C2 — single-slot WHOIS card store: at most one bundle per network slug,
// owned by the user-issued `/whois` scrollback card. Distinct from the
// per-nick `railWhois.ts` cache (#606). Coverage lived inline in
// WhoisCard.test until #606 made the component prop-driven; it moves here.

vi.mock("../lib/auth", async () => {
  const { createSignal } = await import("solid-js");
  const [tok, setTok] = createSignal<string | null>("tokA");
  return { token: tok, setToken: setTok };
});

const bundle = (target: string): WhoisBundle => ({
  network: "azzurra",
  target,
  source: "user",
  user: null,
  host: null,
  realname: null,
  server: null,
  server_info: null,
  is_operator: false,
  oper_text: null,
  idle_seconds: null,
  signon: null,
  channels: null,
  using_ssl: false,
  is_registered: false,
  is_admin: false,
  is_services_admin: false,
  is_helper: false,
  is_chanop: false,
  is_agent: false,
  is_java: false,
  umodes: null,
  away_message: null,
  actually_host: null,
  actually_ip: null,
  account: null,
  secure: false,
  secure_cipher: null,
  certfp: null,
  extra_lines: null,
  avatar_url: null,
  grappa_client_ips: null,
  grappa_client_last_known_ip: null,
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("whoisCard store", () => {
  it("setWhoisBundle stores one bundle per slug, reactively", async () => {
    const { setWhoisBundle, whoisCardBySlug } = await import("../lib/whoisCard");
    const seen: (string | undefined)[] = [];
    createRoot(() => {
      createEffect(() => seen.push(whoisCardBySlug().azzurra?.target));
    });
    expect(seen.at(-1)).toBeUndefined();
    setWhoisBundle("azzurra", bundle("alice"));
    await Promise.resolve();
    expect(whoisCardBySlug().azzurra?.target).toBe("alice");
    expect(seen.at(-1)).toBe("alice");
  });

  it("setWhoisBundle replaces the prior bundle for the same slug (single slot)", async () => {
    const { setWhoisBundle, whoisCardBySlug } = await import("../lib/whoisCard");
    setWhoisBundle("azzurra", bundle("alice"));
    setWhoisBundle("azzurra", bundle("bob"));
    expect(whoisCardBySlug().azzurra?.target).toBe("bob");
  });

  it("keeps bundles for different slugs independent", async () => {
    const { setWhoisBundle, whoisCardBySlug } = await import("../lib/whoisCard");
    setWhoisBundle("azzurra", bundle("alice"));
    setWhoisBundle("libera", bundle("carol"));
    expect(whoisCardBySlug().azzurra?.target).toBe("alice");
    expect(whoisCardBySlug().libera?.target).toBe("carol");
  });

  it("dismissWhoisCard clears only the named slug", async () => {
    const { setWhoisBundle, dismissWhoisCard, whoisCardBySlug } = await import("../lib/whoisCard");
    setWhoisBundle("azzurra", bundle("alice"));
    setWhoisBundle("libera", bundle("carol"));
    dismissWhoisCard("azzurra");
    expect(whoisCardBySlug().azzurra).toBeUndefined();
    expect(whoisCardBySlug().libera?.target).toBe("carol");
  });

  it("wipes all bundles on identity rotation", async () => {
    const { setWhoisBundle, whoisCardBySlug } = await import("../lib/whoisCard");
    const auth = await import("../lib/auth");
    setWhoisBundle("azzurra", bundle("alice"));
    (auth as unknown as { setToken: (t: string | null) => void }).setToken("tokB");
    await Promise.resolve();
    expect(whoisCardBySlug().azzurra).toBeUndefined();
  });
});
