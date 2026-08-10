// GENERATED FILE — DO NOT EDIT
// Run `scripts/mix.sh grappa.gen_wire_types` to regenerate.
// Source: lib/grappa/**/*wire.ex + lib/grappa_web/error_tokens.ex
//
// #429 — the RUNTIME twin of `wireTypes.ts`: the same typespecs, emitted
// as schema literals `wireValidate.ts` interprets. `wireTypes.ts` is
// erased by tsc; these survive to the WS/REST boundary. Consts are in
// topological order because a forward reference would hit the TDZ.
//
// Node grammar: see `wireValidate.ts`.

import {
  ADMIN_EVENTS_WIRE_EVENT_KIND,
  ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_DOOR,
  ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_SCOPE,
  ADMISSION_FLOW,
  CHANNEL_DIRECTORY_STATUS,
  ERROR_TOKENS_SHARED_ERROR_TOKEN,
  IRCAUTH_FSMAUTH_METHOD,
  LIVE_INTROSPECTION_SESSION_ENTRY_DEGRADED_FIELD,
  NETWORKS_CREDENTIAL_CONNECTION_STATE,
  NETWORKS_CREDENTIALS_ADMIN_WIRE_SESSION_ACTION,
  NETWORKS_CREDENTIALS_ADMIN_WIRE_SPAWN_ERROR,
  NETWORKS_NETWORK_SERVICES_FLAVOR,
  SCROLLBACK_MESSAGE_KIND,
  SESSION_LOG_EVENT,
  SESSION_WIRE_RECOVER_OUTCOME,
  SESSION_WIRE_RECOVER_REASON,
  SESSION_WIRE_RECOVER_STATUS,
  SESSION_WIRE_RECOVER_STEP,
  SESSION_WIRE_SERVER_REPLY_SOURCE,
  SESSION_WIRE_WIRE_EVENT_KIND,
  WINDOW_COUNTS_SEVERITY,
} from "./wireTypes";

// Grappa.Accounts.AdminWire.t/0
export const S_AccountsAdminWireT = {
  o: {
    id: "s",
    name: "s",
    is_admin: "b",
    inserted_at: "s",
    updated_at: "s",
    live_session_count: "i",
  },
} as const;

// Grappa.Accounts.Wire.credential_json/0
export const S_AccountsWireCredentialJson = { o: { id: "s", name: "s" } } as const;

// Grappa.Accounts.Wire.user_json/0
export const S_AccountsWireUserJson = {
  o: { id: "s", name: "s", is_admin: "b", inserted_at: "s" },
} as const;

// Grappa.AdminEvents.Wire.cap_counts_changed_event/0
export const S_AdminEventsWireCapCountsChangedEvent = {
  o: {
    kind: { l: "cap_counts_changed" },
    network_id: "i",
    network_slug: "s",
    visitors: "i",
    users: "i",
    max_concurrent_visitor_sessions: { u: ["i", "z"] },
    max_concurrent_user_sessions: { u: ["i", "z"] },
    at: "s",
  },
} as const;

// Grappa.Admission.flow/0
export const S_AdmissionFlow = { e: [...ADMISSION_FLOW] } as const;

