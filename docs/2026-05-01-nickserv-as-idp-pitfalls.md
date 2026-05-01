# NickServ-as-IDP — discussion outcomes + pitfalls + open questions

**Captured:** 2026-05-01, from `#it-opers` discussion (vjt + Sonic + Mezmerize + mpanella-via-Trillian).
**Origin:** vjt asked vjt-claude on `#grappa` 23:32 CEST to dump the topic into `/srv/grappa` so the dedicated grappa session can attack the pitfalls.
**Scope:** grappa client-facing auth (Phase 4 product shape, M2 cluster). NOT the existing Phase 2 per-network upstream auth (which already covers SASL / PASS-handoff / NickServ IDENTIFY as bouncer→upstream creds).

Three auth modes vjt is targeting (Phase 4 plan section "three auth modes"):

1. **anon (mode 3)** — WEBIRC, vhost `XXX.bnc.azzurra.chat` IP-derived.
2. **NickServ-as-IDP (mode 2)** — visitor types nick + NickServ password into grappa; grappa proxies the auth to upstream NickServ; on success the user is logged into grappa AND on-IRC as the nick (with custom host).
3. **local user (mode 1)** — existing grappa users table (Argon2 + opaque session). Already shipped Phase 2.

What follows is the actual #it-opers conversation distilled, then a pitfall list, then the open questions still pending decision.

---

## Discussion log (chronological, CEST = UTC+2)

All timestamps below are **UTC** as they appear in `bot.log` on m42; add 2h for CEST.

### Mode taxonomy lock-in (vjt 11:35–11:40 UTC)

```
11:35:53 vjt: sto prevedendo proprio questin3 auth mode: anon, nickserv as IDP, local user
11:36:32 vjt: per nickserv as idp mi servirà sethost però nell'ircd se vogliamo custom host
11:37:22 vjt: a meno che non codifichiamo nell'ircd che se un user viene da una W ed è
              pre-auth via PASS USER NICK allora è l'irds stesso che fa sethost
11:37:36 Sonic: stiamo implementando hostserv
11:37:52 Mezmerize: Sonic: lo so che ti ci stai segando che son 20 anni che vuoi hostserv
11:38:02 Sonic: ho webirc posso lamerare
11:38:35 vjt: si direi che hostserv e la soluzione giusta
11:38:57 Mezmerize: sì beh unreal+anope è di default hostserv proprio
11:39:07 Mezmerize: per richiedere l'attivazione del vhost
11:40:46 vjt → vjt-claude: memorizza un po' 'sti dettagli: anon fanno webirc e passano
                            host XXX.bnc.azzurra.chat dove XXX e derivato dal client ip.
                            nickserv come IDP invece non setta host e se ne occupa poi
                            ircd o hostserv, usa logon classico con pass nick user
```

**Outcome locked here:** anon = WEBIRC + IP-derived bnc.azzurra.chat vhost; NickServ-as-IDP = classic PASS/NICK/USER, no custom host from grappa, host set by **ircd or hostserv**. SETHOST decision deferred (see next section).

### SETHOST responsibility — ircd vs services (vjt + Sonic 11:41–11:49 UTC)

```
11:41:37 vjt: unica fregatura è... metto nick e passwd sbagliate, devo comunque fare un
              giro full di connect/disconnect per fare auth sull'ircd
11:45:12 Sonic: per questo la mia idea era associare un vhost ad un nick e far dare a
                nickserv un ipotetico SVSHOST
11:47:23 Sonic: eh ma calma chi fa sethost? perchè ho paura che stiamo mischiando le cose
11:49:18 vjt: sethost mi sta bene farlo fare a svc
```

**Outcome locked here:** services do the SETHOST (via a NickServ-emitted SVSHOST), ircd does NOT pre-auth at NICK/USER time. **A new `SVSHOST` services→ircd command is implied — needs adding to `azzurra/services` + matching ircd-side handler.** Not in any existing branch as of 2026-05-01.

### WEBIRC vs NickServ-IDP collision (mpanella + vjt 12:00–12:19 UTC)

