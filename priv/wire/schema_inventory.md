<!-- GENERATED FILE — DO NOT EDIT -->
<!-- Run `scripts/mix.sh grappa.gen_wire_types` to regenerate. -->

# Runtime wire schemas: generated vs read

`wireSchema.ts` emits one runtime schema per exported `Grappa.*.Wire`
typespec, whether or not a client reads it. This is the count, so the
unread set is a work list instead of invisible weight. It is regenerated
by `mix grappa.gen_wire_types` and held by the same `--check` that holds
the two TypeScript artefacts, so it cannot go stale quietly.

    generated                 267
    imported by cicchetto     89
    reachable at runtime      165
    never read                102

"Reachable" counts a schema nested inside an imported one: the validator
walks it, so it is load-bearing even though no module names it.

## Never read

Emitted, formatted and drift-gated; no cicchetto module reaches them.
Each is either a boundary cic has not narrowed yet (issue 2135's A4) or a
wire shape cic does not consume at all.

- S_AccountsWireClientTokenJson
- S_AccountsWireCredentialJson
- S_AccountsWireUserJson
- S_AdminEventsWireEventKind
- S_AdmissionNetworkCircuitAdminWireT
- S_AuthJSONLoginResponse
- S_AuthJSONSubjectWire
- S_AuthJSONUserSubjectWire
- S_AuthJSONVisitorSubjectWire
- S_BootJSONBootJson
- S_BootJSONChannelTree
- S_BootJSONHeads
- S_CicWireBundleHashPayload
- S_ClientTokenJSONCreateResponse
- S_ClientTokenJSONIndexResponse
- S_E2ePairingWireOffer
- S_E2ePairingWireOfferResponse
- S_ErrorJSONChannelErrorToken
- S_ErrorJSONRestErrorToken
- S_ErrorJSONSharedErrorToken
- S_ErrorJSONStatusErrorResponse
- S_IRCIdentifierCasemapping
- S_IgnoresJSONEntry
- S_IgnoresJSONIndexResponse
- S_IgnoresJSONMutationResponse
- S_MessagesJSONCappedCountResponse
- S_MessagesJSONCountResponse
- S_MessagesJSONSplitCountResponse
- S_NetworksAdminWireT
- S_NetworksCredentialsAdminWireIndexPayload
- S_NetworksCredentialsAdminWireLiveStateJson
- S_NetworksCredentialsAdminWireSessionAction
- S_NetworksCredentialsAdminWireSpawnError
- S_NetworksCredentialsAdminWireT
- S_NetworksJSONPerformResponse
- S_NetworksJSONServerPassResponse
- S_NetworksNetworkServicesFlavor
- S_NetworksWireConnectionInfo
- S_NetworksWireNetworkWithNickJson
- S_NetworksWireVisitorNetworkWithNickJson
- S_PushSubscriptionJSONCreateResponse
- S_PushSubscriptionJSONIndexResponse
- S_PushSubscriptionJSONSubscriptionSummary
- S_PushSubscriptionProvider
- S_RateLimitWireWebSessionSeveredEvent
- S_ReadCursorWireReadCursorSet
- S_ScrollbackWireEvent
- S_ServerSettingsWireAdminAutoAwayView
- S_ServerSettingsWireAutoAwayView
- S_ServerSettingsWireChangedPayload
- S_ServerSettingsWireUploadView
- S_SessionISupportCasemapping
- S_SessionLogWireEvent
- S_SessionWindowStateWindowState
- S_SessionWireChannelCreatedPayload
- S_SessionWireChannelModesChangedPayload
- S_SessionWireChannelModesWire
- S_SessionWireIsupportChangedPayload
- S_SessionWireJoinFailedPayload
- S_SessionWireJoinedPayload
- S_SessionWireKickedPayload
- S_SessionWireLusersBundlePayload
- S_SessionWireMembersSeededPayload
- S_SessionWireRecoverOutcome
- S_SessionWireRecoverProgressPayload
- S_SessionWireRecoverReason
- S_SessionWireRecoverResultPayload
- S_SessionWireRecoverStatus
- S_SessionWireRecoverStep
- S_SessionWireTopicChangedPayload
- S_SessionWireTopicEntryWire
- S_SessionWireWhoisBundlePayload
- S_SessionWireWhoisExtraLine
- S_SessionWireWindowState
- S_SessionWireWireEventKind
- S_SubjectSearchAdminWireResultJson
- S_ThemesTokenModelFontFamily
- S_ThemesTokenModelSizeMode
- S_ThemesWireBackgroundSize
- S_ThemesWireFontFamily
- S_UserSettingsDisplayPrefs
- S_UserSettingsIgnoreOutcome
- S_UserSettingsJSONAliasesResponse
- S_UserSettingsJSONAutoAwayDebounceSecondsResponse
- S_UserSettingsJSONAutoAwayReasonResponse
- S_UserSettingsJSONAwayNickSuffixResponse
- S_UserSettingsJSONBanMaskFormResponse
- S_UserSettingsJSONCommandCountsResponse
- S_UserSettingsJSONDisplayPrefsResponse
- S_UserSettingsJSONNotificationPrefsResponse
- S_UserSettingsJSONQuitPartReasonResponse
- S_UserSettingsJSONShowPeerProfilesResponse
- S_UserSettingsJSONUploadConfirmEnabledResponse
- S_UserSettingsJSONUploadTtlSecondsResponse
- S_UserSettingsJSONVhostOption
- S_UserSettingsJSONVhostResponse
- S_UserSettingsMutedTargets
- S_UserSettingsNotificationPrefs
- S_VisitorsWireCredentialJson
- S_VisitorsWireT
- S_WindowCountsSeverity
- S_WindowCountsWireEvent
