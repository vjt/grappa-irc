// Structural-equivalence asserts between the cic-facing wire types
// (`./api.ts` and its store-side siblings) and codegen-emitted types
// in `./wireTypes.ts`.
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
//     STRUCTURAL EQUIVALENCE between each cic-facing type and the
//     shape the server promises. The `_Assert_*` type aliases evaluate
//     to `true` when the shapes match and to `false` (or, for the
//     walks, a named-arm object) when they drift; `bun run check`
//     fails on that — closing the drift class at TS compile rather
//     than waiting for a runtime narrower mismatch.
//
//   * The CI-time loop is: typespec change → codegen regen → drift
//     gate (D) catches stale committed file → operator runs codegen
//     → wireTypes.ts updates → this file's asserts fail at `bun run
//     check` → operator reconciles the cic side → CI green.
//
//   * WHAT MAKES A PIN ABLE TO FAIL (#1510). A pin needs TWO
//     INDEPENDENT declarations of the shape. Since #410 most api.ts
//     types are DIRECT ALIASES of their generated counterpart, so
//     `Equal<X, Gen>` where `type X = Gen` compares a type with
//     itself: `true` by construction, and no server-side change can
//     ever redden it — the alias follows the codegen silently, and so
//     does the pin. Eleven of the fourteen full-shape pins were in
//     that state and were MEASURED vacuous (an optional probe field
//     added to the generated type left `bun run check` green on every
//     one of them, while the same probe on `SessionWireMember` —
//     whose cic side is hand-written — reddened). Those eleven now
//     carry an INLINE GOLDEN SHAPE as their second side: the field
//     roster written out by hand here, which no alias can follow. A
//     server-side rename, retype, add or removal now reaches a human
//     instead of regenerating in silence.
//
// Maintenance:
//
//   * Add a pin for every cic-facing type that has a wireTypes.ts
//     counterpart, and pick its SECOND SIDE by how the cic side is
//     declared:
//       - cic side HAND-WRITTEN (today `MemberEntry`, `TopicEntry`,
//         `ModesEntry`, all outside api.ts): pin it against the
//         GENERATED type. Two independent declarations already exist.
//       - cic side a DIRECT ALIAS of the generated type (everything
//         pinned out of api.ts): pin it against an inline golden
//         shape. NEVER against the alias's own right-hand side — that
//         is the vacuous form #1510 found eleven times, and the rule
//         this file used to state ("add an assert for every api.ts
//         type that has a counterpart") manufactured it once api.ts
//         had migrated to aliases.
//     EXCEPT for UNION ARMS, which are walked rather than listed
//     (#1406): a `WireSessionEvent` arm needs nothing at all, and a
//     cross-module arm needs one line in the `CrossModuleArm` registry
//     naming its generated counterpart. Neither buys the silence a
//     forgotten assert line used to.
//
//   * A golden shape names a field's type BY REFERENCE when the
//     referenced type carries its own pin (`HomeNetworkRow` inside
//     `HomeData`), so one server-side change reddens one pin. Where
//     the reference is a leaf the codegen emits and nothing here pins
//     — `MessageKind`, `ScrollbackMetaT`, `ConnectionState`,
//     `NetworksCredentialAuthMethod`, `AvailableNetworkRow` — the pin
//     is blind to changes INSIDE it, by construction. #410 dropped the
//     leaf-enum pins on the same alias argument #1510 overturns;
//     restoring them is outside #1510's perimeter and is recorded here
//     rather than cured.
//
//   * When a GOLDEN-SHAPE pin fails, the server changed the shape:
//     read the codegen diff, check cic's consumers, then update the
//     literal here — updating it IS the acknowledgement the pin exists
//     to force. When a HAND-WRITTEN-side pin fails, the cic mirror has
//     drifted; the fix is on the cic side — update it to match
//     wireTypes.ts (server is the source of truth per CLAUDE.md
//     "Implement once, reuse everywhere").
//
//   * Residual, named rather than cured: a golden shape also reddens
//     when an alias is re-pointed at the WRONG generated type (#1509's
//     class) — but only when the two shapes differ. Structural
//     coincidence still passes.