```
12:00:46 mpanella (via Trillian): Sonic: a quel punto dossiamo direttamente i client di
                                   unsolicited RPL_WHO per far vedere il cambio di usermask...
12:02:56 mpanella (via Trillian): sì, considerate che WEBIRC può iniettare il cazzo che
                                   vuole come host record
12:03:24 vjt: però con webirc come faccio auth nickserv!
12:05:48 vjt: beh oh guarda non e difficile fare pass user nick e dare poi auth denied
              se non risulti +r e quit
12:13:03 vjt: pero ecco non voglio limitare l'uso ai soli registrati, per portare utenti
              penso che un modo webirc sia utile
12:13:42 Sonic: ma cmq aiutatemi a capire che mi son perso, io ero rimasto: user
                registrato su grappa vhost con username + parte statica, user GUEST sessione
                persistente con max idle 48h -> vhost dato da hash(sessionid) + parte statica
12:14:00 Sonic: perchè così ci basta webirc
12:14:50 vjt: vorrei usare nickserv come idp
12:15:03 vjt: quindi non posso usare WEBIRC se non verifico la passwd prima
12:17:42 Sonic: mi serviva proprio per usarlo come idp
12:19:52 vjt: shippo prima di tutto webirc
```

**Outcome locked here:** the two flows are **mutually exclusive at IRC-protocol level**. WEBIRC frontloads a host record into the registration handshake, but skips PASS/IDENTIFY-against-NickServ. If grappa wants NickServ-as-IDP, it must **verify the password out-of-band before opening the upstream socket** (typical bouncer pattern), then connect with PASS/NICK/USER (no WEBIRC). The two paths split at session-establishment time, not run together.

**Tactical decision (vjt 12:19):** ship WEBIRC (mode 1 + mode 3 anon) first, then layer NickServ-as-IDP (mode 2) on top.

---

## Pitfalls captured

In order of nastiness for the dedicated session to attack:

1. **WEBIRC ⊕ NickServ-IDP, never together.** Grappa cannot pass an IP-derived vhost via WEBIRC and then expect upstream NickServ identification on the same connection. Two distinct connection shapes.
   - For mode-2: open upstream as **non-WEBIRC client**, send PASS at register, server calls SIDENTIFY on Bahamut.
   - For mode-1/3: open as WEBIRC, vhost set by gateway, no NickServ flow.
   - **Implication:** `Grappa.IRC.Client` needs a session-establishment branch keyed on `auth_method=:nickserv_idp` that switches off WEBIRC entirely.

2. **Wrong-password = full disconnect-reconnect cycle.** vjt 11:41: "metto nick e passwd sbagliate, devo comunque fare un giro full di connect/disconnect". On Bahamut, IDENTIFY/SIDENTIFY failure means: NickServ kills you (KILL ON) or you stay un-`+r` and grappa has to disconnect cleanly and let the user retype.
   - **Implication:** the grappa-side login screen MUST verify creds **before** the upstream socket opens, so a wrong password is a 401 from grappa, not a disconnect storm against Azzurra.
   - **Requires:** an out-of-band NickServ-validation path. Options: (a) NS API endpoint (does Azzurra expose one? — see open question Q1); (b) ephemeral throwaway IRC connection per login attempt that does only NICK + IDENTIFY + checks +r WHOIS, then QUIT; (c) cache + re-validate on long-idle sessions.

3. **WEBIRC injection vector** (mpanella 12:02): "WEBIRC può iniettare il cazzo che vuole come host record". The gateway must enforce a deterministic format like `XXX.bnc.azzurra.chat` and reject anything else. Bahamut's WEBIRC implementation trusts the client password; the per-network secret in grappa MUST be tightly held (already env-var via Cloak; verify ircd-side WEBIRC config matches).

