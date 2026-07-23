// Structural-equivalence asserts between hand-rolled cic types in
// `./api.ts` and codegen-emitted types in `./wireTypes.ts`.
//
// Why this file exists:
//
//   * `wireTypes.ts` is the GENERATED mirror of server-side
//     `Grappa.*.Wire` typespecs (`mix grappa.gen_wire_types`,
//     `scripts/check.sh` re-runs with `--check` to fail CI on drift
//     between the typespec source and the committed `wireTypes.ts`).
//
//   * `api.ts` carries CIC-side hand-rolled mirrors of those shapes
//     (with consumer-side enrichments — discriminated unions, cic-
//     aggregate types, etc.). The hand-rolled mirrors drifted from
//     the server-side typespecs in REV cluster findings C1/C2/H1-H6.
//
//   * Migrating every cic call site to `import { X } from
//     "./wireTypes"` is risky in one go (the cic-side type unions
//     are richer than the server-side typespecs in places — REST-
//     aggregate, discriminator-narrowed). Instead, this file asserts
//     STRUCTURAL EQUIVALENCE between each api.ts type and its
//     wireTypes.ts counterpart. The `_Assert_*` type aliases evaluate
//     to `true` when shapes match, `never` when they drift. The
//     `assertExtends/2` helpers further enforce bi-directional
//     subtype-ness at compile time. `bun run check` fails on `never`
//     — closing the drift class at TS compile rather than waiting
//     for a runtime narrower mismatch.
//
//   * The CI-time loop is: typespec change → codegen regen → drift
//     gate (D) catches stale committed file → operator runs codegen
//     → wireTypes.ts updates → this file's asserts fail at `bun run
//     check` if the api.ts hand-roll doesn't match the new shape →
//     operator fixes api.ts to match → CI green.
//
// Maintenance:
//
//   * Add an assert for every api.ts type that has a wireTypes.ts
//     counterpart. When server-side adds a new Wire module + type,
//     the codegen emits it; if a cic consumer needs the new shape,
//     add the assert + the api.ts mirror.
//
//   * If an assert fails (`Type 'true' is not assignable to type
//     'never'` at the `: true = true` lines), the api.ts mirror has
//     drifted from the server typespec. The fix is on the cic side —
//     update api.ts to match wireTypes.ts (server is the source of
//     truth per CLAUDE.md "Implement once, reuse everywhere").

import type {
  ConnectionState,
  CredentialJson,
  DirectoryEntry,
  FeaturedChannelLink,
  HomeData,
  HomeNetworkRow,
  MentionsBundleMessage,
  MessageKind,
  NamesReply,
  NotifyEntry,
  QueryWindowEntry,
  ScrollbackMessage,
  ServerReplySource,
  WhoisBundle,
  WhoReply,
  WhowasBundle,
  WhoUser,
  WireChannelEvent,
  WireUserEvent,
} from "./api";
import type { ModesEntry, TopicEntry } from "./channelTopic";
import type { MemberEntry } from "./memberTypes";
import type {
  ChannelDirectoryWireEntry,
  CicWireBundleHashPayload,
  NetworksCredentialConnectionState,
  NetworksFeaturedChannelsWireLink,
  NetworksWireConnectionStateEvent,
  NetworksWireCredentialJson,
  NetworksWireHomeData,
  NetworksWireHomeNetworkRow,
  NotifyWireEntry,
  NotifyWireNotifyListPayload,
  QueryWindowsWireWindowsEntry,
  QueryWindowsWireWindowsListPayload,
  ReadCursorWireReadCursorSet,
  ScrollbackMessageKind,
  ScrollbackWireArchiveChangedPayload,
  ScrollbackWireArchivePurgedPayload,
  ScrollbackWireEvent,
  ScrollbackWireT,
  ServerSettingsWireChangedPayload,
  SessionWireAwayConfirmedPayload,
  SessionWireChannelModesWire,
  SessionWireConnectionProgressPayload,
  SessionWireJoinedPayload,
  SessionWireJoinFailedPayload,
  SessionWireKickedPayload,
  SessionWireLusersBundlePayload,
  SessionWireMember,
  SessionWireMentionsBundleMessage,
  SessionWireNamesReplyPayload,
  SessionWirePresenceChangedPayload,
  SessionWirePresenceErrorPayload,
  SessionWirePresenceSnapshotPayload,
  SessionWireServerReplySource,
  SessionWireTopicEntryWire,
  SessionWireWhoisBundlePayload,
  SessionWireWhoReplyPayload,
  SessionWireWhowasBundlePayload,
  SessionWireWhoUser,
  SessionWireWindowInvitedPayload,
  SessionWireWindowPendingPayload,
  WindowCountsWireEvent,
} from "./wireTypes";

// Bi-directional subtype assert helper. `Equal<A, B>` is `true` when
// `A` and `B` are structurally identical, `false` otherwise.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