import type {
  AvailableNetworkRow,
  ConnectionState,
  CredentialJson,
  DirectoryEntry,
  FeaturedChannelLink,
  HomeData,
  HomeNetworkRow,
  LinksEntry,
  MentionsBundleMessage,
  MeResponse,
  MessageKind,
  NotifyEntry,
  QueryWindowEntry,
  ScrollbackMessage,
  Subject,
  WhoUser,
  WireChannelEvent,
  WireUserEvent,
} from "./api";
import type { ModesEntry, TopicEntry } from "./channelTopic";
import type { MemberEntry } from "./memberTypes";
import type {
  AuthJSONSubjectWire,
  CicWireBundleHashPayload,
  MeJSONMeJson,
  NetworksCredentialAuthMethod,
  NetworksCredentialGender,
  NetworksWireConnectionStateEvent,
  NetworksWireNetworkAttachedEvent,
  NetworksWireNetworkDetachedEvent,
  NotifyWireNotifyListPayload,
  QueryWindowsWireWindowsListPayload,
  RateLimitWireWebSessionSeveredEvent,
  ReadCursorWireReadCursorSet,
  ScrollbackMetaT,
  ScrollbackWireArchiveChangedPayload,
  ScrollbackWireArchivePurgedPayload,
  ScrollbackWireEvent,
  ServerSettingsWireChangedPayload,
  SessionWireChannelModesWire,
  SessionWireMember,
  SessionWireTopicEntryWire,
  UserSettingsWireAutoAwayDebounceChangedPayload,
  UserSettingsWireAutoAwayReasonChangedPayload,
  UserSettingsWireAwayNickSuffixChangedPayload,
  UserSettingsWireQuitPartReasonChangedPayload,
  WindowCountsWireEvent,
  WireSessionEvent,
} from "./wireTypes";

// Bi-directional subtype assert helper. `Equal<A, B>` is `true` when
// `A` and `B` are structurally identical, `false` otherwise.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

// === #85 — Featured channels ===
// Public delivery link (HomePane) + the /list directory entry's new
// `featured` flag, pinned to the shape the server promises.
export type _Assert_FeaturedChannelLink = Assert<
  Equal<
    FeaturedChannelLink,
    {
      name: string;
      description: string | null;
    }
  >
>;
export type _Assert_DirectoryEntry = Assert<
  Equal<
    DirectoryEntry,
    {
      name: string;
      topic: string | null;
      user_count: number;
      featured: boolean;
    }
  >
>;

// === S3 (2026-07-08 review) — end-to-end gate for the flat wire mirrors ===
// Every hand-rolled `api.ts` type below has a structurally-identical
// codegen counterpart; the `Equal` assert makes ANY drift between the
// two a `tsc` error (`Type 'true' is not assignable to type 'never'`).
// This is the S3 fix: ~90% of the wire was previously an unguarded
// parallel transcription. The gate now covers the scrollback message
// (S14 kind atom union), the mentions bundle (S14 sibling), the query
// window (S43), the /who + /topic + /modes + members payloads, the
// home rows, and the credential JSON (S3 caught `auth_method` drift).
//
// #410 dropped the leaf ENUM pins (MessageKind, ConnectionState,
// ServicesFlavor, DirectoryStatus, ServerReplySource) on the argument that
// an alias "can't drift", so equality with the codegen type holds BY
// CONSTRUCTION. #1510 measured what that argument actually buys: holding by
// construction is exactly what makes a pin unable to redden, and the STRUCT
// mirrors below had migrated to aliases too — so nine of them had quietly
// joined the enums. They are pinned against an inline golden shape now. The
// leaf enums are NOT (outside #1510's perimeter, recorded in the header).
//
// Enriched / discriminated types (`WireUserEvent`, `WireChannelEvent`,
// `WireAdminEvent`, `MeResponse`, `Network`) carry cic-side
// consumer enrichments and are validated via their runtime narrowers +
// `assertNever`; their per-arm PAYLOADS that have a flat counterpart
// are pinned below (e.g. `ScrollbackMessage`, `MentionsBundleMessage`).
export type _Assert_ScrollbackMessage = Assert<
  Equal<
    ScrollbackMessage,
    {
      id: number;
      network: string;
      channel: string;
      server_time: number;
      kind: MessageKind;
      sender: string;
      body: string | null;
      meta: ScrollbackMetaT;
    }
  >