// Grappa.AdminEvents.Wire.capacity_reject_event/0
export const S_AdminEventsWireCapacityRejectEvent = {
  o: {
    kind: { l: "capacity_reject" },
    flow: S_AdmissionFlow,
    error: "s",
    network_id: "i",
    network_slug: { u: ["s", "z"] },
    source_ip: { u: ["s", "z"] },
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.circuit_close_event/0
export const S_AdminEventsWireCircuitCloseEvent = {
  o: {
    kind: { l: "circuit_close" },
    network_id: "i",
    network_slug: { u: ["s", "z"] },
    reason: { e: ["success", "cooldown_expired"] },
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.circuit_open_event/0
export const S_AdminEventsWireCircuitOpenEvent = {
  o: {
    kind: { l: "circuit_open" },
    network_id: "i",
    network_slug: { u: ["s", "z"] },
    threshold: "i",
    cooldown_ms: "i",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.circuit_reset_event/0
export const S_AdminEventsWireCircuitResetEvent = {
  o: {
    kind: { l: "circuit_reset" },
    network_id: "i",
    network_slug: { u: ["s", "z"] },
    actor_user_id: { u: ["s", "z"] },
    actor_user_name: { u: ["s", "z"] },
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.credential_bound_event/0
export const S_AdminEventsWireCredentialBoundEvent = {
  o: {
    kind: { l: "credential_bound" },
    user_id: "s",
    user_name: "s",
    network_id: "i",
    network_slug: "s",
    nick: "s",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.credential_unbound_event/0
export const S_AdminEventsWireCredentialUnboundEvent = {
  o: {
    kind: { l: "credential_unbound" },
    user_id: "s",
    user_name: "s",
    network_id: "i",
    network_slug: "s",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.credential_updated_event/0
export const S_AdminEventsWireCredentialUpdatedEvent = {
  o: {
    kind: { l: "credential_updated" },
    user_id: "s",
    user_name: "s",
    network_id: "i",
    network_slug: "s",
    session_action: { e: ["left_alone", "stopped"] },
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.login_throttle_door/0
export const S_AdminEventsWireLoginThrottleDoor = {
  e: [...ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_DOOR],
} as const;

// Grappa.AdminEvents.Wire.login_throttle_scope/0
export const S_AdminEventsWireLoginThrottleScope = {
  e: [...ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_SCOPE],
} as const;

// Grappa.AdminEvents.Wire.login_throttled_event/0
export const S_AdminEventsWireLoginThrottledEvent = {
  o: {
    kind: { l: "login_throttled" },
    source_ip: { u: ["s", "z"] },
    failures: "i",
    window_ms: "i",
    at: "s",
    door: S_AdminEventsWireLoginThrottleDoor,
    scope: S_AdminEventsWireLoginThrottleScope,
  },
  q: ["door", "scope"],
} as const;

// Grappa.AdminEvents.Wire.network_caps_updated_event/0
export const S_AdminEventsWireNetworkCapsUpdatedEvent = {
  o: {
    kind: { l: "network_caps_updated" },
    network_id: "i",
    network_slug: "s",
    max_concurrent_visitor_sessions: { u: ["i", "z"] },
    max_concurrent_user_sessions: { u: ["i", "z"] },
    max_per_ip: { u: ["i", "z"] },
    actor_user_id: { u: ["s", "z"] },
    actor_user_name: { u: ["s", "z"] },
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.network_created_event/0
export const S_AdminEventsWireNetworkCreatedEvent = {
  o: {
    kind: { l: "network_created" },
    network_id: "i",
    network_slug: "s",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.network_deleted_event/0
export const S_AdminEventsWireNetworkDeletedEvent = {
  o: {
    kind: { l: "network_deleted" },
    network_id: "i",
    network_slug: "s",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.reaper_swept_event/0
export const S_AdminEventsWireReaperSweptEvent = {
  o: { kind: { l: "reaper_swept" }, count: "i", at: "s" },
} as const;

// Grappa.AdminEvents.Wire.server_added_event/0
export const S_AdminEventsWireServerAddedEvent = {
  o: {
    kind: { l: "server_added" },
    network_id: "i",
    network_slug: "s",
    server_id: "i",
    host: "s",
    port: "i",
    tls: "b",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.server_removed_event/0
export const S_AdminEventsWireServerRemovedEvent = {
  o: {
    kind: { l: "server_removed" },
    network_id: "i",
    network_slug: "s",
    server_id: "i",
    host: "s",
    port: "i",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.server_updated_event/0
export const S_AdminEventsWireServerUpdatedEvent = {
  o: {
    kind: { l: "server_updated" },
    network_id: "i",
    network_slug: "s",
    server_id: "i",
    host: "s",
    port: "i",
    tls: "b",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.session_disconnected_event/0
export const S_AdminEventsWireSessionDisconnectedEvent = {
  o: {
    kind: { l: "session_disconnected" },
    subject_kind: { e: ["user", "visitor"] },
    subject_id: "s",
    network_id: "i",
    network_slug: { u: ["s", "z"] },
    actor_user_id: { u: ["s", "z"] },
    actor_user_name: { u: ["s", "z"] },
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.session_terminated_event/0
export const S_AdminEventsWireSessionTerminatedEvent = {
  o: {
    kind: { l: "session_terminated" },
    subject_kind: { e: ["user", "visitor"] },
    subject_id: "s",
    network_id: "i",
    network_slug: { u: ["s", "z"] },
    actor_user_id: { u: ["s", "z"] },
    actor_user_name: { u: ["s", "z"] },
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.upload_reaped_event/0
export const S_AdminEventsWireUploadReapedEvent = {
  o: {
    kind: { l: "upload_reaped" },
    upload_id: "s",
    slug: "s",
    subject_kind: { e: ["user", "visitor"] },
    subject_id: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.uploads_swept_event/0
export const S_AdminEventsWireUploadsSweptEvent = {
  o: { kind: { l: "uploads_swept" }, count: "i", at: "s" },
} as const;

// Grappa.AdminEvents.Wire.user_created_event/0
export const S_AdminEventsWireUserCreatedEvent = {
  o: {
    kind: { l: "user_created" },
    user_id: "s",
    user_name: "s",
    is_admin: "b",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.user_deleted_event/0
export const S_AdminEventsWireUserDeletedEvent = {
  o: {
    kind: { l: "user_deleted" },
    user_id: "s",
    user_name: "s",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.user_password_changed_event/0
export const S_AdminEventsWireUserPasswordChangedEvent = {
  o: {
    kind: { l: "user_password_changed" },
    user_id: "s",
    user_name: "s",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.user_updated_event/0
export const S_AdminEventsWireUserUpdatedEvent = {
  o: {
    kind: { l: "user_updated" },
    user_id: "s",
    user_name: "s",
    is_admin: "b",
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.visitor_deleted_event/0
export const S_AdminEventsWireVisitorDeletedEvent = {
  o: {
    kind: { l: "visitor_deleted" },
    visitor_id: "s",
    visitor_nick: { u: ["s", "z"] },
    actor_user_id: { u: ["s", "z"] },
    actor_user_name: { u: ["s", "z"] },
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.visitor_reaped_event/0
export const S_AdminEventsWireVisitorReapedEvent = {
  o: { kind: { l: "visitor_reaped" }, visitor_id: "s", visitor_nick: { u: ["s", "z"] }, at: "s" },
} as const;

// Grappa.AdminEvents.Wire.visitor_share_token_minted_event/0
export const S_AdminEventsWireVisitorShareTokenMintedEvent = {
  o: {
    kind: { l: "visitor_share_token_minted" },
    visitor_id: "s",
    visitor_nick: { u: ["s", "z"] },
    actor_user_id: "s",
    actor_user_name: "s",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.web_session_severed_event/0
export const S_AdminEventsWireWebSessionSeveredEvent = {
  o: {
    kind: { l: "web_session_severed" },
    subject_kind: { e: ["user", "visitor"] },
    subject_id: "s",
    failures: "i",
    window_ms: "i",
    at: "s",
  },
} as const;

// Grappa.AdminEvents.Wire.event/0
export const S_AdminEventsWireEvent = {
  u: [
    S_AdminEventsWireCircuitOpenEvent,
    S_AdminEventsWireCircuitCloseEvent,
    S_AdminEventsWireCapacityRejectEvent,
    S_AdminEventsWireVisitorDeletedEvent,
    S_AdminEventsWireVisitorReapedEvent,
    S_AdminEventsWireVisitorShareTokenMintedEvent,
    S_AdminEventsWireReaperSweptEvent,
    S_AdminEventsWireUploadReapedEvent,
    S_AdminEventsWireUploadsSweptEvent,
    S_AdminEventsWireSessionDisconnectedEvent,
    S_AdminEventsWireSessionTerminatedEvent,
    S_AdminEventsWireNetworkCapsUpdatedEvent,
    S_AdminEventsWireCircuitResetEvent,
    S_AdminEventsWireCapCountsChangedEvent,
    S_AdminEventsWireUserCreatedEvent,
    S_AdminEventsWireUserUpdatedEvent,
    S_AdminEventsWireUserPasswordChangedEvent,
    S_AdminEventsWireUserDeletedEvent,
    S_AdminEventsWireNetworkCreatedEvent,
    S_AdminEventsWireNetworkDeletedEvent,
    S_AdminEventsWireServerAddedEvent,
    S_AdminEventsWireServerUpdatedEvent,
    S_AdminEventsWireServerRemovedEvent,
    S_AdminEventsWireCredentialBoundEvent,
    S_AdminEventsWireCredentialUpdatedEvent,
    S_AdminEventsWireCredentialUnboundEvent,
    S_AdminEventsWireLoginThrottledEvent,
    S_AdminEventsWireWebSessionSeveredEvent,
  ],
} as const;

// Grappa.AdminEvents.Wire.event_kind/0
export const S_AdminEventsWireEventKind = { e: [...ADMIN_EVENTS_WIRE_EVENT_KIND] } as const;

// Grappa.AdminOverview.Wire.visitors/0
export const S_AdminOverviewWireVisitors = { o: { total: "i", live: "i" } } as const;

// Grappa.AdminOverview.Wire.t/0
export const S_AdminOverviewWireT = {
  o: {
    sessions: "i",
    visitors: S_AdminOverviewWireVisitors,
    hostname: "s",
    loadavg: { u: ["i", "z"] },
    version: "s",
  },
} as const;

// Grappa.Admission.NetworkCircuit.AdminWire.t/0
export const S_AdmissionNetworkCircuitAdminWireT = {
  o: {
    state: { e: ["closed", "open"] },
    failure_count: "i",
    window_start_ms: "i",
    cooled_at_ms: "i",
    retry_after_seconds: "i",
  },
} as const;

// Grappa.ChannelDirectory.Wire.entry/0
export const S_ChannelDirectoryWireEntry = {
  o: { name: "s", topic: { u: ["s", "z"] }, user_count: "i", featured: "b" },
} as const;

// Grappa.ChannelDirectory.status/0
export const S_ChannelDirectoryStatus = { e: [...CHANNEL_DIRECTORY_STATUS] } as const;

// Grappa.ChannelDirectory.Wire.index_payload/0
export const S_ChannelDirectoryWireIndexPayload = {
  o: {
    entries: { a: S_ChannelDirectoryWireEntry },
    next_cursor: { u: ["s", "z"] },
    total: "i",
    captured_at: { u: ["s", "z"] },
    status: S_ChannelDirectoryStatus,
  },
} as const;

// Grappa.Cic.Wire.bundle_hash_payload/0
export const S_CicWireBundleHashPayload = {
  o: { kind: { l: "bundle_hash" }, hash: "s", version: "s" },
  q: ["version"],
} as const;

// Grappa.IRC.AuthFSM.auth_method/0
export const S_IRCAuthFSMAuthMethod = { e: [...IRCAUTH_FSMAUTH_METHOD] } as const;

// Grappa.LiveIntrospection.SessionEntry.degraded_field/0
export const S_LiveIntrospectionSessionEntryDegradedField = {
  e: [...LIVE_INTROSPECTION_SESSION_ENTRY_DEGRADED_FIELD],
} as const;

// Grappa.LiveIntrospection.AdminWire.live_state_json/0
export const S_LiveIntrospectionAdminWireLiveStateJson = {
  o: {
    nick: { u: ["s", "z"] },
    alive: "b",
    pid_inspect: "s",
    mailbox_len: "i",
    memory_bytes: "i",
    joined_channels: { u: [{ a: "s" }, "z"] },
    peer_address: { u: ["s", "z"] },
    peer_port: { u: ["i", "z"] },
    peer_name: { u: ["s", "z"] },
    introspection_degraded: { a: S_LiveIntrospectionSessionEntryDegradedField },
  },
} as const;

// Grappa.LiveIntrospection.AdminWire.t/0
export const S_LiveIntrospectionAdminWireT = {
  o: {
    subject_kind: { e: ["user", "visitor"] },
    subject_id: "s",
    subject_label: { u: ["s", "z"] },
    last_seen_at: { u: ["s", "z"] },
    network_id: "i",
    live_state: S_LiveIntrospectionAdminWireLiveStateJson,
  },
} as const;

// Grappa.Networks.Network.services_flavor/0
export const S_NetworksNetworkServicesFlavor = {
  e: [...NETWORKS_NETWORK_SERVICES_FLAVOR],
} as const;

// Grappa.Networks.AdminWire.t/0
export const S_NetworksAdminWireT = {
  o: {
    id: "i",
    slug: "s",
    services_flavor: { u: [S_NetworksNetworkServicesFlavor, "z"] },
    visitor_enabled: "b",
    visitor_autoconnect: "b",
    max_concurrent_visitor_sessions: { u: ["i", "z"] },
    max_concurrent_user_sessions: { u: ["i", "z"] },
    max_per_ip: { u: ["i", "z"] },
    inserted_at: "s",
    updated_at: "s",
  },
} as const;

// Grappa.Networks.Credential.auth_method/0
export const S_NetworksCredentialAuthMethod = S_IRCAuthFSMAuthMethod;

// Grappa.Networks.Credential.connection_state/0
export const S_NetworksCredentialConnectionState = {
  e: [...NETWORKS_CREDENTIAL_CONNECTION_STATE],
} as const;

// Grappa.Networks.Credentials.AdminWire.live_state_json/0
export const S_NetworksCredentialsAdminWireLiveStateJson = {
  o: {
    nick: { u: ["s", "z"] },
    alive: "b",
    pid_inspect: "s",
    mailbox_len: "i",
    memory_bytes: "i",
    joined_channels: { u: [{ a: "s" }, "z"] },
    introspection_degraded: { a: S_LiveIntrospectionSessionEntryDegradedField },
  },
} as const;

// Grappa.Networks.Credentials.AdminWire.session_action/0
export const S_NetworksCredentialsAdminWireSessionAction = {
  e: [...NETWORKS_CREDENTIALS_ADMIN_WIRE_SESSION_ACTION],
} as const;

// Grappa.Networks.Credentials.AdminWire.spawn_error/0
export const S_NetworksCredentialsAdminWireSpawnError = {
  e: [...NETWORKS_CREDENTIALS_ADMIN_WIRE_SPAWN_ERROR],
} as const;

// Grappa.Networks.Credentials.AdminWire.t/0
export const S_NetworksCredentialsAdminWireT = {
  o: {
    user_id: "s",
    network_id: "i",
    network_slug: "s",
    nick: "s",
    ident: { u: ["s", "z"] },
    realname: { u: ["s", "z"] },
    sasl_user: { u: ["s", "z"] },
    auth_method: S_NetworksCredentialAuthMethod,
    auth_command_template: { u: ["s", "z"] },
    autojoin_channels: { a: "s" },
    last_joined_channels: { a: "s" },
    connection_state: S_NetworksCredentialConnectionState,
    connection_state_reason: { u: ["s", "z"] },
    connection_state_changed_at: { u: ["s", "z"] },
    inserted_at: "s",
    updated_at: "s",
    live_state: { u: [S_NetworksCredentialsAdminWireLiveStateJson, "z"] },
  },
} as const;

// Grappa.Networks.FeaturedChannels.AdminWire.t/0
export const S_NetworksFeaturedChannelsAdminWireT = {
  o: {
    id: "i",
    network_id: "i",
    name: "s",
    description: { u: ["s", "z"] },
    position: "i",
    enabled: "b",
    inserted_at: "s",
    updated_at: "s",
  },
} as const;

// Grappa.Networks.FeaturedChannels.Wire.link/0
export const S_NetworksFeaturedChannelsWireLink = {
  o: { name: "s", description: { u: ["s", "z"] } },
} as const;

// Grappa.Networks.FeaturedChannels.Wire.index_payload/0
export const S_NetworksFeaturedChannelsWireIndexPayload = {
  o: { channels: { a: S_NetworksFeaturedChannelsWireLink } },
} as const;

// Grappa.Networks.Servers.AdminWire.t/0
export const S_NetworksServersAdminWireT = {
  o: {
    id: "i",
    network_id: "i",
    host: "s",
    port: "i",
    tls: "b",
    priority: "i",
    enabled: "b",
    source_address: { u: ["s", "z"] },
    inserted_at: "s",
    updated_at: "s",
  },
} as const;

// Grappa.Networks.Wire.available_network_row/0
export const S_NetworksWireAvailableNetworkRow = { o: { slug: "s" } } as const;

// Grappa.Networks.Wire.channel_json/0
export const S_NetworksWireChannelJson = {
  o: { name: "s", joined: "b", source: { e: ["autojoin", "joined"] } },
} as const;

// Grappa.Networks.Wire.connection_info/0
export const S_NetworksWireConnectionInfo = {
  o: { server: "s", port: "i", tls: "b", registered: "b", connected_at: { u: ["s", "z"] } },
} as const;

// Grappa.Networks.Wire.home_network_row/0
export const S_NetworksWireHomeNetworkRow = {
  o: {
    slug: "s",
    nick: "s",
    connection_state: S_NetworksCredentialConnectionState,
    connection_state_reason: { u: ["s", "z"] },
    connection_state_changed_at: { u: ["s", "z"] },
    recoverable: "b",
  },
} as const;

// Grappa.Networks.Wire.connection_state_event/0
export const S_NetworksWireConnectionStateEvent = {
  o: {
    kind: { l: "connection_state_changed" },
    user_id: { u: ["s", "z"] },
    network_id: "i",
    network_slug: "s",
    from: S_NetworksCredentialConnectionState,
    to: S_NetworksCredentialConnectionState,
    reason: { u: ["s", "z"] },
    at: { u: ["s", "z"] },
    network: S_NetworksWireHomeNetworkRow,
  },
} as const;

// Grappa.Networks.Wire.credential_json/0
export const S_NetworksWireCredentialJson = {
  o: {
    network: "s",
    nick: "s",
    ident: { u: ["s", "z"] },
    realname: { u: ["s", "z"] },
    sasl_user: { u: ["s", "z"] },
    auth_method: S_NetworksCredentialAuthMethod,
    auth_command_template: { u: ["s", "z"] },
    autojoin_channels: { a: "s" },
    connection_state: S_NetworksCredentialConnectionState,
    connection_state_reason: { u: ["s", "z"] },
    connection_state_changed_at: { u: ["s", "z"] },
    inserted_at: "s",
    updated_at: "s",
  },
} as const;

// Grappa.Networks.Wire.home_data/0
export const S_NetworksWireHomeData = {
  o: {
    networks: { a: S_NetworksWireHomeNetworkRow },
    available_networks: { a: S_NetworksWireAvailableNetworkRow },
  },
} as const;

// Grappa.Networks.Wire.network_with_nick_json/0
export const S_NetworksWireNetworkWithNickJson = {
  o: {
    kind: { l: "user" },
    id: "i",
    slug: "s",
    services_flavor: { u: [S_NetworksNetworkServicesFlavor, "z"] },
    nick: "s",
    ident: { u: ["s", "z"] },
    realname: { u: ["s", "z"] },
    connection_state: S_NetworksCredentialConnectionState,
    connection_state_reason: { u: ["s", "z"] },
    connection_state_changed_at: { u: ["s", "z"] },
    connection: { u: [S_NetworksWireConnectionInfo, "z"] },
    inserted_at: "s",
    updated_at: "s",
  },
} as const;

// Grappa.Networks.Wire.visitor_network_with_nick_json/0
export const S_NetworksWireVisitorNetworkWithNickJson = {
  o: {
    kind: { l: "visitor" },
    id: "i",
    slug: "s",
    services_flavor: { u: [S_NetworksNetworkServicesFlavor, "z"] },
    nick: "s",
    ident: { u: ["s", "z"] },
    realname: { u: ["s", "z"] },
    connection_state: S_NetworksCredentialConnectionState,
    connection_state_reason: { u: ["s", "z"] },
    connection_state_changed_at: { u: ["s", "z"] },
    connection: { u: [S_NetworksWireConnectionInfo, "z"] },
    inserted_at: "s",
    updated_at: "s",
  },
} as const;

// Grappa.Notify.Wire.entry/0
export const S_NotifyWireEntry = { o: { network_id: "i", nick: "s", added_at: "s" } } as const;

// Grappa.Notify.Wire.entries_map/0
export const S_NotifyWireEntriesMap = { r: { a: S_NotifyWireEntry } } as const;

// Grappa.Notify.Wire.notify_list_payload/0
export const S_NotifyWireNotifyListPayload = {
  o: { kind: { l: "notify_list" }, networks: S_NotifyWireEntriesMap },
} as const;

// Grappa.QueryWindows.Wire.windows_entry/0
export const S_QueryWindowsWireWindowsEntry = {
  o: { network_id: "i", target_nick: "s", opened_at: "s" },
} as const;

// Grappa.QueryWindows.Wire.windows_map/0
export const S_QueryWindowsWireWindowsMap = { r: { a: S_QueryWindowsWireWindowsEntry } } as const;

// Grappa.QueryWindows.Wire.windows_list_payload/0
export const S_QueryWindowsWireWindowsListPayload = {
  o: { kind: { l: "query_windows_list" }, windows: S_QueryWindowsWireWindowsMap },
} as const;

// Grappa.RateLimit.Wire.web_session_severed_event/0
export const S_RateLimitWireWebSessionSeveredEvent = {
  o: { kind: { l: "web_session_severed" }, code: { l: "rate_limit_flood" } },
} as const;

// Grappa.ReadCursor.Wire.read_cursor_set/0
export const S_ReadCursorWireReadCursorSet = {
  o: { kind: { l: "read_cursor_set" }, last_read_message_id: "i", badge_count: "i" },
} as const;

// Grappa.Scrollback.Message.kind/0
export const S_ScrollbackMessageKind = { e: [...SCROLLBACK_MESSAGE_KIND] } as const;

// Grappa.Scrollback.Meta.t/0
export const S_ScrollbackMetaT = { r: "x" } as const;

// Grappa.Scrollback.Wire.archive_changed_payload/0
export const S_ScrollbackWireArchiveChangedPayload = {
  o: { kind: { l: "archive_changed" }, network_slug: "s" },
} as const;

// Grappa.Scrollback.Wire.archive_purged_payload/0
export const S_ScrollbackWireArchivePurgedPayload = {
  o: { kind: { l: "archive_purged" }, network_slug: "s", target: "s" },
} as const;

// Grappa.Scrollback.Wire.archive_wire_entry/0
export const S_ScrollbackWireArchiveWireEntry = {
  o: { target: "s", kind: { e: ["channel", "query"] }, last_activity: "i", row_count: "i" },
} as const;

// Grappa.Scrollback.Wire.archive_wire_index/0
export const S_ScrollbackWireArchiveWireIndex = {
  o: { archive: { a: S_ScrollbackWireArchiveWireEntry } },
} as const;

// Grappa.Scrollback.Wire.t/0
export const S_ScrollbackWireT = {
  o: {
    id: "i",
    network: "s",
    channel: "s",
    server_time: "i",
    kind: S_ScrollbackMessageKind,
    sender: "s",
    body: { u: ["s", "z"] },
    meta: S_ScrollbackMetaT,
  },
} as const;

// Grappa.Scrollback.Wire.event/0
export const S_ScrollbackWireEvent = {
  o: { kind: { l: "message" }, message: S_ScrollbackWireT },
} as const;

// Grappa.ServerSettings.Wire.upload_view/0
export const S_ServerSettingsWireUploadView = {
  o: {
    active_host: { e: ["embedded", "litterbox"] },
    image_per_file_cap_bytes: "i",
    video_per_file_cap_bytes: "i",
    document_per_file_cap_bytes: "i",
    audio_per_file_cap_bytes: "i",
    global_cap_bytes: "i",
  },
} as const;

// Grappa.ServerSettings.Wire.changed_payload/0
export const S_ServerSettingsWireChangedPayload = {
  o: {
    kind: { l: "server_settings_changed" },
    upload: S_ServerSettingsWireUploadView,
    http_host_aliases: { a: "s" },
  },
} as const;

// Grappa.Session.Wire.away_confirmed_payload/0
export const S_SessionWireAwayConfirmedPayload = {
  o: { kind: { l: "away_confirmed" }, network: "s", state: { e: ["present", "away"] } },
} as const;

// Grappa.Session.Wire.banlist_entry/0
export const S_SessionWireBanlistEntry = {
  o: { mask: "s", setter: { u: ["s", "z"] }, set_ts: { u: ["s", "z"] } },
} as const;

// Grappa.Session.Wire.banlist_bundle_payload/0
export const S_SessionWireBanlistBundlePayload = {
  o: {
    kind: { l: "banlist_bundle" },
    network: "s",
    channel: "s",
    entries: { a: S_SessionWireBanlistEntry },
  },
} as const;

// Grappa.Session.Wire.channel_created_payload/0
export const S_SessionWireChannelCreatedPayload = {
  o: { kind: { l: "channel_created" }, network: "s", channel: "s", created_at: "s" },
} as const;

// Grappa.Session.Wire.channel_modes_wire/0
export const S_SessionWireChannelModesWire = {
  o: { modes: { a: "s" }, params: { r: { u: ["s", "z"] } } },
} as const;

// Grappa.Session.Wire.channel_modes_changed_payload/0
export const S_SessionWireChannelModesChangedPayload = {
  o: {
    kind: { l: "channel_modes_changed" },
    network: "s",
    channel: "s",
    modes: S_SessionWireChannelModesWire,
  },
} as const;

// Grappa.Session.Wire.channels_changed_payload/0
export const S_SessionWireChannelsChangedPayload = {
  o: { kind: { l: "channels_changed" } },
} as const;

// Grappa.Session.Wire.connection_progress_payload/0
export const S_SessionWireConnectionProgressPayload = {
  o: {
    kind: { l: "connection_progress" },
    network: "s",
    state: { e: ["connecting", "connected"] },
  },
} as const;

// Grappa.Session.Wire.directory_complete_payload/0
export const S_SessionWireDirectoryCompletePayload = {
  o: { kind: { l: "directory_complete" }, network: "s", total: "i" },
} as const;

// Grappa.Session.Wire.directory_failed_payload/0
export const S_SessionWireDirectoryFailedPayload = {
  o: { kind: { l: "directory_failed" }, network: "s", reason: "s" },
} as const;

// Grappa.Session.Wire.directory_progress_payload/0
export const S_SessionWireDirectoryProgressPayload = {
  o: { kind: { l: "directory_progress" }, network: "s", count: "i" },
} as const;

// Grappa.Session.Wire.invite_ack_payload/0
export const S_SessionWireInviteAckPayload = {
  o: { kind: { l: "invite_ack" }, network: "s", channel: "s", peer: "s" },
} as const;

// Grappa.Session.Wire.isupport_changed_payload/0
export const S_SessionWireIsupportChangedPayload = {
  o: {
    kind: { l: "isupport_changed" },
    network_id: "i",
    chanmodes_a: { a: "s" },
    chanmodes_b: { a: "s" },
    chanmodes_c: { a: "s" },
    chanmodes_d: { a: "s" },
    prefix: { r: "s" },
  },
} as const;

// Grappa.Session.Wire.join_failed_payload/0
export const S_SessionWireJoinFailedPayload = {
  o: {
    kind: { l: "join_failed" },
    network: "s",
    channel: "s",
    state: { l: "failed" },
    reason: { u: ["s", "z"] },
    numeric: { u: ["i", "z"] },
  },
} as const;

// Grappa.Session.Wire.joined_payload/0
export const S_SessionWireJoinedPayload = {
  o: { kind: { l: "joined" }, network: "s", channel: "s", state: { l: "joined" } },
} as const;

// Grappa.Session.Wire.kicked_payload/0
export const S_SessionWireKickedPayload = {
  o: {
    kind: { l: "kicked" },
    network: "s",
    channel: "s",
    state: { l: "kicked" },
    by: { u: ["s", "z"] },
    reason: { u: ["s", "z"] },
  },
} as const;

// Grappa.Session.Wire.links_entry/0
export const S_SessionWireLinksEntry = {
  o: {
    server: "s",
    linked_to: { u: ["s", "z"] },
    hopcount: { u: ["i", "z"] },
    description: { u: ["s", "z"] },
  },
} as const;

// Grappa.Session.Wire.links_bundle_payload/0
export const S_SessionWireLinksBundlePayload = {
  o: {
    kind: { l: "links_bundle" },
    network: "s",
    mask: { u: ["s", "z"] },
    entries: { a: S_SessionWireLinksEntry },
  },
} as const;

// Grappa.Session.Wire.lusers_bundle_payload/0
export const S_SessionWireLusersBundlePayload = {
  o: {
    kind: { l: "lusers_bundle" },
    network: "s",
    total_users: { u: ["i", "z"] },
    invisible: { u: ["i", "z"] },
    servers: { u: ["i", "z"] },
    operators: { u: ["i", "z"] },
    unknown_connections: { u: ["i", "z"] },
    channels_formed: { u: ["i", "z"] },
    local_clients: { u: ["i", "z"] },
    local_servers: { u: ["i", "z"] },
    current_local: { u: ["i", "z"] },
    max_local: { u: ["i", "z"] },
    current_global: { u: ["i", "z"] },
    max_global: { u: ["i", "z"] },
  },
} as const;

// Grappa.Session.Wire.member/0
export const S_SessionWireMember = { o: { nick: "s", modes: { a: "s" } } } as const;

// Grappa.Session.Wire.members_index_payload/0
export const S_SessionWireMembersIndexPayload = {
  o: { members: { a: S_SessionWireMember } },
} as const;

// Grappa.Session.Wire.members_seeded_payload/0
export const S_SessionWireMembersSeededPayload = {
  o: {
    kind: { l: "members_seeded" },
    network: "s",
    channel: "s",
    members: { a: S_SessionWireMember },
  },
} as const;

// Grappa.Session.Wire.mentions_bundle_message/0
export const S_SessionWireMentionsBundleMessage = {
  o: {
    server_time: "i",
    channel: "s",
    sender: "s",
    body: { u: ["s", "z"] },
    kind: S_ScrollbackMessageKind,
  },
} as const;

// Grappa.Session.Wire.mentions_bundle_payload/0
export const S_SessionWireMentionsBundlePayload = {
  o: {
    kind: { l: "mentions_bundle" },
    network: "s",
    away_started_at: "s",
    away_ended_at: "s",
    away_reason: { u: ["s", "z"] },
    messages: { a: S_SessionWireMentionsBundleMessage },
  },
} as const;

// Grappa.Session.Wire.names_reply_payload/0
export const S_SessionWireNamesReplyPayload = {
  o: {
    kind: { l: "names_reply" },
    network: "s",
    channel: "s",
    members: { a: S_SessionWireMember },
  },
} as const;

// Grappa.Session.Wire.own_nick_changed_payload/0
export const S_SessionWireOwnNickChangedPayload = {
  o: { kind: { l: "own_nick_changed" }, network_id: "i", nick: "s" },
} as const;

// Grappa.Session.Wire.peer_away_payload/0
export const S_SessionWirePeerAwayPayload = {
  o: { kind: { l: "peer_away" }, network: "s", peer: "s", message: "s" },
} as const;

// Grappa.Session.Wire.presence_changed_payload/0
export const S_SessionWirePresenceChangedPayload = {
  o: {
    kind: { l: "presence_changed" },
    network_id: "i",
    nick: "s",
    presence: { e: ["online", "offline"] },
    initial: "b",
    source: { e: ["monitor", "watch"] },
    ts: "s",
  },
} as const;

// Grappa.Session.Wire.presence_error_payload/0
export const S_SessionWirePresenceErrorPayload = {
  o: { kind: { l: "presence_error" }, network_id: "i", reason: { l: "list_full" }, detail: "s" },
} as const;

// Grappa.Session.Wire.presence_snapshot_payload/0
export const S_SessionWirePresenceSnapshotPayload = {
  o: {
    kind: { l: "presence_snapshot" },
    network_id: "i",
    nicks: { r: { e: ["online", "offline", "unknown"] } },
  },
} as const;

// Grappa.Session.Wire.recover_outcome/0
export const S_SessionWireRecoverOutcome = { e: [...SESSION_WIRE_RECOVER_OUTCOME] } as const;

// Grappa.Session.Wire.recover_reason/0
export const S_SessionWireRecoverReason = { e: [...SESSION_WIRE_RECOVER_REASON] } as const;

// Grappa.Session.Wire.recover_status/0
export const S_SessionWireRecoverStatus = { e: [...SESSION_WIRE_RECOVER_STATUS] } as const;

// Grappa.Session.Wire.recover_step/0
export const S_SessionWireRecoverStep = { e: [...SESSION_WIRE_RECOVER_STEP] } as const;

// Grappa.Session.Wire.recover_progress_payload/0
export const S_SessionWireRecoverProgressPayload = {
  o: {
    kind: { l: "recover_progress" },
    network: "s",
    step: S_SessionWireRecoverStep,
    status: S_SessionWireRecoverStatus,
    reason: { u: [S_SessionWireRecoverReason, "z"] },
  },
} as const;

// Grappa.Session.Wire.recover_result_payload/0
export const S_SessionWireRecoverResultPayload = {
  o: {
    kind: { l: "recover_result" },
    network: "s",
    outcome: S_SessionWireRecoverOutcome,
    reason: { u: [S_SessionWireRecoverReason, "z"] },
  },
} as const;

// Grappa.Session.Wire.server_reply_source/0
export const S_SessionWireServerReplySource = { e: [...SESSION_WIRE_SERVER_REPLY_SOURCE] } as const;

// Grappa.Session.Wire.server_reply_payload/0
export const S_SessionWireServerReplyPayload = {
  o: {
    kind: { l: "server_reply" },
    network: "s",
    source: S_SessionWireServerReplySource,
    lines: { a: "s" },
  },
} as const;

// Grappa.Session.Wire.supported_umodes_changed_payload/0
export const S_SessionWireSupportedUmodesChangedPayload = {
  o: { kind: { l: "supported_umodes_changed" }, network_id: "i", modes: { a: "s" } },
} as const;

// Grappa.Session.Wire.topic_entry_wire/0
export const S_SessionWireTopicEntryWire = {
  o: { text: { u: ["s", "z"] }, set_by: { u: ["s", "z"] }, set_at: { u: ["s", "z"] } },
} as const;

// Grappa.Session.Wire.topic_changed_payload/0
export const S_SessionWireTopicChangedPayload = {
  o: {
    kind: { l: "topic_changed" },
    network: "s",
    channel: "s",
    topic: S_SessionWireTopicEntryWire,
  },
} as const;

// Grappa.Session.Wire.umode_changed_payload/0
export const S_SessionWireUmodeChangedPayload = {
  o: { kind: { l: "umode_changed" }, network_id: "i", modes: { a: "s" } },
} as const;

// Grappa.Session.Wire.who_user/0
export const S_SessionWireWhoUser = {
  o: {
    nick: "s",
    user: "s",
    host: "s",
    server: "s",
    modes: "s",
    hops: { u: ["i", "z"] },
    realname: { u: ["s", "z"] },
    channel: "s",
  },
} as const;

// Grappa.Session.Wire.who_reply_payload/0
export const S_SessionWireWhoReplyPayload = {
  o: { kind: { l: "who_reply" }, network: "s", target: "s", users: { a: S_SessionWireWhoUser } },
} as const;

// Grappa.Session.Wire.whois_extra_line/0
export const S_SessionWireWhoisExtraLine = { o: { numeric: "i", text: "s" } } as const;

// Grappa.Session.Wire.whois_bundle_payload/0
export const S_SessionWireWhoisBundlePayload = {
  o: {
    kind: { l: "whois_bundle" },
    network: "s",
    target: "s",
    source: { e: ["user", "rail"] },
    user: { u: ["s", "z"] },
    host: { u: ["s", "z"] },
    realname: { u: ["s", "z"] },
    server: { u: ["s", "z"] },
    server_info: { u: ["s", "z"] },
    is_operator: "b",
    oper_text: { u: ["s", "z"] },
    idle_seconds: { u: ["i", "z"] },
    signon: { u: ["i", "z"] },
    channels: { u: [{ a: "s" }, "z"] },
    using_ssl: "b",
    is_registered: "b",
    is_admin: "b",
    is_services_admin: "b",
    is_helper: "b",
    is_chanop: "b",
    is_agent: "b",
    is_java: "b",
    umodes: { u: ["s", "z"] },
    away_message: { u: ["s", "z"] },
    actually_host: { u: ["s", "z"] },
    actually_ip: { u: ["s", "z"] },
    account: { u: ["s", "z"] },
    secure: "b",
    secure_cipher: { u: ["s", "z"] },
    certfp: { u: ["s", "z"] },
    extra_lines: { u: [{ a: S_SessionWireWhoisExtraLine }, "z"] },
  },
} as const;

// Grappa.Session.Wire.whowas_bundle_payload/0
export const S_SessionWireWhowasBundlePayload = {
  o: {
    kind: { l: "whowas_bundle" },
    network: "s",
    target: "s",
    user: { u: ["s", "z"] },
    host: { u: ["s", "z"] },
    realname: { u: ["s", "z"] },
    server: { u: ["s", "z"] },
    logoff_time: { u: ["s", "z"] },
    not_found: "b",
  },
} as const;

// Grappa.Session.Wire.window_invite_declined_payload/0
export const S_SessionWireWindowInviteDeclinedPayload = {
  o: { kind: { l: "window_invite_declined" }, network: "s", channel: "s" },
} as const;

// Grappa.Session.Wire.window_invited_payload/0
export const S_SessionWireWindowInvitedPayload = {
  o: {
    kind: { l: "window_invited" },
    network: "s",
    channel: "s",
    state: { l: "invited" },
    inviter: "s",
  },
} as const;

// Grappa.Session.Wire.window_pending_payload/0
export const S_SessionWireWindowPendingPayload = {
  o: { kind: { l: "window_pending" }, network: "s", channel: "s", state: { l: "pending" } },
} as const;

// Grappa.Session.Wire.wire_event_kind/0
export const S_SessionWireWireEventKind = { e: [...SESSION_WIRE_WIRE_EVENT_KIND] } as const;

// Grappa.SessionLog.event/0
export const S_SessionLogEvent = { e: [...SESSION_LOG_EVENT] } as const;

// Grappa.SessionLog.Wire.t/0
export const S_SessionLogWireT = {
  o: {
    id: "i",
    session_id: "s",
    event: S_SessionLogEvent,
    subject_kind: { e: ["user", "visitor"] },
    network_id: "i",
    network_slug: { u: ["s", "z"] },
    nick: { u: ["s", "z"] },
    old_nick: { u: ["s", "z"] },
    reason: { u: ["s", "z"] },
    clean: { u: ["b", "z"] },
    duration_ms: { u: ["i", "z"] },
    delay_ms: { u: ["i", "z"] },
    attempt: { u: ["i", "z"] },
    at: "s",
  },
} as const;

// Grappa.SessionLog.Wire.event/0
export const S_SessionLogWireEvent = {
  o: { kind: { l: "session_log_event" }, entry: S_SessionLogWireT },
} as const;

// Grappa.SessionLog.Wire.list_result/0
export const S_SessionLogWireListResult = { o: { session_log: { a: S_SessionLogWireT } } } as const;

// Grappa.SubjectSearch.AdminWire.result_json/0
export const S_SubjectSearchAdminWireResultJson = {
  o: { type: { e: ["user", "visitor"] }, id: "s", network: { u: ["s", "z"] }, nick: "s" },
} as const;

// Grappa.Themes.Wire.t/0
export const S_ThemesWireT = {
  o: {
    id: "i",
    name: "s",
    author: "s",
    built_in: "b",
    published: "b",
    apply_count: "i",
    in_use: "i",
    mine: "b",
    payload: { r: "x" },
    inserted_at: "s",
  },
} as const;

// Grappa.Vhosts.AdminWire.grant_json/0
export const S_VhostsAdminWireGrantJson = {
  o: {
    id: "i",
    vhost_id: "i",
    subject_type: { e: ["user", "visitor"] },
    subject_id: "s",
    subject_label: { u: ["s", "z"] },
  },
} as const;

// Grappa.Vhosts.AdminWire.vhost_json/0
export const S_VhostsAdminWireVhostJson = {
  o: {
    id: "i",
    address: "s",
    in_pool: "b",
    generally_available: "b",
    inserted_at: "s",
    updated_at: "s",
  },
} as const;

// Grappa.Visitors.AdminWire.live_state_json/0
export const S_VisitorsAdminWireLiveStateJson = {
  o: {
    nick: { u: ["s", "z"] },
    alive: "b",
    pid_inspect: "s",
    mailbox_len: "i",
    memory_bytes: "i",
    joined_channels: { u: [{ a: "s" }, "z"] },
    introspection_degraded: { a: S_LiveIntrospectionSessionEntryDegradedField },
  },
} as const;

// Grappa.Visitors.AdminWire.network_json/0
export const S_VisitorsAdminWireNetworkJson = {
  o: {
    network_slug: "s",
    network_id: "i",
    nick: "s",
    connection_state: S_NetworksCredentialConnectionState,
    live_state: { u: [S_VisitorsAdminWireLiveStateJson, "z"] },
  },
} as const;

// Grappa.Visitors.AdminWire.t/0
export const S_VisitorsAdminWireT = {
  o: {
    id: "s",
    expires_at: { u: ["s", "z"] },
    identified: "b",
    ip: { u: ["s", "z"] },
    inserted_at: "s",
    networks: { a: S_VisitorsAdminWireNetworkJson },
  },
} as const;

// Grappa.Visitors.Wire.credential_json/0
export const S_VisitorsWireCredentialJson = {
  o: { id: "s", registered: "b", incognito: "b" },
} as const;

// Grappa.Visitors.Wire.t/0
export const S_VisitorsWireT = {
  o: { id: "s", expires_at: { u: ["s", "z"] }, registered: "b", incognito: "b" },
} as const;

// Grappa.WindowCounts.severity/0
export const S_WindowCountsSeverity = { e: [...WINDOW_COUNTS_SEVERITY] } as const;

// Grappa.WindowCounts.Wire.event/0
export const S_WindowCountsWireEvent = {
  o: {
    kind: { l: "window_counts" },
    channel: "s",
    messages: "i",
    mentions: "i",
    events: "i",
    severity: S_WindowCountsSeverity,
  },
} as const;

// GrappaWeb.ErrorTokens.shared_error_token/0
export const S_ErrorTokensSharedErrorToken = { e: [...ERROR_TOKENS_SHARED_ERROR_TOKEN] } as const;

// GrappaWeb.ErrorTokens.channel_error_token/0
export const S_ErrorTokensChannelErrorToken = {
  u: [
    S_ErrorTokensSharedErrorToken,
    { l: "unknown_topic" },
    { l: "invalid_payload" },
    { l: "user_not_found" },
    { l: "network_not_found" },
    { l: "no_session" },
    { l: "not_explicit" },
    { l: "invalid_nick" },
    { l: "not_cached" },
    { l: "lookup_failed" },
    { l: "open_failed" },
    { l: "close_failed" },
    { l: "unknown_event" },
    { l: "save_failed" },
    { l: "invalid_reason" },
    { l: "invalid_mask" },
    { l: "upstream_unavailable" },
    { l: "persist_failed" },
    { l: "invalid_channel" },
    { l: "links_in_flight" },
    { l: "nothing_to_recover" },
    { l: "already_identified" },
    { l: "recovery_in_progress" },
    { l: "rate_limited" },
  ],
} as const;

// GrappaWeb.ErrorTokens.rest_error_token/0
export const S_ErrorTokensRestErrorToken = {
  u: [
    S_ErrorTokensSharedErrorToken,
    { l: "bad_request" },
    { l: "unauthorized" },
    { l: "nickserv_pass_retired" },
    { l: "file_too_large" },
    { l: "metadata_strip_failed" },
    { l: "insufficient_storage" },
    { l: "unsupported_media_type" },
    { l: "invalid_setting" },
    { l: "addressing_unusable" },
    { l: "rate_limited" },
    { l: "too_many_attempts" },
    { l: "theme_cap_reached" },
    { l: "list_full" },
    { l: "not_raster" },
    { l: "too_large" },
    { l: "ssrf_blocked" },
    { l: "fetch_failed" },
    { l: "image_reencode_failed" },
    { l: "not_connected" },
    { l: "forbidden_vhost" },
    { l: "invalid_credentials" },
    { l: "invalid_two_factor" },
    { l: "two_factor_challenge_expired" },
    { l: "already_enabled" },
    { l: "too_many_sessions" },
    { l: "network_busy" },
    { l: "network_unreachable" },
    { l: "captcha_required" },
    { l: "captcha_failed" },
    { l: "service_degraded" },
    { l: "db_unavailable" },
    { l: "malformed_nick" },
    { l: "malformed_ident" },
    { l: "password_required" },
    { l: "passkey_required" },
    { l: "passkey_not_configured" },
    { l: "password_mismatch" },
    { l: "network_not_visitor_enabled" },
    { l: "network_ambiguous" },
    { l: "network_unconfigured" },
    { l: "upstream_unreachable" },
    { l: "connect_timeout" },
    { l: "welcome_timeout" },
    { l: "session_timeout" },
    { l: "probe_timeout" },
    { l: "internal" },
    { l: "session_plan_resolve_failed" },
    { l: "contract_migrations_pending" },
    { l: "invalid_message" },
    { l: "anon_collision" },
    { l: "nick_in_use" },
    { l: "cannot_disconnect_self" },
    { l: "source_not_local" },
    { l: "already_exists" },
    { l: "already_attached" },
    { l: "credentials_present" },
    { l: "scrollback_present" },
    { l: "last_admin" },
    { l: "share_token_expired" },
    { l: "share_token_consumed" },
    { l: "not_invited" },
    { l: "validation_failed" },
  ],
} as const;
