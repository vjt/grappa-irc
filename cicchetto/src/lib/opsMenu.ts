import type { ContextMenuAction } from "../ContextMenu";
import { buildBanMask } from "./banMask";
import { banMaskFormValue } from "./banMaskPref";
import { casemappingForSlug } from "./casemapping";
import { channelKey } from "./channelKey";
import { friendlyError } from "./friendlyError";
import { banHost, kickban } from "./kickban";
import { membersByChannel } from "./members";
import { nickEquals } from "./nickEquals";
import { pushChannelBan } from "./socket";
import { createToastQueue } from "./toasts";

// issue 2346 — the channel-operator rows a MENU offers on a person, and the
// failure surface they share.
//
// Two menus offer the ban rows: the nick menu (`UserContextMenu`, from a
// right-click or a long-press on a nick) and the message menu on a
// join/part/quit row. One builder, so the two doors cannot disagree on a mask,
// a label or a gate — the drift #1156 filed for Reply.
//
// The old single "Ban" row is gone (vjt's ruling on the issue): it banned
// `nick!*@*`, which is exactly the mask a flapper rejoining under a fresh
// Guest nick walks straight past. The menu now says which of the two it means.

// A menu row's action is synchronous and the menu is gone by the time a push
// settles, so a failure has nowhere inline to land. It rides the app's one
// toast surface instead (`Toasts.tsx`), the way the message menu's Copy does —
// before this, a rejected op verb from the nick menu was an unhandled
// rejection and nothing else.
const failures = createToastQueue<{ message: string }>();
export const opsMenuToasts = failures.toasts;
export const dismissOpsMenuToast = failures.dismiss;

/** Run a menu verb detached; a rejection becomes a toast prefixed with `label`. */
export function runOpsVerb(label: string, push: Promise<void>): void {
  push.catch((e: unknown) => failures.queue({ message: `${label}: ${friendlyError(e)}` }));
}

// The shared verbs already return their error string rather than throw.
function reportError(pending: Promise<string | null>): void {
  void pending.then((message) => {
    if (message !== null) failures.queue({ message });
  });
}

export type BanMenuTarget = {
  networkId: number;
  networkSlug: string;
  channelName: string;
  nick: string;
  // The host the caller already has — a presence row's prefix — or null to
  // resolve it from the server's userhost cache at click time. Ban host only:
  // Kickban always resolves, because it kicks whoever holds the nick NOW and
  // a row's host may belong to an earlier holder of a recycled nick.
  host: string | null;
  ownModes: string[];
};

/**
 * Ban nick / Ban host / Kickban. Gated on own `@`, like every op row on the
 * nick menu (disabled, never hidden). Ban nick and Ban host are fixed forms;
 * Kickban bans in the subject's ban type (issue 2347). Kickban additionally needs the nick to
 * be IN the channel: a quit row's nick is gone, and there is no one to kick.
 * Reads the members store, so call it inside an accessor to stay reactive.
 */
export function banMenuItems(t: BanMenuTarget): ContextMenuAction[] {
  const isOp = t.ownModes.includes("@");
  const casemapping = casemappingForSlug(t.networkSlug);
  const present = (membersByChannel()[channelKey(t.networkSlug, t.channelName)] ?? []).some((m) =>
    nickEquals(m.nick, t.nick, casemapping),
  );
  return [
    {
      label: "Ban nick",
      enabled: isOp,
      action: () =>
        runOpsVerb(
          "Ban nick",
          pushChannelBan(
            t.networkId,
            t.channelName,
            buildBanMask("nick", { nick: t.nick, user: null, host: null }),
          ),
        ),
    },
    {
      label: "Ban host",
      enabled: isOp,
      action: () =>
        reportError(
          banHost({
            networkId: t.networkId,
            channel: t.channelName,
            nick: t.nick,
            knownHost: t.host,
            label: "Ban host",
          }),
        ),
    },
    {
      label: "Kickban",
      enabled: isOp && present,
      // Bare reason, like the Kick row: a menu has nowhere to type one.
      action: () =>
        reportError(
          kickban({
            networkId: t.networkId,
            channel: t.channelName,
            nick: t.nick,
            reason: "",
            // Read at the click, not at menu build: a change made in settings
            // while the menu is open still applies (issue 2347).
            form: banMaskFormValue(),
            label: "Kickban",
          }),
        ),
    },
  ];
}