>;
export type _Assert_MentionsBundleMessage = Assert<
  Equal<
    MentionsBundleMessage,
    {
      server_time: number;
      channel: string;
      sender: string;
      body: string | null;
      kind: MessageKind;
    }
  >
>;
export type _Assert_WhoUser = Assert<
  Equal<
    WhoUser,
    {
      nick: string;
      user: string;
      host: string;
      server: string;
      modes: string;
      hops: number | null;
      realname: string | null;
      channel: string;
    }
  >
>;
// The three pins whose cic side is an independent HAND-WRITTEN declaration
// (all outside api.ts, in the stores that own the shape). Those need no
// golden literal — the hand-roll IS the second source, and #1510 measured
// all three reddening under a probe field added to the generated type.
export type _Assert_MemberEntry = Assert<Equal<MemberEntry, SessionWireMember>>;
export type _Assert_TopicEntry = Assert<Equal<TopicEntry, SessionWireTopicEntryWire>>;
export type _Assert_ModesEntry = Assert<Equal<ModesEntry, SessionWireChannelModesWire>>;
export type _Assert_QueryWindowEntry = Assert<
  Equal<
    QueryWindowEntry,
    {
      network_id: number;
      target_nick: string;
      opened_at: string;
    }
  >
>;
export type _Assert_NotifyEntry = Assert<
  Equal<
    NotifyEntry,
    {
      network_id: number;
      nick: string;
      added_at: string;
    }
  >
>;
export type _Assert_HomeNetworkRow = Assert<
  Equal<
    HomeNetworkRow,
    {
      slug: string;
      nick: string;
      connection_state: ConnectionState;
      connection_state_reason: string | null;
      connection_state_changed_at: string | null;
      recoverable: boolean;
    }
  >
>;
export type _Assert_HomeData = Assert<
  Equal<
    HomeData,
    {
      networks: HomeNetworkRow[];
      available_networks: AvailableNetworkRow[];
    }
  >
>;
export type _Assert_CredentialJson = Assert<
  Equal<
    CredentialJson,
    {
      network: string;
      nick: string;
      ident: string | null;
      realname: string | null;
      sasl_user: string | null;
      auth_method: NetworksCredentialAuthMethod;
      auth_command_template: string | null;
      autojoin_channels: string[];
      connection_state: ConnectionState;
      connection_state_reason: string | null;
      connection_state_changed_at: string | null;
      // M2/M3 — the per-network profile (CTCP USERINFO) and the operator's
      // own avatar. Every field is nullable: a credential bound before the
      // profile existed carries none of them, and an operator who fills in
      // one leaves the rest null.
      age: string | null;
      gender: NetworksCredentialGender | null;
      location: string | null;
      languages: string | null;
      custom: string | null;
      avatar_url: string | null;
      inserted_at: string;
      updated_at: string;
    }
  >
>;

// === cross-surface S7 (2026-07-19 review) — the biggest boundary payloads ===
// S7 pinned the largest payloads on the wire — WhoisBundle (28 fields, grown
// three times: P-0a, #221, #367 oper_text), WhowasBundle, LusersBundle, the
// NamesReply/WhoReply envelopes, the #238 LINKS bundle and the #247 presence
// arms — because a server-side field add or rename regenerates wireTypes.ts
// cleanly and would leave the api.ts mirror plus its runtime narrower
// silently stale, dropping every such bundle with only console noise.
//
// #1406 removed those pins: all of them named `WireSessionEvent` arms, and
// the walk at the bottom of this file re-derives exactly the same relation
// for the whole 37-arm population. What survives here is the ELEMENT type
// nested inside an arm, which the walk covers only through its container
// and which cic also reuses standalone in its stores.
export type _Assert_LinksEntry = Assert<
  Equal<
    LinksEntry,
    {
      server: string;
      linked_to: string | null;
      hopcount: number | null;
      description: string | null;
    }
  >
