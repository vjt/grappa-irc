// GENERATED FILE — DO NOT EDIT
// Run `scripts/mix.sh grappa.gen_wire_types` to regenerate.
// Source: lib/grappa/**/wire.ex

// === External types (referenced by Wire modules) ===

export type IRCAuthFSMAuthMethod = "auto" | "sasl" | "server_pass" | "nickserv_identify" | "none";

export type NetworksCredentialAuthMethod = IRCAuthFSMAuthMethod;

export type NetworksCredentialConnectionState = "connected" | "parked" | "failed";

export type ScrollbackMetaT = Record<string, unknown>;

// === Grappa.Accounts.Wire ===

export type AccountsWireUserJson = {
  id: string;
  name: string;
  is_admin: boolean;
  inserted_at: string;
};

export type AccountsWireCredentialJson = {
  id: string;
  name: string;
};

// === Grappa.AdminEvents.Wire ===

export type AdminEventsWireEventKind =
  | "circuit_open"
  | "circuit_close"
  | "capacity_reject"
  | "visitor_deleted"
  | "visitor_reaped"
  | "reaper_swept"
  | "upload_reaped"
  | "uploads_swept"
  | "session_disconnected"
  | "session_terminated"
  | "network_caps_updated"
  | "circuit_reset"
  | "cap_counts_changed"
  | "user_created"
  | "user_updated"
  | "user_password_changed"
  | "user_deleted"
  | "network_created"
  | "network_deleted"
  | "server_added"
  | "server_updated"
  | "server_removed"
  | "credential_bound"
  | "credential_updated"
  | "credential_unbound";

export type AdminEventsWireCircuitOpenEvent = {
  kind: "circuit_open";
  network_id: number;
  network_slug: string | null;
  threshold: number;
  cooldown_ms: number;
  at: string;
};

export type AdminEventsWireCircuitCloseEvent = {
  kind: "circuit_close";
  network_id: number;
  network_slug: string | null;
  reason: "success" | "cooldown_expired";
  at: string;
};

export type AdminEventsWireCapacityRejectEvent = {
  kind: "capacity_reject";
  flow: string;
  error: string;
  network_id: number;
  network_slug: string | null;
  client_id: string | null;
  at: string;
};

export type AdminEventsWireVisitorDeletedEvent = {
  kind: "visitor_deleted";
  visitor_id: string;
  visitor_nick: string | null;
  network_slug: string | null;
  actor_user_id: string | null;
  actor_user_name: string | null;
  at: string;
};

export type AdminEventsWireVisitorReapedEvent = {
  kind: "visitor_reaped";
  visitor_id: string;
  visitor_nick: string | null;
  network_slug: string | null;
  at: string;
};

export type AdminEventsWireReaperSweptEvent = {
  kind: "reaper_swept";
  count: number;
  at: string;
};

export type AdminEventsWireUploadReapedEvent = {
  kind: "upload_reaped";
  upload_id: string;
  slug: string;
  subject_kind: "user" | "visitor";
  subject_id: string;
  at: string;
};

export type AdminEventsWireUploadsSweptEvent = {
  kind: "uploads_swept";
  count: number;
  at: string;
};

export type AdminEventsWireSessionDisconnectedEvent = {
  kind: "session_disconnected";
  subject_kind: "user" | "visitor";
  subject_id: string;
  network_id: number;
  network_slug: string | null;
  actor_user_id: string | null;
  actor_user_name: string | null;
  at: string;
};

export type AdminEventsWireSessionTerminatedEvent = {
  kind: "session_terminated";
  subject_kind: "user" | "visitor";
  subject_id: string;
  network_id: number;
  network_slug: string | null;
  actor_user_id: string | null;
  actor_user_name: string | null;
  at: string;
};

export type AdminEventsWireNetworkCapsUpdatedEvent = {
  kind: "network_caps_updated";
  network_id: number;
  network_slug: string;
  max_concurrent_visitor_sessions: number | null;
  max_concurrent_user_sessions: number | null;
  max_per_client: number | null;
  actor_user_id: string | null;
  actor_user_name: string | null;
  at: string;
};

export type AdminEventsWireCircuitResetEvent = {
  kind: "circuit_reset";
  network_id: number;
  network_slug: string | null;
  actor_user_id: string | null;
  actor_user_name: string | null;
  at: string;
};

