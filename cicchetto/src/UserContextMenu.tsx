import { type Component, onMount } from "solid-js";
import ContextMenu, { type ContextMenuAction, type ContextMenuItem } from "./ContextMenu";
import { token } from "./lib/auth";
import { casemappingForSlug } from "./lib/casemapping";
import { sendCtcpQuery } from "./lib/ctcpQuery";
import { openEncryptedWindow } from "./lib/encryptedWindow";
import { addIgnore, delIgnore, ignoresBySlug, refreshIgnores } from "./lib/ignoreList";
import { asciiFold, nickEquals } from "./lib/nickEquals";
import { banMenuItems, runOpsVerb } from "./lib/opsMenu";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { setSelectedChannel } from "./lib/selection";
import {
  pushChannelDeop,
  pushChannelDevoice,
  pushChannelKick,
  pushChannelOp,
  pushChannelVoice,
  pushWhois,
} from "./lib/socket";

// Right-click context menu for member-list nicks (spec #3, C5.1).
//
// Op / deop / voice / devoice / kick and the issue 2346 ban rows (Ban nick /
// Ban host / Kickban, from `lib/opsMenu`) are all gated on own-nick @ mode,
// disabled-but-NOT-hidden when unmet; WHOIS + CTCP + Query are always enabled,
// and so is "Encrypted query" (issue 2430) unless the nick is our own.
//
// Dispatches to existing socket.ts push helpers — no new IRC-issuance path —
// and every op verb goes through `runOpsVerb`, so a rejected push is a toast
// rather than an unhandled rejection behind a menu that has already closed.
//
// The chrome (portal, backdrop, Escape, the #487 measured viewport clamp) lives
// in `ContextMenu`, shared since #1067 added the long-press message menu. This
// module is now only the item list.
//
// #1192 added a ninth entry: a CTCP group that drills down rather than six more
// rows on a menu that already has eight.
//
// issue 2483 added the Ignore/Unignore row: the same `ignoreList.ts` door the
// `/ignore` verb and the settings sub-page use, labelled by the list itself.

// #1192 — the verbs worth a menu row. Small and closed on purpose: `/ctcp` is
// still there for anything else, and every entry here costs a row on a menu
// that a thumb has to hit.
//
// Neither VERSION nor CLIENTINFO is verifiable — both are strings the remote
// client picks for itself (CLIENTINFO is the verbs it claims to answer, which
// is capability discovery, not identity). They are worth asking; they are not
// worth believing.
const CTCP_VERBS = ["VERSION", "TIME", "PING", "CLIENTINFO", "USERINFO", "SOURCE"] as const;

export type Props = {
  networkSlug: string;
  networkId: number;
  channelName: string;
  targetNick: string;
  // issue 2346 — the host when the opener already has it (a join/part/quit
  // row's prefix), so Ban host / Kickban skip the USERHOST lookup; null from
  // every other opener.
  targetHost: string | null;
  ownModes: string[];
  // issue 2430 — our nick on this network, as the opener resolved it
  // (`ownNickForNetwork`); null when it has none. Gates "Encrypted query".
  ownNick: string | null;
  position: { x: number; y: number };
  onClose: () => void;
};