>;

// === #1406 X-S1 — the cross-module arms, as DATA rather than asserts ===
// cic's two hand-rolled unions fan IN from many `Grappa.*.Wire` modules;
// the codegen groups by Elixir MODULE and emits one union per module, so
// the twelve arms below are the ones no generated union collects and the
// Session walk therefore cannot reach. They used to carry one hand-written
// `_Assert_*` line each — the same shape #1406 removed for the Session
// population, and the same silence: nothing said the list was COMPLETE, so
// a new cross-module arm landed unpinned unless a human remembered.
// `web_session_severed` is how that failed in practice — declared by hand
// since #630, widened since #1338 X-S14, never pinned, found by set
// arithmetic rather than by review.
//
// Naming the counterpart as DATA is what lets the population be checked:
// `_Assert_NoUnpinnedHandArm` below can compare cic's declared kinds
// against `walked ∪ registered` only because "registered" is a type-level
// set. An exported assert alias is not one.
//
// This is also the S1 (2026-07-19) rename gate, unchanged in substance:
// each entry resolves by `kind`, so a server-side discriminator rename
// makes the entry resolve to `never` and `_Assert_NoUnresolvedPin` reddens
// — where before the rename shipped past codegen + tsc and every event of
// that kind was dropped at the narrower with a console.warn.
type CrossModuleArm = {
  message: ScrollbackWireEvent;
  read_cursor_set: ReadCursorWireReadCursorSet;
  window_counts: WindowCountsWireEvent;
  notify_list: NotifyWireNotifyListPayload;
  query_windows_list: QueryWindowsWireWindowsListPayload;
  archive_changed: ScrollbackWireArchiveChangedPayload;
  archive_purged: ScrollbackWireArchivePurgedPayload;
  auto_away_debounce_changed: UserSettingsWireAutoAwayDebounceChangedPayload;
  // issue 2150 — the two remembered leave reasons. Registry entries
  // rather than Session arms, like the debounce above: they are
  // `Grappa.UserSettings.Wire` payloads, so the Session walk cannot
  // reach them and only a named counterpart pins the shape.
  quit_part_reason_changed: UserSettingsWireQuitPartReasonChangedPayload;
  auto_away_reason_changed: UserSettingsWireAutoAwayReasonChangedPayload;
  away_nick_suffix_changed: UserSettingsWireAwayNickSuffixChangedPayload;
  server_settings_changed: ServerSettingsWireChangedPayload;
  connection_state_changed: NetworksWireConnectionStateEvent;
  // issue 2219 — the detach event. A `Grappa.Networks.Wire` payload like
  // the transition above it, so the Session walk cannot reach it and only
  // a named counterpart pins the shape.
  network_detached: NetworksWireNetworkDetachedEvent;
  network_attached: NetworksWireNetworkAttachedEvent;
  bundle_hash: CicWireBundleHashPayload;
  // Two generated types carry `kind: "web_session_severed"` with different
  // shapes — `AdminEventsWireWebSessionSeveredEvent` (admin topic, five
  // fields) and this one (user topic, one). Naming the type rather than
  // resolving by kind alone is what keeps that collision from picking the
  // wrong counterpart, and it is why the registry is a map and not a union.
  web_session_severed: RateLimitWireWebSessionSeveredEvent;
};