export type AdminEventsWireCapCountsChangedEvent = {
  kind: "cap_counts_changed";
  network_id: number;
  network_slug: string;
  visitors: number;
  users: number;
  max_concurrent_visitor_sessions: number | null;
  max_concurrent_user_sessions: number | null;
  at: string;
};

export type AdminEventsWireUserCreatedEvent = {
  kind: "user_created";
  user_id: string;
  user_name: string;
  is_admin: boolean;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireUserUpdatedEvent = {
  kind: "user_updated";
  user_id: string;
  user_name: string;
  is_admin: boolean;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireUserPasswordChangedEvent = {
  kind: "user_password_changed";
  user_id: string;
  user_name: string;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireUserDeletedEvent = {
  kind: "user_deleted";
  user_id: string;
  user_name: string;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireNetworkCreatedEvent = {
  kind: "network_created";
  network_id: number;
  network_slug: string;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireNetworkDeletedEvent = {
  kind: "network_deleted";
  network_id: number;
  network_slug: string;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireServerAddedEvent = {
  kind: "server_added";
  network_id: number;
  network_slug: string;
  server_id: number;
  host: string;
  port: number;
  tls: boolean;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireServerUpdatedEvent = {
  kind: "server_updated";
  network_id: number;
  network_slug: string;
  server_id: number;
  host: string;
  port: number;
  tls: boolean;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireServerRemovedEvent = {
  kind: "server_removed";
  network_id: number;
  network_slug: string;
  server_id: number;
  host: string;
  port: number;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireCredentialBoundEvent = {
  kind: "credential_bound";
  user_id: string;
  user_name: string;
  network_id: number;
  network_slug: string;
  nick: string;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireCredentialUpdatedEvent = {
  kind: "credential_updated";
  user_id: string;
  user_name: string;
  network_id: number;
  network_slug: string;
  session_action: "left_alone" | "stopped";
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireCredentialUnboundEvent = {
  kind: "credential_unbound";
  user_id: string;
  user_name: string;
  network_id: number;
  network_slug: string;
  actor_user_id: string;
  actor_user_name: string;
  at: string;
};

export type AdminEventsWireEvent =
  | AdminEventsWireCircuitOpenEvent
  | AdminEventsWireCircuitCloseEvent
  | AdminEventsWireCapacityRejectEvent
  | AdminEventsWireVisitorDeletedEvent
  | AdminEventsWireVisitorReapedEvent
  | AdminEventsWireReaperSweptEvent
  | AdminEventsWireUploadReapedEvent
  | AdminEventsWireUploadsSweptEvent
  | AdminEventsWireSessionDisconnectedEvent
  | AdminEventsWireSessionTerminatedEvent
  | AdminEventsWireNetworkCapsUpdatedEvent
  | AdminEventsWireCircuitResetEvent
  | AdminEventsWireCapCountsChangedEvent
  | AdminEventsWireUserCreatedEvent
  | AdminEventsWireUserUpdatedEvent
  | AdminEventsWireUserPasswordChangedEvent
  | AdminEventsWireUserDeletedEvent
  | AdminEventsWireNetworkCreatedEvent
  | AdminEventsWireNetworkDeletedEvent
  | AdminEventsWireServerAddedEvent
  | AdminEventsWireServerUpdatedEvent
  | AdminEventsWireServerRemovedEvent
  | AdminEventsWireCredentialBoundEvent
  | AdminEventsWireCredentialUpdatedEvent
  | AdminEventsWireCredentialUnboundEvent;

// === Grappa.ChannelDirectory.Wire ===

export type ChannelDirectoryWireEntry = {
  name: string;
  topic: string | null;
  user_count: number;
};

export type ChannelDirectoryWireIndexPayload = {
  entries: ChannelDirectoryWireEntry[];
  next_cursor: string | null;
  total: number;
  captured_at: string | null;
  status: string;
};

// === Grappa.Cic.Wire ===

export type CicWireBundleHashPayload = {
  kind: string;
  hash: string;
};

// === Grappa.Networks.Wire ===

export type NetworksWireCredentialJson = {
  network: string;
  nick: string;
  realname: string | null;
  sasl_user: string | null;
  auth_method: NetworksCredentialAuthMethod;
  auth_command_template: string | null;
  autojoin_channels: string[];
  connection_state: NetworksCredentialConnectionState;
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
  inserted_at: string;
  updated_at: string;
};

export type NetworksWireNetworkJson = {
  kind: "visitor";
  id: number;
  slug: string;
  inserted_at: string;
  updated_at: string;
};

export type NetworksWireNetworkWithNickJson = {
  kind: "user";
  id: number;
  slug: string;
  nick: string;
  connection_state: NetworksCredentialConnectionState;
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
  inserted_at: string;
  updated_at: string;
};

export type NetworksWireChannelJson = {
  name: string;
  joined: boolean;
  source: "autojoin" | "joined";
};

export type NetworksWireHomeNetworkRow = {
  slug: string;
  nick: string;
  connection_state: NetworksCredentialConnectionState;
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
};

export type NetworksWireHomeData = {
  networks: NetworksWireHomeNetworkRow[];
};

export type NetworksWireConnectionStateEvent = {
  kind: string;
  user_id: string;
  network_id: number;
  network_slug: string;
  from: NetworksCredentialConnectionState;
  to: NetworksCredentialConnectionState;
  reason: string | null;
  at: string | null;
  network: NetworksWireHomeNetworkRow;
};

export type WireNetworksEvent = NetworksWireNetworkJson | NetworksWireNetworkWithNickJson;

// === Grappa.QueryWindows.Wire ===

export type QueryWindowsWireWindowsMap = Record<string, QueryWindowsWireWindowsEntry[]>;

export type QueryWindowsWireWindowsEntry = {
  network_id: number;
  target_nick: string;
  opened_at: string;
};

export type QueryWindowsWireWindowsListPayload = {
  kind: string;
  windows: QueryWindowsWireWindowsMap;
};

// === Grappa.ReadCursor.Wire ===

export type ReadCursorWireReadCursorSet = {
  kind: string;
  last_read_message_id: number;
  badge_count: number;
};

// === Grappa.Scrollback.Wire ===

export type ScrollbackWireT = {
  id: number;
  network: string;
  channel: string;
  server_time: number;
  kind: string;
  sender: string;
  body: string | null;
  meta: ScrollbackMetaT;
};

export type ScrollbackWireEvent = {
  kind: string;
  message: ScrollbackWireT;
};

export type ScrollbackWireArchiveWireEntry = {
  target: string;
  kind: string;
  last_activity: number;
  row_count: number;
};

export type ScrollbackWireArchiveWireIndex = {
  archive: ScrollbackWireArchiveWireEntry[];
};

export type ScrollbackWireArchiveChangedPayload = {
  kind: string;
  network_slug: string;
};

export type ScrollbackWireArchivePurgedPayload = {
  kind: string;
  network_slug: string;
  target: string;
};

// === Grappa.ServerSettings.Wire ===

export type ServerSettingsWireUploadView = {
  active_host: string;
  image_per_file_cap_bytes: number;
  video_per_file_cap_bytes: number;
  document_per_file_cap_bytes: number;
  audio_per_file_cap_bytes: number;
  global_cap_bytes: number;
};

export type ServerSettingsWireChangedPayload = {
  kind: string;
  upload: ServerSettingsWireUploadView;
};

// === Grappa.Session.Wire ===

export type SessionWireWireEventKind =
  | "channels_changed"
  | "own_nick_changed"
  | "topic_changed"
  | "channel_modes_changed"
  | "channel_created"
  | "members_seeded"
  | "joined"
  | "window_pending"
  | "join_failed"
  | "kicked"
  | "away_confirmed"
  | "mentions_bundle"
  | "whois_bundle"
  | "peer_away"
  | "invite_ack"
  | "lusers_bundle"
  | "whowas_bundle"
  | "directory_progress"
  | "directory_complete"
  | "directory_failed";

export type SessionWireChannelsChangedPayload = {
  kind: "channels_changed";
};

export type SessionWireOwnNickChangedPayload = {
  kind: "own_nick_changed";
  network_id: number;
  nick: string;
};

export type SessionWireTopicEntryWire = {
  text: string | null;
  set_by: string | null;
  set_at: string | null;
};

export type SessionWireTopicChangedPayload = {
  kind: "topic_changed";
  network: string;
  channel: string;
  topic: SessionWireTopicEntryWire;
};

export type SessionWireChannelModesWire = {
  modes: string[];
  params: Record<string, string | null>;
};

export type SessionWireChannelModesChangedPayload = {
  kind: "channel_modes_changed";
  network: string;
  channel: string;
  modes: SessionWireChannelModesWire;
};

export type SessionWireChannelCreatedPayload = {
  kind: "channel_created";
  network: string;
  channel: string;
  created_at: string;
};

export type SessionWireMembersSeededPayload = {
  kind: "members_seeded";
  network: string;
  channel: string;
  members: SessionWireMember[];
};

export type SessionWireMember = {
  nick: string;
  modes: string[];
};

export type SessionWireMembersIndexPayload = {
  members: SessionWireMember[];
};

export type SessionWireJoinedPayload = {
  kind: "joined";
  network: string;
  channel: string;
  state: string;
};

export type SessionWireWindowPendingPayload = {
  kind: "window_pending";
  network: string;
  channel: string;
  state: string;
};

export type SessionWireJoinFailedPayload = {
  kind: "join_failed";
  network: string;
  channel: string;
  state: string;
  reason: string | null;
  numeric: number | null;
};

export type SessionWireKickedPayload = {
  kind: "kicked";
  network: string;
  channel: string;
  state: string;
  by: string | null;
  reason: string | null;
};

export type SessionWireAwayConfirmedPayload = {
  kind: "away_confirmed";
  network: string;
  state: string;
};

export type SessionWireMentionsBundleMessage = {
  server_time: number;
  channel: string;
  sender: string;
  body: string | null;
  kind: string;
};

export type SessionWireMentionsBundlePayload = {
  kind: "mentions_bundle";
  network: string;
  away_started_at: string;
  away_ended_at: string;
  away_reason: string | null;
  messages: SessionWireMentionsBundleMessage[];
};

export type SessionWireWhoisBundlePayload = {
  kind: "whois_bundle";
  network: string;
  target: string;
  user: string | null;
  host: string | null;
  realname: string | null;
  server: string | null;
  server_info: string | null;
  is_operator: boolean;
  idle_seconds: number | null;
  signon: number | null;
  channels: string[] | null;
  using_ssl: boolean;
  is_registered: boolean;
  is_admin: boolean;
  is_services_admin: boolean;
  is_helper: boolean;
  is_chanop: boolean;
  is_agent: boolean;
  is_java: boolean;
  umodes: string | null;
  away_message: string | null;
  actually_host: string | null;
  actually_ip: string | null;
};

export type SessionWirePeerAwayPayload = {
  kind: "peer_away";
  network: string;
  peer: string;
  message: string;
};

export type SessionWireInviteAckPayload = {
  kind: "invite_ack";
  network: string;
  channel: string;
  peer: string;
};

export type SessionWireLusersBundlePayload = {
  kind: "lusers_bundle";
  network: string;
  total_users: number | null;
  invisible: number | null;
  servers: number | null;
  operators: number | null;
  unknown_connections: number | null;
  channels_formed: number | null;
  local_clients: number | null;
  local_servers: number | null;
  current_local: number | null;
  max_local: number | null;
  current_global: number | null;
  max_global: number | null;
};

export type SessionWireWhowasBundlePayload = {
  kind: "whowas_bundle";
  network: string;
  target: string;
  user: string | null;
  host: string | null;
  realname: string | null;
  server: string | null;
  logoff_time: string | null;
  not_found: boolean;
};

export type SessionWireDirectoryProgressPayload = {
  kind: "directory_progress";
  network: string;
  count: number;
};

export type SessionWireDirectoryCompletePayload = {
  kind: "directory_complete";
  network: string;
  total: number;
};

export type SessionWireDirectoryFailedPayload = {
  kind: "directory_failed";
  network: string;
  reason: string;
};

export type WireSessionEvent =
  | SessionWireChannelsChangedPayload
  | SessionWireOwnNickChangedPayload
  | SessionWireTopicChangedPayload
  | SessionWireChannelModesChangedPayload
  | SessionWireChannelCreatedPayload
  | SessionWireMembersSeededPayload
  | SessionWireJoinedPayload
  | SessionWireWindowPendingPayload
  | SessionWireJoinFailedPayload
  | SessionWireKickedPayload
  | SessionWireAwayConfirmedPayload
  | SessionWireMentionsBundlePayload
  | SessionWireWhoisBundlePayload
  | SessionWirePeerAwayPayload
  | SessionWireInviteAckPayload
  | SessionWireLusersBundlePayload
  | SessionWireWhowasBundlePayload
  | SessionWireDirectoryProgressPayload
  | SessionWireDirectoryCompletePayload
  | SessionWireDirectoryFailedPayload;

// === Grappa.Visitors.Wire ===

export type VisitorsWireCredentialJson = {
  id: string;
  nick: string;
  network_slug: string;
};

export type VisitorsWireT = {
  id: string;
  nick: string;
  network_slug: string;
  expires_at: string | null;
};
