import { type ChannelKey, decodeChannelKey } from "./channelKey";
import { isNetworkParked } from "./networkParked";
import { channelsBySlug, networkBySlug } from "./networks";
import { queryWindowsByNetwork } from "./queryWindows";
import { isMobile } from "./theme";
import { type WindowState, windowStateByChannel } from "./windowState";

// Synthetic window rows: keys with windowState != "joined" whose
// (slug, name) is NOT yet in channelsBySlug AND not a known query
// (DM) target for this network. Returns name + state tuples so the
// JSX can render the right classList branch (pending styling vs
// greyed) without a second windowState lookup.
//
// The projection covers the non-joined states — pending, failed, kicked,
// parked — under the same rule: cic mirrors a row whenever the operator is
// aware of the channel (windowState carries the key) but channelsBySlug
// doesn't. Without this, a failed JOIN
// (invite-only / banned / +k miss) leaves the operator with no
// sidebar entry at all: the pending row vanishes when state flips
// to failed and the channelsBySlug branch never receives the
// channel since the JOIN was rejected. Intent doc:
// "Sidebar entry greyed/dim" on every failed/kicked/parked window.
//
// The joined state is INTENTIONALLY EXCLUDED. PHASE 1.1 added a
// joined arm here to bridge the small per-channel-`joined` →
// user-topic-`channels_changed` window so cp15-b5 wouldn't flash an
// empty sidebar between the two broadcasts. That arm violated the
// "SOURCE state must clear at switch BEFORE TARGET decisions" rule
// (memory feedback_target_window_ux_rule) and produced a ghost-row
// regression on PART: when channels_changed arrived BEFORE the
// per-channel `kind:"message"` part broadcast (no cross-topic
// ordering guarantee at the WS edge), channelsBySlug dropped the
// channel while windowState still carried `joined` — sidebar
// synthesized a ghost row that lingered until the next render tick.
// Bug B (M9 X-button PART) reproduced this. Reverted to the
// pre-PHASE-1.1 shape; cp15-b5 now gates on the WS-truth signal
// (per-channel join-line in scrollback) instead of the sidebar row
// existence to avoid the same flake.
//
// Query (DM) targets are filtered out — windowState may carry a
// (slug, nick) entry too (the kicked/away projection plays nicely
// with DMs), but the dedicated query-windows branch handles their
// rendering. Without this filter, the synthetic loop would dup-render
// every greyed query target as a "ghost" channel row.
//
// #71 INC-3 — this is the ONE shared projection (the single code path)
// behind the desktop Sidebar pseudo-rows. Extracted from Sidebar so every
// nav derives from the same source rather than parallel projections. What
// each form factor actually DRAWS out of it is
// `navPseudoChannelsForNetwork` below — never a filter open-coded at a call
// site.
//
// #902 — `invited` LEFT this set. An inbound INVITE is now announced by a
// dismissable top banner carrying [Join] (`lib/errorBanners.ts`), not by a
// greyed row: a pseudo-row is a WINDOW you can open, and an unanswered
// invite is a NOTIFICATION. The window still exists server-side at
// `:invited` — this projection simply no longer draws it, so the banner is
// the single surface (issue #902's ruling). The `invited` case is skipped
// explicitly rather than dropped from the type by accident: an `:invited`
// key is a normal, expected state to encounter here.
//
// issue 2693 — which states draw a row is ONE record over EVERY state, and
// `PseudoRow.state` is derived from it. A state the server adds is a tsc error
// here until someone says whether it draws a row; before, the two `continue`s
// below plus an `Exclude<…>` complement drew it by default.
const DRAWS_PSEUDO_ROW = {
  pending: true,
  invited: false,
  joined: false,
  failed: true,
  kicked: true,
  parked: true,
} as const satisfies Record<WindowState, boolean>;

type PseudoRowState = {
  [S in keyof typeof DRAWS_PSEUDO_ROW]: (typeof DRAWS_PSEUDO_ROW)[S] extends true ? S : never;
}[keyof typeof DRAWS_PSEUDO_ROW];

const drawsPseudoRow = (state: WindowState): state is PseudoRowState => DRAWS_PSEUDO_ROW[state];

export type PseudoRow = {
  name: string;
  state: PseudoRowState;
};