// === CLOSES H2 — ConnectionState ===
// api.ts ConnectionState was declared open-string in REV-H pre-fix;
// post-H2 it's a closed atom union mirroring server-side
// `Grappa.Networks.Credential.connection_state/0`. This assert pins
// the contract: any future change to either side fails at compile
// time.
export type _Assert_ConnectionState = Assert<
  Equal<ConnectionState, NetworksCredentialConnectionState>
>;

// === #85 — Featured channels ===
// Public delivery link (HomePane) + the /list directory entry's new
// `featured` flag, pinned to their codegen counterparts.
export type _Assert_FeaturedChannelLink = Assert<
  Equal<FeaturedChannelLink, NetworksFeaturedChannelsWireLink>
>;
export type _Assert_DirectoryEntry = Assert<Equal<DirectoryEntry, ChannelDirectoryWireEntry>>;

// === S3 (2026-07-08 review) — end-to-end gate for the flat wire mirrors ===
// Every hand-rolled `api.ts` type below has a structurally-identical
// codegen counterpart; the `Equal` assert makes ANY drift between the
// two a `tsc` error (`Type 'true' is not assignable to type 'never'`).
// This is the S3 fix: ~90% of the wire was previously an unguarded
// parallel transcription. The gate now covers the scrollback message
// (S14 kind atom union), the mentions bundle (S14 sibling), the query
// window (S43), the /who + /topic + /modes + members payloads, the
// home rows, the credential JSON (S3 caught `auth_method` drift), and
// the `server_reply` + connection-state closed sets.
//
// Enriched / discriminated types (`WireUserEvent`, `WireChannelEvent`,
// `WireAdminEvent`, `MeResponse`, `Network`) carry cic-side
// consumer enrichments and are validated via their runtime narrowers +
// `assertNever`; their per-arm PAYLOADS that have a flat counterpart
// are pinned below (e.g. `ScrollbackMessage`, `MentionsBundleMessage`).
export type _Assert_MessageKind = Assert<Equal<MessageKind, ScrollbackMessageKind>>;
export type _Assert_ScrollbackMessage = Assert<Equal<ScrollbackMessage, ScrollbackWireT>>;
export type _Assert_MentionsBundleMessage = Assert<
  Equal<MentionsBundleMessage, SessionWireMentionsBundleMessage>
>;
export type _Assert_ServerReplySource = Assert<
  Equal<ServerReplySource, SessionWireServerReplySource>
>;
export type _Assert_WhoUser = Assert<Equal<WhoUser, SessionWireWhoUser>>;
export type _Assert_MemberEntry = Assert<Equal<MemberEntry, SessionWireMember>>;
export type _Assert_TopicEntry = Assert<Equal<TopicEntry, SessionWireTopicEntryWire>>;
export type _Assert_ModesEntry = Assert<Equal<ModesEntry, SessionWireChannelModesWire>>;
export type _Assert_QueryWindowEntry = Assert<
  Equal<QueryWindowEntry, QueryWindowsWireWindowsEntry>
>;
export type _Assert_NotifyEntry = Assert<Equal<NotifyEntry, NotifyWireEntry>>;
export type _Assert_HomeNetworkRow = Assert<Equal<HomeNetworkRow, NetworksWireHomeNetworkRow>>;
export type _Assert_HomeData = Assert<Equal<HomeData, NetworksWireHomeData>>;
export type _Assert_CredentialJson = Assert<Equal<CredentialJson, NetworksWireCredentialJson>>;

// === cross-surface S7 (2026-07-19 review) — the biggest boundary payloads ===
// The assert list above stated the rule "per-arm PAYLOADS that have a flat
// counterpart are pinned below", but the LARGEST payloads on the wire had
// no pin: WhoisBundle (27 fields — it has already grown twice, P-0a + #221),
// WhowasBundle, LusersBundle, the NamesReply/WhoReply envelopes, and the
// #247 presence arms. A server-side field add/rename in any of these
// regenerates wireTypes.ts cleanly and would leave the api.ts hand mirror +
// its runtime narrower (userTopic.ts) silently stale — dropping every such
// bundle at runtime with only console noise. These pins make that drift a
// `tsc` error instead.
//
// Standalone hand-rolled types (the shape cic actually reuses in its stores)
// are pinned against `Omit<SessionWireXPayload, "kind">`; the union-inline
// arms (no standalone type) are pinned via `Extract<WireUserEvent, {kind}>`
// against the full generated payload (kind included).
export type _Assert_WhoisBundle = Assert<
  Equal<WhoisBundle, Omit<SessionWireWhoisBundlePayload, "kind">>
>;
export type _Assert_WhowasBundle = Assert<
  Equal<WhowasBundle, Omit<SessionWireWhowasBundlePayload, "kind">>
>;
export type _Assert_NamesReply = Assert<
  Equal<NamesReply, Omit<SessionWireNamesReplyPayload, "kind">>
>;
export type _Assert_WhoReply = Assert<Equal<WhoReply, Omit<SessionWireWhoReplyPayload, "kind">>>;
export type _Assert_LusersBundle = Assert<
  Equal<Extract<WireUserEvent, { kind: "lusers_bundle" }>, SessionWireLusersBundlePayload>