const UserContextMenu: Component<Props> = (props) => {
  const isOp = (): boolean => props.ownModes.includes("@");

  // issue 2483 — the row is Ignore or Unignore depending on whether this nick
  // is already on the network's list. The list lives in `ignoreList.ts`, the
  // store `/ignore` and the settings sub-page write, so a menu opened after
  // either of them sees the truth without a second source.
  //
  // The mask is the bare `nick!*@*` the server itself normalises `/ignore
  // alice` to (Grappa.IRC.Mask.normalize/2), which is why the comparison
  // folds both sides: the stored entry is the NORMALISED mask, and a nick's
  // case is the server's business, not ours.
  //
  // Only the PERSON entry counts — that mask with no text pattern. Since issue
  // 2294 an entry is the pair (mask, text_pattern), and a targeted one
  // (`alice!*@*` + `*spam*`) silences some of her lines, not her. Counting it
  // would offer an Unignore whose pattern-less removal touches nothing
  // (`UserSettings.remove_ignore/5`), and a person nobody can ignore.
  const ignoreMask = (): string => `${props.targetNick}!*@*`;
  const alreadyIgnored = (): boolean => {
    const want = asciiFold(ignoreMask());
    return (ignoresBySlug()[props.networkSlug] ?? []).some(
      (e) => e.text_pattern === null && asciiFold(e.mask) === want,
    );
  };

  // The store only holds what a server round-trip returned, and a menu can be
  // the first thing opened after a reload — an empty list would then read as
  // "not ignored" for a nick that is. Fetch when this network has never been
  // loaded; a failure leaves the row on Ignore, which the server answers
  // idempotently ("is already ignored") rather than doing the wrong thing.
  onMount(() => {
    const t = token();
    if (t === null || ignoresBySlug()[props.networkSlug] !== undefined) return;
    void refreshIgnores(t, props.networkSlug).catch((err: unknown) => {
      console.warn(`[ignore-menu] could not load the ignore list for ${props.networkSlug}`, err);
    });
  });

  // issue 2483 — same door as `/ignore <nick>` / `/unignore <nick>`: the
  // ignoreList store, which mirrors the server's answer. Detached like every
  // other row here — a menu item has no inline error channel — but never bare,
  // so a refused mutation is a console line and not an unhandled rejection.
  const ignoreAction = (): void => {
    const t = token();
    if (t === null) return;
    const slug = props.networkSlug;
    const mask = ignoreMask();
    const op = alreadyIgnored() ? delIgnore(t, slug, mask, null) : addIgnore(t, slug, mask, null);
    void op.catch((err: unknown) => {
      console.warn(`[ignore-menu] ${alreadyIgnored() ? "unignore" : "ignore"} ${mask} failed`, err);
    });
  };

  // Every verb dispatches identically — the seam owns the #640 source-window
  // echo and the #600 register-before-send ordering, so there is nothing here
  // for PING to special-case. Args are empty: a menu row has no place to type
  // one, and a BARE ping is what correlates through the #637 token-less
  // fallback without the seam inventing wire bytes.
  //
  // Detached, because a menu item's action is synchronous and this menu has no
  // inline error channel the way the composer does. Never bare, though: an
  // unhandled rejection is how a throttled or WS-down probe becomes a row that
  // simply never appears. Same shape as compose.ts's detached fan-out — a
  // grep key and the reason it stopped.
  const ctcpItems = (): ContextMenuAction[] =>
    CTCP_VERBS.map((verb) => ({
      label: verb,
      enabled: true,
      action: (): void => {
        void sendCtcpQuery({
          networkSlug: props.networkSlug,
          networkId: props.networkId,
          sourceChannel: props.channelName,
          targetNick: props.targetNick,
          verb,
          args: "",
          sentAtMs: Date.now(),
        }).catch((err: unknown) => {
          console.warn(`[ctcp-menu] ${verb} to ${props.targetNick} never left:`, err);
        });
      },
    }));

  const items = (): ContextMenuItem[] => [
    {
      label: "Op",
      enabled: isOp(),
      action: () =>
        runOpsVerb("Op", pushChannelOp(props.networkId, props.channelName, [props.targetNick])),
    },
    {
      label: "Deop",
      enabled: isOp(),
      action: () =>
        runOpsVerb("Deop", pushChannelDeop(props.networkId, props.channelName, [props.targetNick])),
    },
    {
      label: "Voice",
      enabled: isOp(),
      action: () =>
        runOpsVerb(
          "Voice",
          pushChannelVoice(props.networkId, props.channelName, [props.targetNick]),
        ),
    },
    {
      label: "Devoice",
      enabled: isOp(),
      action: () =>
        runOpsVerb(
          "Devoice",
          pushChannelDevoice(props.networkId, props.channelName, [props.targetNick]),
        ),
    },
    {
      label: "Kick",
      // Bare KICK, no reason input prompt in C5.1.
      enabled: isOp(),
      action: () =>
        runOpsVerb(
          "Kick",
          pushChannelKick(props.networkId, props.channelName, props.targetNick, ""),
        ),
    },
    ...banMenuItems({
      networkId: props.networkId,
      networkSlug: props.networkSlug,
      channelName: props.channelName,
      nick: props.targetNick,
      host: props.targetHost,
      ownModes: props.ownModes,
    }),
    {
      // issue 2483 — the personal twin of the ban rows: the same "do something
      // about this nick" cluster, but a LOCAL rule that needs no channel
      // privilege, so it is always enabled. The label follows the list: a nick
      // already on it offers the way OFF, which is the only thing an operator
      // can be looking for when they right-click someone they never see.
      label: alreadyIgnored() ? "Unignore" : "Ignore",
      enabled: true,
      action: ignoreAction,
    },
    {
      label: "WHOIS",
      // Always enabled — no perm required.
      enabled: true,
      action: () => pushWhois(props.networkId, props.targetNick, null),
    },
    {
      // #1192 — sits between WHOIS and the query rows because it belongs with
      // WHOIS: both interrogate the person, while the queries talk to them.
      // Always enabled, like its neighbours — asking a peer for its VERSION
      // needs no channel privilege.
      label: "CTCP",
      enabled: true,
      submenu: ctcpItems(),
    },
    {
      // issue 2430 — the encrypted twin of Query: opens (and focuses) the
      // cic-local encrypted window. There is no encrypted query with oneself.
      // ABOVE Query, as #1192 put CTCP: the last row stays a verb that is
      // always enabled and closes the menu (the #487 clamp e2e clicks it).
      label: "Encrypted query",
      enabled: !nickEquals(props.targetNick, props.ownNick, casemappingForSlug(props.networkSlug)),
      action: () => {
        void openEncryptedWindow(props.networkSlug, props.targetNick).catch((err: unknown) => {
          console.warn(`[e2e] could not open an encrypted query with ${props.targetNick}`, err);
        });
      },
    },
    {
      label: "Query",
      // Always enabled — no perm required. Opens DM window + switches focus.
      // canonicalQueryNick wraps to keep focus on an existing
      // case-insensitive match (RFC 2812 §2.2 — IRC nicks are
      // case-insensitive).
      enabled: true,
      action: () => {
        const canonical = canonicalQueryNick(props.networkId, props.targetNick);
        openQueryWindowState(props.networkId, canonical, new Date().toISOString());
        setSelectedChannel({
          networkSlug: props.networkSlug,
          channelName: canonical,
          kind: "query",
        });
      },
    },
  ];

  return <ContextMenu items={items()} position={props.position} onClose={props.onClose} />;
};

export default UserContextMenu;