// === #1406 — the arm population is WALKED, not listed ===
// A hand-written pin names its arm, so a new arm lands with no pin unless a
// human remembers to write one. That is not a lapse, it is the shape of the
// mechanism: the maintenance note at the top of this file asks for a line
// per type, and 16 of the 37 `WireSessionEvent` arms never got one. The
// population can be quantified over instead of transcribed — codegen emits
// the exhaustive Session union, and `CrossModuleArm` above names the rest —
// so a new arm is covered the moment it is declared, and the pins stop
// being a list anybody has to keep complete.
//
// Each failure is checked separately, because they fail differently:
//
//   * `_Assert_NoUndeclaredArm` — a generated Session arm cic declares on
//     NEITHER topic. No hand pin can catch this class at all: there is
//     nothing yet to write the pin about.
//   * `_Assert_No{User,Channel}ArmDrift` — an arm whose cic copy has a
//     different shape. Walked per union rather than over their union, so
//     the four dual-topic arms (`joined`, `join_failed`, `kicked`,
//     `isupport_changed`) are pinned to the generated payload on BOTH
//     topics, which pins the two copies to each other as a side effect.
//   * `_Assert_NoUnpinnedHandArm` — a kind cic declares that NOTHING here
//     checks: absent from the Session union and absent from the registry.
//     It is the only assert whose subject is the COMPLETENESS of the others
//     rather than a shape. Read it for exactly what it buys and no more: it
//     does NOT remove the hand-maintained line — a new cross-module arm
//     still needs its registry entry — it makes FORGETTING one a `tsc`
//     error that NAMES the arm instead of silence. Deriving the entry
//     needs a topic axis in the codegen, which stays open.
//   * `_Assert_NoStrayPin` / `_Assert_NoUnresolvedPin` — the registry's own
//     two rot modes. A key cic no longer declares (or one the Session walk
//     already covers, which would silently shadow it) makes its entry
//     vacuous; an entry whose generated type no longer carries the kind
//     resolves to `never`, which is how a server-side rename surfaces.

// `Flatten` first: many cic arms are declared as an INTERSECTION with the
// standalone type their stores reuse (`({ kind: "whois_bundle" } &
// WhoisBundle)`), and an intersection is never `Equal` to the flat object
// it is equivalent to — `Equal` compares type identity and `A & B` keeps
// both operands. The homomorphic mapped type collapses it into one object,
// preserving optional and readonly modifiers. Without it the walk reports
// every intersection-declared arm as drift and the exemptions below would
// have to swallow the mechanism whole.
type Flatten<T> = { [K in keyof T]: T[K] };

// The empty-set check is spelled as a MAPPED TYPE rather than
// `Equal<T, never>` so the tsc error NAMES the offending arms — it prints
// `Type '{ recover_progress: "…"; }' does not satisfy the constraint
// 'true'` — instead of the anonymous `Type 'false' is not assignable to
// type 'true'` the pins above produce. A tuple `[Message, T]` does NOT
// work: tsc prints the unexpanded alias reference inside it.
type NoArms<Message extends string, T> = [T] extends [never]
  ? true
  : { [K in T & string]: Message };

