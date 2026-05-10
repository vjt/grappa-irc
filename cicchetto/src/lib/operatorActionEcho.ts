// "Operator-action echo" predicate — server-originated rows whose
// arrival is directly caused by the operator's own action and therefore
// must NOT count as unread (sidebar badge bump or in-pane unread-marker
// row inflation).
//
// Today this covers numeric-derived NOTICE rows: when /msg, /mode, /who
// etc. fail or get acknowledged, the server reply lands as a kind:"notice"
// scrollback row carrying meta.numeric (set by Session.Server
// .handle_numeric_with_routing → Wire.message_payload). The numeric is
// the discriminator — a peer-originated NOTICE (NickServ greeting,
// another user's /notice) has empty meta and is a real unsolicited
// message that SHOULD bump unread.
//
// Mirrors the BUG5b own-presence-event suppression in subscribe.ts:
// "the operator owns this; don't alert them about their own thing."
//
// Single source of truth — both subscribe.ts (sidebar badge gate) and
// ScrollbackPane.tsx (in-pane unread-marker count) call this so the two
// signals stay aligned. Adding a new "operator-action echo" class (e.g.
// labeled-response routed message kind) extends this one predicate.
//
// CP20-fix carve-out for $server window: numeric-derived NOTICEs routed
// to the per-network server-messages window are NOT echoes — that window
// EXISTS to surface routed server output (MOTD, RPL_NOWAWAY, untargeted
// NOTICEs, lifecycle events). Suppressing them silences the very signal
// the window is built to render. The original CP20 case (401 ghost-DM
// suppression) survives: 401 lands in the new ghost-nick query window,
// not in $server, so the predicate still fires there.
//
// The boundary is the routing TARGET (where the row landed), not the
// row's `meta.numeric` shape alone.

import type { ScrollbackMessage } from "./api";
import { SERVER_WINDOW_NAME } from "./windowKinds";

export const isOperatorActionEcho = (message: ScrollbackMessage): boolean => {
  if (message.kind !== "notice") return false;
  if (message.channel === SERVER_WINDOW_NAME) return false;
  const meta = message.meta as { numeric?: unknown } | null | undefined;
  return typeof meta?.numeric === "number";
};
