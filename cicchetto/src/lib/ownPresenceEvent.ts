// "Own presence event" predicate — scrollback rows whose sender is the
// operator's own per-network nick AND whose kind is a presence verb
// (join / part / quit / nick_change / mode / kick). The operator drove
// these actions; surfacing them as unread (sidebar/bottom-bar badge bump
// or in-pane unread-marker count) is a false alert, same logical class
// as `isOperatorActionEcho` (server-emitted replies to operator actions).
//
// Single source of truth — both subscribe.ts (sidebar badge gate, line
// 191) and ScrollbackPane.tsx (in-pane unread-marker filter) call this
// so the two signals stay aligned. Adding a future presence kind (e.g.
// `topic` if operator-set) extends this one predicate.
//
// Kind set mirrors subscribe.ts's pre-R-6 inline `isPresenceKind` check.
// `topic` is intentionally NOT included — `kind: "topic"` events arrive
// via the `topic_changed` WS event surface, not as scrollback rows;
// when an operator-driven topic change DOES persist as a scrollback
// `kind: "topic"` row in some future shape, extend the kind set here.
//
// CP29 R-6: in-pane unread-marker (ScrollbackPane.tsx:511-514) gating —
// pre-R-6 the marker filter only excluded `isOperatorActionEcho`, so
// after `/part → /join` the operator's own JOIN row landed in the
// `(cursor, sessionTopId]` window and produced a phantom "1 unread
// message" marker. The sidebar/bottom-bar badge gate already worked
// (subscribe.ts dropped the bump pre-routeMessage); the in-pane marker
// derivation in ScrollbackPane was the silent leak class. Same predicate,
// two surfaces.

import type { ScrollbackMessage } from "./api";
import { nickEquals } from "./nickEquals";

const PRESENCE_KINDS = new Set<ScrollbackMessage["kind"]>([
  "join",
  "part",
  "quit",
  "nick_change",
  "mode",
  "kick",
]);

export const isOwnPresenceEvent = (message: ScrollbackMessage, ownNick: string | null): boolean => {
  if (ownNick === null) return false;
  if (!PRESENCE_KINDS.has(message.kind)) return false;
  return nickEquals(message.sender, ownNick);
};
