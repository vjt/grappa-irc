// Shared low-level types for the per-channel member list. Pulled out
// to break the modeApply ↔ members import cycle. Mirrors the wire
// shape from `GrappaWeb.MembersJSON`'s `members` envelope.

export type MemberEntry = {
  nick: string;
  modes: string[];
};

export type ChannelMembers = MemberEntry[];