>;
export type _Assert_PresenceChanged = Assert<
  Equal<Extract<WireUserEvent, { kind: "presence_changed" }>, SessionWirePresenceChangedPayload>
>;
export type _Assert_PresenceError = Assert<
  Equal<Extract<WireUserEvent, { kind: "presence_error" }>, SessionWirePresenceErrorPayload>
>;
export type _Assert_PresenceSnapshot = Assert<
  Equal<Extract<WireUserEvent, { kind: "presence_snapshot" }>, SessionWirePresenceSnapshotPayload>
>;

// === cross-surface S1 (2026-07-19 review) — envelope discriminator pins ===
// The envelope `kind` (and Session `state`) discriminators of ~10 Wire
// modules were typed `String.t()` server-side, so codegen emitted
// `kind: string` and cic restated each literal by hand with zero
// compile-time gate — a server rename of any discriminator shipped
// silently past codegen + tsc, then every event of that kind was dropped
// at the cic narrower with only a console.warn. S1 tightened the
// typespecs to literal atoms (Dialyzer now pins the builders; codegen
// emits `kind: "literal"`); these pins tie cic's hand-rolled union arms
// to the generated literal payloads so a future rename is a `tsc` error.
// Each `Extract<Union, {kind}>` also revalidates the arm's full field
// shape (kind + body) against the generated type — the same guarantee as
// the S7 pins above.
export type _Assert_ScrollbackMessageEvent = Assert<
  Equal<Extract<WireChannelEvent, { kind: "message" }>, ScrollbackWireEvent>
>;
export type _Assert_ReadCursorSet = Assert<
  Equal<Extract<WireChannelEvent, { kind: "read_cursor_set" }>, ReadCursorWireReadCursorSet>
>;
export type _Assert_WindowCounts = Assert<
  Equal<Extract<WireChannelEvent, { kind: "window_counts" }>, WindowCountsWireEvent>
>;
export type _Assert_NotifyList = Assert<
  Equal<Extract<WireUserEvent, { kind: "notify_list" }>, NotifyWireNotifyListPayload>
>;
export type _Assert_QueryWindowsList = Assert<
  Equal<
    Extract<WireUserEvent, { kind: "query_windows_list" }>,
    QueryWindowsWireWindowsListPayload
  >
>;
export type _Assert_ArchiveChanged = Assert<
  Equal<Extract<WireUserEvent, { kind: "archive_changed" }>, ScrollbackWireArchiveChangedPayload>
>;
export type _Assert_ArchivePurged = Assert<
  Equal<Extract<WireUserEvent, { kind: "archive_purged" }>, ScrollbackWireArchivePurgedPayload>
>;
export type _Assert_ServerSettingsChanged = Assert<
  Equal<
    Extract<WireUserEvent, { kind: "server_settings_changed" }>,
    ServerSettingsWireChangedPayload
  >
>;
export type _Assert_ConnectionStateChanged = Assert<
  Equal<
    Extract<WireUserEvent, { kind: "connection_state_changed" }>,
    NetworksWireConnectionStateEvent
  >
>;

// bundle_hash: cic's arm carries the deliberate post-narrow enrichment
// `version: string | null` (absent → null) vs the wire's `version?:
// string` (cross-surface S2), so a full-shape Equal cannot hold. Pin the
// `kind` discriminator only — that is the rename gap S1 closes.
export type _Assert_BundleHashKind = Assert<
  Equal<
    Extract<WireUserEvent, { kind: "bundle_hash" }>["kind"],
    CicWireBundleHashPayload["kind"]
  >
>;

// Session window-state arms — the `state` discriminator was `String.t()`
// too; now a literal atom union. Pin each arm (kind + state + body).
export type _Assert_Joined = Assert<
  Equal<Extract<WireChannelEvent, { kind: "joined" }>, SessionWireJoinedPayload>
>;
export type _Assert_JoinFailed = Assert<
  Equal<Extract<WireChannelEvent, { kind: "join_failed" }>, SessionWireJoinFailedPayload>
>;
export type _Assert_Kicked = Assert<
  Equal<Extract<WireChannelEvent, { kind: "kicked" }>, SessionWireKickedPayload>
>;
export type _Assert_WindowPending = Assert<
  Equal<Extract<WireUserEvent, { kind: "window_pending" }>, SessionWireWindowPendingPayload>
>;
export type _Assert_WindowInvited = Assert<
  Equal<Extract<WireUserEvent, { kind: "window_invited" }>, SessionWireWindowInvitedPayload>
>;
export type _Assert_AwayConfirmed = Assert<
  Equal<Extract<WireUserEvent, { kind: "away_confirmed" }>, SessionWireAwayConfirmedPayload>
>;
export type _Assert_ConnectionProgress = Assert<
  Equal<
    Extract<WireUserEvent, { kind: "connection_progress" }>,
    SessionWireConnectionProgressPayload
  >
>;