// Arms whose cic copy diverges from the generated payload ON PURPOSE, each
// mapped to the ONE field it widens. This is not an exemption list with a
// hole in it: `_Assert_NoWidening{User,Channel}Overrun` below re-checks
// every OTHER field of these arms exactly, and checks that the widened
// field is a genuine SUPERSET of what the server can send. Adding a kind
// here without naming its field does not type-check.
//
// All four entries are the same posture, and it is the additive-only wire
// rule (#447) reaching the type layer: a value that only SELECTS COPY must
// not be allowed to drop its event when the server adds to its vocabulary.
//
//   * `isupport_changed.frame_budget_base` (#1108) — absent means a server
//     predating the field, the realistic case being a cic-only bundle
//     deploy. `narrowIsupportChanged` degrades to `null` rather than
//     rejecting the envelope, which would take the whole capability table
//     (and with it the /mode toggles) down.
//   * `recover_progress.reason` / `recover_result.reason` (#581) — kept a
//     nullable string, deliberately NOT hardened to the token union, so an
//     additive server reason can never drop a terminal recovery result;
//     `RecoverModal.reasonCopy` maps the known tokens and falls back.
//   * `web_session_severed.code` (#1338 X-S14) — widened citing exactly the
//     two above, which is why hardening any of them would reverse a
//     standing ruling. The drop-to-login action does not read the code, so
//     an additive sever reason must not cost the terminal event. It reaches
//     this registry only since #1406 X-S1: the exemption used to be scoped
//     to `WireSessionEvent["kind"]`, and this arm is `Grappa.RateLimit.Wire`
//     — so the ONE arm whose widening was declared in prose could not be
//     declared in types, and went unchecked in both directions.
//
// The generated type describes the server we ship; a widened field
// describes the set of servers cic must survive. That is why these are not
// drift — and why the widening still has to be bounded.
// Exported for its runtime twin. #1393 declares the same tolerances again as
// DATA, because a widening the TYPE exempts is only half the boundary: the
// runtime narrower has to be tolerant too, or cic drops at ingress the very
// payload the type says it accepts. Exporting the registry lets that table
// be checked to SUBSUME this one instead of being a second hand-kept list.
export type DeliberatelyWidened = {
  isupport_changed: "frame_budget_base";
  recover_progress: "reason";
  recover_result: "reason";
  web_session_severed: "code";
};

// The kinds cic declares by hand, and the kinds something here checks.
// `KnownArm` is the union of the two sources a counterpart can come from:
// the exhaustive Session union, and the registry for the arms no generated
// union collects. Everything below walks `KnownArm`, so extending the
// registry extends every check at once.
type HandArm = WireUserEvent["kind"] | WireChannelEvent["kind"];
type PinnedArm = keyof CrossModuleArm & string;
type KnownArm = WireSessionEvent["kind"] | PinnedArm;

// Arms whose cic copy TRANSFORMS the generated body rather than widening
// one field of it, so no `Equal` can hold and no widening bound applies —
// only the discriminator is pinnable. `bundle_hash` carries the deliberate
// post-narrow enrichment `version: string | null` (absent → null) against
// the wire's `version?: string` (cross-surface S2): `undefined` is not a
// member of `string | null`, so this is a conversion, not a superset, and
// registering it as widened would (correctly) overrun. Its coverage is
// `_Assert_NoUnresolvedPin`, which is exactly the rename gate the old
// `_Assert_BundleHashKind` provided.
type DiscriminatorOnlyArm = "bundle_hash" & KnownArm;

type WidenedArm = keyof DeliberatelyWidened & KnownArm;
type WalkedArm = Exclude<KnownArm, WidenedArm | DiscriminatorOnlyArm>;

// Resolve an arm to its generated counterpart. `Extract` over the two
// sources at once keeps this a plain distributive conditional — the shape
// the walks below already index into — instead of a nested `K extends …`
// that tsc refuses to index. It is also why the registry may not name a
// kind the Session union already carries: two candidates would resolve to
// a union and every comparison would fail obscurely. `_Assert_NoStrayPin`
// forbids that overlap rather than leaving it to be discovered.
type GeneratedArm<K extends KnownArm> = Extract<
  WireSessionEvent | CrossModuleArm[PinnedArm],
  { kind: K }
>;

// Index by a key tsc can prove is present. A bare `T[DeliberatelyWidened[K]]`
// is rejected inside the generic walk; `Extract<F, keyof T>` is assignable to
// `keyof T`, and the `extends keyof` guard at the call site keeps the absent
// case from resolving to `never` and passing vacuously.
type At<T, F> = T[Extract<F, keyof T>];

type DriftedIn<U extends { kind: string }> = {
  [K in WalkedArm]: K extends U["kind"]
    ? Equal<Flatten<Extract<U, { kind: K }>>, Flatten<GeneratedArm<K>>> extends true
      ? never
      : K
    : never;
}[WalkedArm];

