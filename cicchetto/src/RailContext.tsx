import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import EncryptedRail from "./EncryptedRail";
import { focusedEncryptedWindow, sameEncryptedWindow } from "./lib/encryptedWindow";
import { networkBySlug } from "./lib/networks";
import { railPeer } from "./lib/railPeer";
import { railWhoisFor, requestRailWhois } from "./lib/railWhois";
import { selectedChannel } from "./lib/selection";
import ServerInfoCard from "./ServerInfoCard";
import StartEncryptedChat from "./StartEncryptedChat";
import WhoisCard from "./WhoisCard";

// #474 — the rail's GENERIC per-window-kind context surface. Mounted as a
// sibling of the RailActions drawer inside `.shell-members` in BOTH Shell
// rail branches (desktop + mobile). It reads the active window's kind and
// grafts the matching context content:
//   * server → ServerInfoCard (connection facts already in the store)
//   * query  → the query context (#606, the deferred half of #474): a
//              heading, the button that asks the peer to start an encrypted
//              chat (issue 2486), and a WHOIS card for the conversation
//              partner. The card
//              REUSES the same `WhoisCard` presentation as the scrollback
//              overlay but is fed by the per-nick `railWhois` cache (NOT the
//              single-slot `whoisCard` store the user-issued /whois owns) and
//              carries no × affordance (persistent, like the server card).
//              It fetches the bundle when the card is ON SCREEN and the cache
//              has nothing for that nick (#782 — see the `onScreen` contract
//              below).
//   * encrypted → the same query context, its peer's WHOIS card included
//              (issue 2499, vjt's ruling: an addition to the query rail,
//              never a replacement for it). Where a plain query has its door,
//              the window being encrypted already, it has its technical half
//              (issue 2485, `EncryptedRail`): keys, trust, devices, the pin
//              form and the last identity check, which the chat window no
//              longer shows.
// It renders NOTHING for kinds with no context content (channel already has
// the MembersPane above; home/admin/list/mentions have none). Built as a
// container, not a hardcoded server card, so the rail is the per-kind
// context surface the RailActions moduledoc (#473) always earmarked.
//
// #782 — WHEN the rail may ask, and why it is VISIBILITY and not selection.
// #606 fetched on SELECT of a query window. That spent an upstream command
// filling a card the operator could not see: `.shell-members` is MOUNTED on
// both form factors and merely slid off-screen when closed
// (`transform: translateX(100%)`), so on mobile the default state is a card
// nobody is looking at. #800 measured the cost of that command landing on the
// operator's NEXT message and removed the fetch entirely, which left the card
// permanently empty. Both are wrong at one end. The rule that survives, and
// that this component now implements exactly:
//
//     The rail asks when — and only when — it is SHOWING a nick it does not
//     have. Not on a timer, not on a selection it cannot display.
//
// So the trigger is `onScreen`, supplied per mount site because only the
// mount site knows: the desktop rail is a permanent column (and a query
// window renders no MembersPane above it, so the card cannot be scrolled
// out), while the mobile drawer is on screen exactly when it is open. Passing
// it as a REQUIRED prop keeps this component blind to form factor and makes
// each Shell mount state its own truth — a default here would silently make
// the mobile drawer claim to be visible.

const TICK_MS = 60_000;

// The query context (#606), shared by a plain query and an encrypted one
// (issue 2499): a heading saying which conversation it is, the window's own
// `controls` under it (a plain query's door to ask for an encrypted chat,
// issue 2486; an encrypted query's key sections, issue 2485), and the peer's
// WHOIS card last. Last because the card is empty until the WHOIS answers,
// seconds after the window is shown (#782): above the controls, its arrival
// would push them down under the user's pointer.
const QueryContext: Component<{
  networkSlug: string;
  nick: string;
  heading: string;
  controls: JSX.Element;
}> = (props) => (
  <div class="rail-query-context" data-testid="rail-query-context">
    {/* Mirrors the MembersPane `<h3>members (n)</h3>` slot (uppercased by
        CSS). A peer rename moves no window (issue 1365), so the heading
        keeps the nick the window was opened under. */}
    <h3 class="rail-query-heading">
      {props.heading} {props.nick}
    </h3>
    {props.controls}
    <WhoisCard bundle={railWhoisFor(props.networkSlug, props.nick)} />
  </div>
);

export type Props = {
  /** True when this rail is actually on screen — desktop rail: always; mobile
      drawer: only while open. Gates the WHOIS fetch (#782). */
  onScreen: boolean;
};

const RailContext: Component<Props> = (props) => {
  // Coarse clock so a live "connected for Xh Ym" stays fresh. `.shell-members`
  // is a permanent column (#71 INC-2), so this ticker runs for the whole
  // authenticated session, not just while a server window is focused — off a
  // server window nothing reads `now()`, so those 60s ticks are harmless
  // no-op re-renders. Kept in the container (not ServerInfoCard) so the card
  // takes an injected `now` and stays deterministic under test; 60s
  // granularity is plenty for a duration read, torn down with the shell.
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), TICK_MS);
  onCleanup(() => clearInterval(timer));

  const sel = () => selectedChannel();
  // issue 2485 — keyed on the window, as Shell keys the pane.
  const encrypted = createMemo(focusedEncryptedWindow, null, { equals: sameEncryptedWindow });

  // Fetch-on-visible. The key composes BOTH halves of "showing a nick we may
  // not have": the peer on display (`railPeer`: a plain query's or, issue
  // 2499, an encrypted one's) and whether it is on display at all. So the
  // rail asks when such a window is selected while it is open, and when the
  // drawer opens over one already selected; a closing drawer turns the key
  // to null and asks nothing. The store decides whether an ask costs an
  // upstream command: a nick already known short-circuits, so the rerun
  // every selection change triggers costs nothing. A peer rename no longer
  // swaps the selection (issue 1365), so it asks nothing either.
  //
  // A nick cannot contain a space, so the separator is unambiguous.
  createEffect(
    on(
      () => {
        if (!props.onScreen) return null;
        const peer = railPeer();
        return peer === null ? null : `${peer.networkSlug} ${peer.nick}`;
      },
      (key) => {
        if (key === null) return;
        const sep = key.indexOf(" ");
        requestRailWhois(key.slice(0, sep), key.slice(sep + 1));
      },
    ),
  );

  return (
    <Switch>
      <Match when={sel()?.kind === "server"}>
        <Show when={networkBySlug(sel()?.networkSlug ?? "")}>
          {(net) => <ServerInfoCard network={net()} now={now()} />}
        </Show>
      </Match>
      <Match when={sel()?.kind === "query"}>
        <QueryContext
          networkSlug={sel()?.networkSlug ?? ""}
          nick={sel()?.channelName ?? ""}
          heading="private conversation with"
          controls={
            // issue 2486 — the one door to an encrypted chat with this peer.
            <StartEncryptedChat
              networkSlug={sel()?.networkSlug ?? ""}
              peer={sel()?.channelName ?? ""}
            />
          }
        />
      </Match>
      <Match when={encrypted()} keyed>
        {(w) => (
          <QueryContext
            networkSlug={w.networkSlug}
            nick={w.nick}
            heading="encrypted conversation with"
            controls={<EncryptedRail networkSlug={w.networkSlug} nick={w.nick} />}
          />
        )}
      </Match>
    </Switch>
  );
};

export default RailContext;
