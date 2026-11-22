// Shared low-level types for the per-channel member list, in their own
// module so `api.ts` and `wireNarrow.ts` can name them without importing
// the members store (which imports `api.ts`). Mirrors the wire shape from
// `GrappaWeb.MembersJSON`'s `members` envelope.

// M2 — `gender` mirrors the wire's `SessionWireMember.gender` (generated
// from `Grappa.Session.Wire.member/0`): absent/null when the peer's CTCP
// USERINFO was never queried or answered (e.g. `show_peer_profiles` off).
export type MemberGender = "male" | "female" | "nonbinary";

export type MemberEntry = {
  nick: string;
  modes: string[];
  gender?: MemberGender | null;
};

export type ChannelMembers = MemberEntry[];
