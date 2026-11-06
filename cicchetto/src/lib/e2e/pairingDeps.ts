// issue 2430 — what a pairing screen hands the session (`pairingSession.ts`):
// this browser's E2E stores, the login, the account, and the networks this
// account has. Kept out of the screens so they stay a view over the session.
// The rail's device verbs (whether this browser holds the master, the
// identity's devices, a revoke: issue 2544) bind the same three here.

import { createEffect, createRoot } from "solid-js";
import { me } from "../api";
import { token } from "../auth";
import { networkBySlug, networks } from "../networks";
import { browserE2e } from "./browser";
import { accountSlot, masterOf, type OwnDevice, ownDevices, revokeDevice } from "./identity";
import type { HolderDeps } from "./pairingSession";

// The account is read from grappa (`/me`, shared with the networks resource),
// not from `user()`: `/pair` runs outside RequireAuth, so that resource may
// not have answered when the screen needs it.
const subjectOf = async (bearer: string): Promise<HolderDeps["subject"]> => {
  const account = await me(bearer, "shared");
  return { kind: account.kind, id: account.id };
};

// Resolves once the networks resource has an answer, rejects if it failed.
// The session reads `networks()` synchronously, and a cold `/pair` load can
// reach it before the resource has loaded (every network would read as
// absent) or after it errored (the read would throw): both are settled here.
const networksSettled = (): Promise<void> =>
  new Promise((resolve, reject) => {
    createRoot((dispose) => {
      createEffect(() => {
        const state = networks.state;
        if (state !== "ready" && state !== "errored") return;
        dispose();
        if (state === "ready") resolve();
        else reject(networks.error);
      });
    });
  });

/** The deps of a holder or a joiner pairing for the logged-in account. */
export async function pairingDeps(bearer: string): Promise<HolderDeps> {
  const [e2e, subject] = await Promise.all([browserE2e(), subjectOf(bearer)]);
  await networksSettled();
  return {
    e2e,
    bearer,
    subject,
    networks: () => (networks() ?? []).map(({ slug, id }) => ({ slug, id })),
  };
}

// This browser's account store, the login, and the network's account slot;
// null without a login or a network of that slug.
async function slotHere(slug: string) {
  const bearer = token();
  const network = networkBySlug(slug);
  if (bearer === null || network === undefined) return null;
  const [{ accounts }, subject] = await Promise.all([browserE2e(), subjectOf(bearer)]);
  return { accounts, bearer, slot: accountSlot(subject, network.id) };
}

/** Whether this browser holds the master of the network's identity, so it may add devices to it. */
export async function holdsMasterHere(slug: string): Promise<boolean> {
  const here = await slotHere(slug);
  return here !== null && (await masterOf(here.accounts, here.slot)) !== null;
}

/** The devices of the network's identity, this browser's marked (`ownDevices`); null without one here. */
export async function ownDevicesHere(slug: string): Promise<OwnDevice[] | null> {
  const here = await slotHere(slug);
  return here === null ? null : ownDevices(here.accounts, here.bearer, here.slot, slug);
}

/** Revokes the device `ed25519` from the network's identity, from the master's browser (`revokeDevice`). */
export async function revokeDeviceHere(
  slug: string,
  ed25519: string,
): Promise<"revoked" | "failed" | "list-changed"> {
  const here = await slotHere(slug);
  return here === null
    ? "failed"
    : revokeDevice(here.accounts, here.bearer, here.slot, slug, ed25519);
}