export function pseudoChannelsForNetwork(slug: string, networkId: number): PseudoRow[] {
  const states = windowStateByChannel();
  const live = new Set((channelsBySlug()?.[slug] ?? []).map((c) => c.name));
  const queries = new Set((queryWindowsByNetwork()[networkId] ?? []).map((qw) => qw.targetNick));
  const out: PseudoRow[] = [];
  for (const [key, state] of Object.entries(states)) {
    // `joined` is excluded (see above); #902 — the banner owns `invited`,
    // and drawing a row too would be the "second place to look" the issue
    // exists to remove.
    if (!drawsPseudoRow(state)) continue;
    // Codebase audit cic M4 — paired decoder over open-coded
    // `key.startsWith(prefix) + key.slice(prefix.length)`. The
    // composite-key shape is owned by `lib/channelKey.ts`; one site
    // here + one in `subscribe.ts` would otherwise drift if the
    // shape ever changed.
    const decoded = decodeChannelKey(key as ChannelKey);
    if (decoded === null || decoded.slug !== slug) continue;
    const name = decoded.name;
    if (live.has(name)) continue;
    if (queries.has(name)) continue;
    out.push({ name, state });
  }
  return out;
}

// #402 — what the nav of the CURRENT form factor actually DRAWS, which is
// NOT the same set as the projection above.
//
// UX-5 bucket BK reads "one window, one surface", and the archive filter
// (`archive.ts` → `visibleArchiveForNetwork`) implements it by subtracting
// the pseudo-rows — on the premise that a nav renders what it subtracts.
// Desktop honours that premise: `Shell.tsx` mounts the Sidebar, which draws
// every non-joined state. Mobile does not: the mobile branch has no Sidebar
// at all (an absent JSX branch, not `display:none`). #402's bug was the
// archive subtracting rows that no mobile surface drew: one window, ZERO
// surfaces — a window that vanished from the UI until a reload.
//
// #902 — mobile now draws NOTHING here. The `:invited` slice was the
// BottomBar's entire pseudo-row content (#71 INC-3), and the banner replaced
// it; the banner is a form-factor-agnostic surface, so mobile needs no
// pseudo-row of its own. Applying #402's own rule to the new state of the
// world: mobile subtracts nothing, so `pending` / `failed` / `kicked` /
// `parked` on a phone are reachable through the ARCHIVE — one window, one
// surface, still satisfied. That is why this stays a function rather than
// collapsing into `pseudoChannelsForNetwork`: it remains the single place
// where "which nav exists" and "what it draws" are reconciled, and the
// archive keeps consuming exactly that.
//
// `isMobile()` is the SAME signal `Shell.tsx` branches its layout on, so the
// two cannot disagree.
export function navPseudoChannelsForNetwork(slug: string, networkId: number): PseudoRow[] {
  if (isMobile()) return [];
  // issue 1985 — a parked network draws no pseudo-row either, because it
  // draws no row at all. See `navDrawsNetwork` below.
  if (!navDrawsNetwork(slug)) return [];
  return pseudoChannelsForNetwork(slug, networkId);
}

// issue 1985 — does the nav of THIS form factor draw ANY row for this network?
//
// #402 answered "which ROWS does the nav draw" and the archive subtracts
// exactly that. The parked ruling asks the question one level up: the desktop
// Sidebar drops a parked network at its ONE `<For>`, and the header, the
// channels, the queries and the pseudo-rows all render INSIDE that loop, so
// the whole network stops being drawn — not a subset of its rows. A filter
// that keeps subtracting them then leaves one window with ZERO surfaces,
// which is #402's bug with a bigger blast radius.
//
// It lives HERE, next to `navPseudoChannelsForNetwork`, because this module's
// job is precisely reconciling "which nav exists" with "what it draws", and
// the archive already consumes that reconciliation. A copy of the rule in
// `archive.ts` would be a second statement of the parked policy — the thing
// `lib/networkParked.ts` was extracted to prevent.
//
// MOBILE IS TRUE, and it is measured rather than assumed: `BottomBar.tsx`
// iterates the RAW `networks()` store and renders each network's channels and
// queries with no state filter of its own (`:138`, `:174`, `:215`), so on a
// phone a parked network's rows are still on screen and the archive must
// still subtract them. The sidebar filter this issue adds is desktop-only.
// (The pseudo-row leg is separately empty on mobile since #902 — that is the
// early return above, a different question with the same answer here.)
//
// `failed` and `failing` draw normally: a failed network keeps its greyed row
// so the operator must see it, and a failing one is retrying on its own
// (#1675). The asymmetry is the product decision — `lib/networkParked.ts`.
export function navDrawsNetwork(slug: string): boolean {
  if (isMobile()) return true;
  return !isNetworkParked(networkBySlug(slug));
}
