import { addNetwork } from "./api";
import { refetchNetworks, refetchUser } from "./networks";

// issue 2703 — THE attach verb: put an available network on this session.
//
// Two doors reach it. The home page's "Available to connect" row is a tap on a
// network the subject chose; an invite link (`?go=<network>/<channel>`) names a
// network the recipient has not bound yet, and attaches it before it joins.
// Both used to be one door, and the body below lived inside HomePane's
// `onConnect`. A second caller with a private copy of "POST, then re-read" is
// the drift CLAUDE.md's one-feature-one-code-path rule exists to stop, so the
// body moved here and both doors call it.
//
// It is the REST call plus the two reads that make the attach visible:
//
//   * `refetchUser`     — the `/me` envelope, where `home_data` lives: the
//                         network leaves `available_networks` and gains a row.
//   * `refetchNetworks` — `GET /networks`, the sidebar and `networkBySlug`.
//
// No optimistic local write (cic never originates state): the server spawns
// the session and these two reads are what bring it in. The `network_attached`
// broadcast refetches the same two on every tab of the account, this one
// included; the explicit pair here is the read-after-write for the tab that
// asked, which must not wait on a socket it may not have yet.
//
// Throws what `addNetwork` throws — an `ApiError` carrying the server's token
// (403 `network_not_visitor_enabled`, 409 `already_attached`, 503 caps and
// circuit). Each caller owns its own error surface, and the two differ: the
// home row prints inline, the invite raises a toast, and only the invite reads
// a 409 as "attached, go on".
export async function attachNetwork(token: string, networkSlug: string): Promise<void> {
  await addNetwork(token, networkSlug);
  refetchUser();
  refetchNetworks();
}