4. **SETHOST responsibility (services-side missing).** vjt 11:36 + 11:49 + Sonic 11:45: the agreed model is NickServ emits an `SVSHOST` to the ircd after IDENTIFY succeeds, and the ircd applies it. **Neither end implements this yet.** Sonic mentioned "stiamo implementando hostserv" (Mezmerize: Anope ships hostserv stock; Bahamut services don't). New work scope:
   - `azzurra/services` (Bahamut services): add HostServ (or extend NickServ) to (a) store per-nick vhost, (b) emit SVSHOST on identify, (c) admin commands to set/unset.
   - `azzurra/bahamut` (ircd): add SVSHOST handler (probably a new TS6/TSora-style command or hook into existing CHGHOST mechanic).
   - **Out of grappa's repo entirely.** Grappa just consumes the +r-with-vhost outcome.

5. **Anon nick collision shape** (already in Phase 4 plan as M3 cluster open question, restated). If anon = `Guest12345!~web@hash.bnc.azzurra.chat` per session, what happens when two anons pick the same nick? Grappa must own a nick-allocator or trust Azzurra's existing reservation rules.

6. **Bringing-users-in vs gating-on-registered tension** (vjt 12:13). vjt explicitly does not want grappa to be registered-only — anon ramp is required for adoption. But this means modes 1/3 ship before mode 2 lands, and mode 2 cannot retro-break mode 3 sessions.
   - **Implication:** mode 3 cookie/session shape must persist as a first-class identity, not a downgrade-from-mode-2.

7. **Session lifecycle when IDENTIFY succeeds late.** Bahamut KILL ON gives you a 60s grace to type IDENTIFY; if grappa frontloaded the password and proxies it at PASS register-time, the path is clean. But if the IDENTIFY fails silently after 001 (network glitch, services lag), the session is left in `-r` limbo — grappa needs a watchdog that escalates to disconnect.

---

## Open questions (still pending decision before the dedicated session can plan M2)

| # | Question | Pinned by |
|---|----------|-----------|
| Q1 | **Does Azzurra expose any out-of-band NickServ-validation endpoint** (REST? socket-cmd? services-API?) that grappa can hit synchronously to verify a nick+pass without opening a full IRC session? If not, the "throwaway IRC connection per login attempt" pattern (pitfall #2 option b) becomes the default, with all its rate-limit / connection-storm implications. | vjt |
| Q2 | **SVSHOST design — services-side scope.** Where does the per-nick vhost get stored (NickServ NickInfo, new HostServ DB)? What ULEVEL gates the set/unset cmds? Does it apply on every IDENTIFY or only once per nick lifetime? Is there a request-and-approve flow (Anope-style) or self-service from the user? | Sonic ("stiamo implementando hostserv") |
| Q3 | **WEBIRC password rotation — operational shape.** Single env var on the ircd? Per-grappa-instance pre-shared-key? Rotation cadence? Audit trail when rotated? | mpanella concern (12:02) |
| Q4 | **Mode-2 lazy account creation** — already locked in Phase 4 plan as `Accounts.find_or_create_for_nickserv/2`. But: what email goes into the lazy `users` row (NickServ doesn't expose user email to non-staff)? Is the row gappa-private, or does it merge with mode-1 if same email is later registered manually? | (deferred from phase-4 plan) |
| Q5 | **Anon abuse posture** — already deferred to M3-A cluster, restated here for visibility: per-IP rate-limit + operator allowlist (`accept_anon: bool` per network) — but what's the **grappa-side** UX when a network refuses anon? "Login required" gate vs full hide-from-list vs partial (channel list visible, send blocked)? | (deferred from phase-4 plan) |
| Q6 | **Wrong-password user feedback latency.** If pitfall #2 option (b) is chosen — throwaway IRC connection per login attempt — the user waits ~3-5s for the 432/433/+r-check round-trip. Acceptable for v1, or do we want a "validating…" indicator? | (UX, not yet discussed) |
| Q7 | **Mode-1 + mode-2 account merging.** If a user logs in mode-1 (local) and tomorrow logs in mode-2 with the same nick, are these the same `users` row or separate? Probably separate (two identities, like signing in with email vs signing in with Google) — but worth pinning. | (not yet discussed) |
| Q8 | **NickServ password storage — already encrypted on grappa side per Phase 2 decision B (Cloak.Ecto AES-256-GCM, env key).** Restated: the dedicated session must verify mode-2 reuses this exact path, no new crypto code. | (already locked, restated) |

---

## Pointers

- Phase 4 plan: `docs/plans/2026-04-27-phase-4-product-shape.md` — three auth modes, M2 + M3 + M3-A clusters.
- Phase 2 plan (already-shipped upstream auth): `docs/plans/2026-04-25-phase2-auth.md` decision E.
- Bahamut PASS-at-register / SIDENTIFY behaviour — already verified from `~/code/IRC/services/src/nickserv.c` source by vjt-claude on 2026-04-23 (see today's RESETPASS PR-merge work for evidence of source-grep practice).
- WEBIRC implementation in `azzurra/bahamut` — needs source-grep before any mode-3 implementation work; vjt has the tree at `~/code/IRC/azzurra/bahamut/`.
- Hostserv / SVSHOST work is in `azzurra/services`, currently NOT in `features/64bit` branch; Sonic owns this thread — coordinate before assuming any services-side primitive is available.

---

**Status:** capture-only. No grappa code changes here. The dedicated `/srv/grappa` Claude Code session should:

1. Read this file + Phase 4 plan M2 cluster.
2. Pick off Q1 first (it gates the whole mode-2 implementation shape).
3. Coordinate with Sonic on Q2 timing — grappa M2 cannot ship vhost-on-identify until services-side SVSHOST exists.
4. The pre-mode-2 ship target ("shippo prima di tutto webirc", vjt 12:19) means anon mode 3 + WEBIRC integration is the immediate work; mode 2 is gated on Q1+Q2 resolution.