// A widened arm overruns its exemption when anything OTHER than the named
// field differs, or when the named field stops covering every value the
// generated type admits (`[Gen] extends [Cic]` — cic must accept at least
// what the server can send; a server-side retype of the field lands here).
type WideningOverrunIn<U extends { kind: string }> = {
  [K in WidenedArm]: K extends U["kind"]
    ? Equal<
        Flatten<Omit<Extract<U, { kind: K }>, DeliberatelyWidened[K]>>,
        Flatten<Omit<GeneratedArm<K>, DeliberatelyWidened[K]>>
      > extends true
      ? DeliberatelyWidened[K] extends keyof GeneratedArm<K>
        ? [At<GeneratedArm<K>, DeliberatelyWidened[K]>] extends [
            At<Extract<U, { kind: K }>, DeliberatelyWidened[K]>,
          ]
          ? never
          : K
        : K
      : K
    : never;
}[WidenedArm];

export type _Assert_NoUndeclaredArm = Assert<
  NoArms<
    "generated Session arms cic declares on neither topic",
    Exclude<WireSessionEvent["kind"], WireUserEvent["kind"] | WireChannelEvent["kind"]>
  >
>;
export type _Assert_NoUserArmDrift = Assert<
  NoArms<"user-topic arms whose cic copy differs from codegen", DriftedIn<WireUserEvent>>
>;
export type _Assert_NoChannelArmDrift = Assert<
  NoArms<"channel-topic arms whose cic copy differs from codegen", DriftedIn<WireChannelEvent>>
>;
export type _Assert_NoWideningOverrunUser = Assert<
  NoArms<
    "user-topic arms widening more than their declared field",
    WideningOverrunIn<WireUserEvent>
  >
>;
export type _Assert_NoWideningOverrunChannel = Assert<
  NoArms<
    "channel-topic arms widening more than their declared field",
    WideningOverrunIn<WireChannelEvent>
  >
>;

// The completeness check — the one assert whose subject is the other
// asserts. Every kind cic declares must be reachable by one of the walks
// above, which is true exactly when it is a Session arm or a registry key.
// Without it the registry is a list again, with the same silence: a new
// cross-module arm would simply be absent from every check and nothing
// would say so. `web_session_severed` was that arm when this landed.
export type _Assert_NoUnpinnedHandArm = Assert<
  NoArms<"cic-declared kinds no assert in this file reaches", Exclude<HandArm, KnownArm>>
>;

// The registry's two rot modes, kept separate because they mean different
// things. A stray key is coverage cic no longer needs (or that the Session
// walk already provides, which would shadow the entry); an unresolved entry
// is a counterpart that no longer carries the kind it is filed under — a
// server-side discriminator rename, or a mis-wired entry.
export type _Assert_NoStrayPin = Assert<
  NoArms<
    "registry keys cic does not declare, or that the Session walk already covers",
    Exclude<PinnedArm, Exclude<HandArm, WireSessionEvent["kind"]>>
  >
>;
export type _Assert_NoUnresolvedPin = Assert<
  NoArms<
    "registry entries whose generated type no longer carries the kind",
    { [K in PinnedArm]: [GeneratedArm<K>] extends [never] ? K : never }[PinnedArm]
  >
>;

// === #1406 X-S10 — the subject discriminator, both doors ===
// `GET /me` and `POST /auth/login` carried `kind` as a bare string on the
// server until X-S10; the literals lived here by hand with nothing tying
// them to the source. Now that both are closed sets the codegen can see,
// pin them — but pin the DISCRIMINATOR ONLY. cic's `MeResponse` and
// `Subject` deliberately mark the post-#363/#126 fields optional so a
// subject persisted in localStorage before those fields landed still
// validates, and `MeResponse` carries envelopes the tests mock away, so a
// full-shape `Equal` cannot hold on either. The `kind` set is the part that
// must never drift silently — the same posture as `_Assert_BundleHashKind`.
export type _Assert_MeResponseKind = Assert<Equal<MeResponse["kind"], MeJSONMeJson["kind"]>>;
export type _Assert_LoginSubjectKind = Assert<Equal<Subject["kind"], AuthJSONSubjectWire["kind"]>>;
