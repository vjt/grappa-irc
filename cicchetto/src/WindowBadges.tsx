import { type Component, Show } from "solid-js";
import type { ChannelKey } from "./lib/channelKey";
import { isConversationMuted } from "./lib/conversationMute";
import { getShowEventBadge } from "./lib/eventBadge";
import { mentionCounts } from "./lib/mentions";
import { notificationPrefs } from "./lib/notificationPrefs";
import { farBehindByChannel } from "./lib/scrollback";
import { eventsUnread, messagesUnread } from "./lib/selection";

// The unread / events / mention badge triad that trails a window row.
//
// Six verbatim copies of it used to sit inline — three in `Sidebar.tsx`
// (server header, channel list, query list) and three in `BottomBar.tsx`
// (the same three windows, mobile). #888 needed ONE predicate added to all
// six; pasting it six times is exactly the copy-paste-with-tweaks CLAUDE.md
// forbids, and the seventh window surface would have inherited five of the
// six behaviours. So the triad lives here once and the two surfaces differ
// only in the class prefix they were already using.
//
// The prefix is a closed set resolved through this table rather than
// interpolated, so a typo is a type error and every class name stays
// greppable from the stylesheet.
const BADGE_CLASSES = {
  sidebar: {
    messages: "sidebar-msg-unread",
    events: "sidebar-events-unread",
    mention: "sidebar-mention",
  },
  "bottom-bar": {
    messages: "bottom-bar-msg-unread",
    events: "bottom-bar-events-unread",
    mention: "bottom-bar-mention",
  },
} as const;

export type WindowBadgesVariant = keyof typeof BADGE_CLASSES;

// #888 — the modifier that says "this number is a DISTANCE, not a counter".
// Shared by both variants: the stylesheet qualifies it per badge class, but
// the token itself is one string so the two surfaces cannot drift apart.
export const FAR_BEHIND_CLASS = "far-behind";

// #1077 — the modifier that says "this conversation is muted". Same shape as
// FAR_BEHIND_CLASS for the same reason: one token, qualified per badge class
// in the stylesheet, so the two surfaces cannot drift.
//
// It REVISES #866 Q4, which had answered "does the mute change the badge?"
// with no. It still does not change what the badge MEANS or what it counts —
// only how loudly it says it. Dimming, deliberately not a second colour: a
// different hue would make the muted badge a different KIND of thing, and
// the ask was for the same thing, quieter.
export const MUTED_CLASS = "conversation-muted";

export type BadgeKind = "messages" | "events";

// What the badge SAYS, as opposed to what it shows. A bare "1832" inside a
// row button is announced as a number with no unit and no state, which is
// how a frozen far-behind count (#693) became indistinguishable from a live
// one — two people read it as a broken counter on IRC the day #888 was
// filed. The far-behind wording names the state AND the way out, at the
// place the number is seen. `kind` is explicit rather than defaulted: the
// events badge is frozen for the same reason but is not counting messages,
// and a silent default would have it lie.
export const badgeLabel = (count: number, kind: BadgeKind, farBehind: boolean): string =>
  farBehind
    ? `${count} ${kind} behind — jump to the boundary to catch up`
    : `${count} unread ${kind}`;

type Props = {
  channelKey: ChannelKey;
  variant: WindowBadgesVariant;
};

const WindowBadges: Component<Props> = (props) => {
  const classes = () => BADGE_CLASSES[props.variant];
  // Read the signal, not a snapshot: `dismissFarBehind` / `jumpToUnread`
  // clear the record and the modifier must clear with it (#888 acceptance).
  const farBehind = () => farBehindByChannel()[props.channelKey] !== undefined;
  const messages = () => messagesUnread()[props.channelKey] ?? 0;
  // #2037 B — `!messaggi` render only when opted in. Gated on the SIGNAL, not
  // a snapshot, so flipping the checkbox clears the pills without a reload.
  //
  // Zeroed rather than hidden at the `<Show>`: the count feeds `title` and
  // `aria-label` too, and a hidden element whose accessible name still claims
  // "216 unread events" is the wrong half of the change. Zero fails the
  // `> 0` guard once, for every consumer in this component.
  const events = () => (getShowEventBadge() ? (eventsUnread()[props.channelKey] ?? 0) : 0);
  const mentions = () => mentionCounts()[props.channelKey] ?? 0;
  // #1077 — the SAME predicate the cycle-skip consults (`activeWindows`
  // .orderUnreadWindows, #1018), so the badge cannot drift from the mute it
  // is reporting. `notificationPrefs()` is read as a signal, not snapshotted:
  // lifting a mute must restore full brightness without a reload.
  //
  // #1038 retracted #866 Q5's network-AGNOSTIC mute key: the key IS the
  // composite (network, target) ChannelKey now, which is exactly what
  // `props.channelKey` already holds — so the decode-and-refold this used to
  // do is not merely redundant, it would rebuild the same string. A query
  // window's `channelName` IS the peer nick, so this covers DMs with no
  // second branch.
  const muted = () => isConversationMuted(notificationPrefs().muted_targets, props.channelKey);

  // BOTH unread badges take the treatment, not just the message one: the
  // far-behind branch of `perChannelUnread` skips local counting wholesale and
  // serves the far-behind record's own `missed`/`events` for BOTH kinds
  // (#2037; it displaced the server seed there), so both are equally stuck
  // behind a frozen cursor. The mention badge is left alone — it is
  // server-authoritative and counted a different way (#267), so the cursor
  // freeze does not pin it.
  //
  // `role="img"` + `aria-label` on both unread badges, unconditionally. The
  // label carries the whole meaning, so the far-behind state is spoken
  // ("1832 messages behind…") instead of arriving as a number that sounds
  // exactly like a live one. Unconditional because the role is what makes
  // `aria-label` legal on a <span> at all (a generic element does not support
  // it), and a role that appears only in one state is a role a linter cannot
  // check and a reader cannot predict. Same shape as the away badge in
  // `Sidebar.tsx`. `title` is the sighted-hover twin, and is added only in the
  // far-behind state: a tooltip reading "5 unread messages" over a "5" is
  // noise.
  return (
    <>
      <Show when={messages() > 0}>
        <span
          class={classes().messages}
          classList={{ [FAR_BEHIND_CLASS]: farBehind(), [MUTED_CLASS]: muted() }}
          role="img"
          title={farBehind() ? badgeLabel(messages(), "messages", true) : undefined}
          aria-label={badgeLabel(messages(), "messages", farBehind())}
        >
          {messages()}
        </span>
      </Show>
      <Show when={events() > 0}>
        <span
          class={classes().events}
          classList={{ [FAR_BEHIND_CLASS]: farBehind(), [MUTED_CLASS]: muted() }}
          role="img"
          title={farBehind() ? badgeLabel(events(), "events", true) : undefined}
          aria-label={badgeLabel(events(), "events", farBehind())}
        >
          {events()}
        </span>
      </Show>
      <Show when={mentions() > 0}>
        <span class={classes().mention} classList={{ [MUTED_CLASS]: muted() }}>
          @{mentions()}
        </span>
      </Show>
    </>
  );
};

export default WindowBadges;
