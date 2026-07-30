// #554 — an operator KILL / services AKILL is terminal, not a Backoff
// reconnect.
//
// A peer OPERs up against the testnet O:line (testoper/testoperpass) and
// KILLs the seeded vjt session's upstream nick (NETWORK_NICK). The proof
// is server-side via REST: the credential transitions to connection_state
// "failed" with a reason starting "killed:", and STAYS failed — no
// Backoff auto-reconnect flip back to "connected". This also proves the
// load-bearing domain assumption that bahamut delivers the KILL to the
// victim with the victim's own nick as target (hybrid m_kill); if it did
// not, the terminal path would never fire and this spec goes RED.
//
// cic's dedicated rendering of the "killed" reason is a follow-up; this
// asserts the SERVER contract (the REST door of the same domain event,
// per "one feature, one code path, every door").
//
// CLEANUP: afterEach reconnects the network + polls #bofh back to joined,
// mirroring issue100-reconnecting-badge, so the next spec on the shared
// testnet inherits a live session.

import { test, expect } from "../fixtures/test";
import { IrcPeer } from "../fixtures/ircClient";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";
import { GRAPPA_BASE_URL, patchNetworkConnectionState } from "../fixtures/grappaApi";

const OPER_NAME = "testoper";
const OPER_PASS = "testoperpass";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// 90s — precondition poll + oper + KILL propagation + the 8s
// no-reconnect dwell + afterEach autojoin poll (~30s) + testnet-load
// margin. Same budget as the sibling park/reconnect specs.
test.setTimeout(90_000);

async function networkState(
  token: string,
): Promise<{ state: string; reason: string | null }> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /networks → ${res.status}`);
  const nets = (await res.json()) as Array<{
    slug: string;
    connection_state: string;
    connection_state_reason: string | null;
  }>;
  const net = nets.find((n) => n.slug === NETWORK_SLUG);
  if (!net) throw new Error(`network ${NETWORK_SLUG} not found in GET /networks`);
  return { state: net.connection_state, reason: net.connection_state_reason };
}

test.afterEach(async () => {
  const vjt = getSeededVjt();
  await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
    connection_state: "connected",
  }).catch(() => {});

  const channelsUrl = `${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/channels`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await fetch(channelsUrl, {
      headers: { authorization: `Bearer ${vjt.token}` },
    }).catch(() => null);
    if (res?.ok) {
      const channels = (await res.json()) as Array<{ name: string; joined: boolean }>;
      if (channels.find((c) => c.name === SEED_CHANNEL)?.joined) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
});

test("#554 — operator KILL marks the network :failed with a killed reason and does not reconnect", async () => {
  const vjt = getSeededVjt();

  // Precondition: the seeded session is connected.
  await expect
    .poll(async () => (await networkState(vjt.token)).state, { timeout: 30_000 })
    .toBe("connected");

  const peer = await IrcPeer.connect({ nick: "kill554op" });
  try {
    await peer.oper(OPER_NAME, OPER_PASS);
    peer.kill(NETWORK_NICK, "operator kill #554");

    // The credential goes :failed with a "killed:" reason.
    await expect
      .poll(async () => (await networkState(vjt.token)).state, { timeout: 30_000 })
      .toBe("failed");

    const { reason } = await networkState(vjt.token);
    expect(reason ?? "").toMatch(/^killed:/);

    // ...and STAYS failed — no Backoff auto-reconnect for ~8s.
    await new Promise((r) => setTimeout(r, 8_000));
    expect((await networkState(vjt.token)).state).toBe("failed");
  } finally {
    await peer.disconnect();
  }
});
