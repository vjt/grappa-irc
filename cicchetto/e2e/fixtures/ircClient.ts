// Synthetic IRC peer for e2e tests.
//
// Wraps `irc-framework` in a small async/typed surface so specs read
// like a script: `await peer.join("#bofh")`, `await peer.privmsg(...)`.
// Each verb resolves only AFTER the upstream confirms the action
// (numeric or echo) — no `sleep` polling in test bodies.
//
// Connection target comes from E2E_IRC_HOST/E2E_IRC_PORT (set on the
// playwright-runner container in compose.yaml). The peer's nick is
// caller-supplied; the realname/username default to the same string
// because the testnet doesn't gate on either.
//
// One-peer-per-instance — `IrcPeer.connect` returns a connected client;
// `disconnect` tears it down. Pair `try/finally` in the spec to keep
// peer leaks out of the runner between tests.

import { Client } from "irc-framework";
import { awaitPrivmsg } from "./privmsgWait";

const HOST = process.env.E2E_IRC_HOST ?? "bahamut-test";
const PORT = Number(process.env.E2E_IRC_PORT ?? "6667");

const REGISTER_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 5_000;
const PART_TIMEOUT_MS = 5_000;
const NICK_TIMEOUT_MS = 5_000;
const MODE_TIMEOUT_MS = 5_000;
const KICK_TIMEOUT_MS = 5_000;
// #268 — TOPIC echoes are the class most exposed to bahamut's per-connection
// command flood-throttling ("fake lag"): a spec that JOINs a fresh channel
// then sets/edits its topic sends both frames back-to-back on the shared
// upstream socket, so the TOPIC echo (which a peer waits on via `topic` /
// `waitForTopic`) can land past 5s under full-suite command accumulation
// (proven for the sibling REST path at +5.013s; docs/DESIGN_NOTES.md
// 2026-07-16). This is a condition-wait ceiling — it resolves the instant the
// echo arrives — so 15s is headroom above bahamut's ~10s fake-lag bank cap,
// matching the #23/#220 topic asserts, NOT a fixed sleep.
const TOPIC_TIMEOUT_MS = 15_000;
// #806 defect 3 — an inbound PRIVMSG is the OTHER wait exposed to the same
// fake-lag class as TOPIC above, and it had no budget of its own: it borrowed
// `NICK_TIMEOUT_MS`, a constant sized for a NICK echo, purely because
// `waitForPrivmsg` was written next to `changeNick`. Of the seven specs that
// block on grappa-originated traffic this was the only one at 5s, and not by
// anyone's decision.
//
// Measured 2026-08-04 (#807's per-send accounting, live testnet): with the
// bank empty the message arrives in 26-28ms; with it full, at 3024ms and
// 4989ms — the second inside 5s by eleven milliseconds. The delay is the
// bank's overshoot, so it is bounded by the ~10s cap, exactly the bound
// TOPIC_TIMEOUT_MS is already sized against. 15s clears that ceiling and
// matches the budget the sibling upstream-waiting specs (issue536, issue386)
// already use.
//
// Same shape as TOPIC_TIMEOUT_MS and NOT a timeout raised to bury a red: this
// is a condition-wait that resolves the instant the message lands, so a
// genuine routing regression (#373's stale-nick 401 — nothing arrives, ever)
// still fails, just 10s later. What it stops doing is failing when the
// message is merely queued behind the harness's own reconnect burst.
//
// This is the DEFAULT, not the only option: `waitForPrivmsg` takes a
// `timeoutMs` like its sibling `waitForLine` does, so a spec that needs a
// different budget asks for one instead of retuning everyone's (#806
// defect 2).
const PRIVMSG_TIMEOUT_MS = 15_000;
const OPER_TIMEOUT_MS = 5_000;
const NICKSERV_TIMEOUT_MS = 5_000;
const AWAY_TIMEOUT_MS = 5_000;

export class IrcPeer {
  private readonly client: Client;

  // Public so callers can derive locator strings from the live nick.
  // Mutable because `changeNick` updates it after a successful upstream
  // rename — readonly would force callers to thread the new value
  // manually for every post-rename verb.
  public nick: string;

  private constructor(client: Client, nick: string) {
    this.client = client;
    this.nick = nick;
  }

  static async connect(opts: { nick: string; gecos?: string; host?: string }): Promise<IrcPeer> {
    const client = new Client();
    const peer = new IrcPeer(client, opts.nick);

    // Diagnostic: surface every irc-framework event during register so a
    // timeout failure shows what bahamut sent (RPL_*, ERR_*, NOTICE,
    // socket close, etc.) instead of just "timeout". `raw` fires for
    // every wire-line; we tag with the nick so multiple parallel peers
    // don't blur in the log.
    if (process.env.E2E_PEER_DEBUG === "1") {
      client.on("raw", (event: { line: string; from_server: boolean }) => {
        if (!event.from_server) return;
        // eslint-disable-next-line no-console
        console.log(`[peer:${opts.nick}] <- ${event.line}`);
      });
      client.on("socket close", () => {
        // eslint-disable-next-line no-console
        console.log(`[peer:${opts.nick}] socket close`);
      });
    }

    const registered = once<{ nick: string }>(
      client,
      "registered",
      REGISTER_TIMEOUT_MS,
      `register ${opts.nick}`,
    );

    // Ghost/collision hardening (#604). If the requested nick is already held —
    // a residual ghost from a prior run, or a live collision under bahamut's
    // per-IP limits — bahamut answers 433 ERR_NICKNAMEINUSE and waits for a
    // fresh NICK. irc-framework (4.14.0) does NOT auto-retry during
    // registration; it only emits `nick in use`, so `connect` would hang until
    // REGISTER_TIMEOUT_MS and surface as a 15s locator timeout in whatever spec
    // ran next (the #277 flake). Retry with a suffixed alternate until one is
    // free; `peer.nick` is reconciled from the `registered` event below to
    // whatever the server actually granted. Removed once registration lands.
    let collisionAttempt = 0;
    const onNickInUse = () => {
      collisionAttempt += 1;
      client.changeNick(`${opts.nick}_${collisionAttempt}`);
    };
    client.on("nick in use", onNickInUse);

    client.connect({
      // Default target is the azzurra leaf (`bahamut-test`); callers can
      // override `host` to reach a SEPARATE ircd (e.g. the #211 phase-7
      // second-network standalone `bahamut-test2`), so a peer can speak
      // on the same channel-name on the OTHER network's namespace.
      host: opts.host ?? HOST,
      port: PORT,
      nick: opts.nick,
      username: opts.nick,
      // gecos (realname) defaults to the nick; callers can override to inject
      // mIRC-formatted free-text so a WHO reply exercises the modal's
      // formatting render path (#175).
      gecos: opts.gecos ?? opts.nick,
      auto_reconnect: false,
    });

    const welcome = await registered;
    client.removeListener("nick in use", onNickInUse);
    // Reconcile with the nick the server ACTUALLY registered (#604). The 001
    // RPL_WELCOME nick is authoritative: it differs from the requested nick
    // after a 433 retry above, or when bahamut truncated an over-NICKLEN nick.
    // irc-framework already tracks it on client.user.nick; mirror it here so
    // every downstream verb keyed on peer.nick addresses the peer that exists.
    peer.nick = welcome.nick;
    return peer;
  }

  async join(channel: string): Promise<void> {
    const joined = onceMatching(
      this.client,
      "join",
      (event: { nick: string; channel: string }) =>
        event.nick === this.nick && event.channel === channel,
      JOIN_TIMEOUT_MS,
      `join ${channel}`,
    );
    this.client.join(channel);
    await joined;
  }

  // Send a PRIVMSG to a target (channel or nick). Resolves once the
  // command is queued; `irc-framework` does not echo own messages back
  // by default, so callers that need delivery confirmation must observe
  // grappa-side state (DB / channel event) instead.
  privmsg(target: string, body: string): void {
    this.client.say(target, body);
  }

  // Send a CTCP ACTION (the wire shape of `/me text`). Same fire-and-
  // queue semantics as `privmsg` — `irc-framework` doesn't echo own
  // commands, observe grappa state for delivery confirmation.
  action(target: string, body: string): void {
    this.client.action(target, body);
  }

  // Await an inbound PRIVMSG to this peer from `fromNick` whose message
  // contains `body`, having issued `trigger` (the send that is supposed
  // to produce it):
  //   await peer.waitForPrivmsg(nick, body, () => composeSend(page, body));
  //
  // The trigger is an ARGUMENT rather than something the caller runs
  // between an arm and an await (#806 defect 1). That is what lets the
  // listener be attached before the trigger — so a fast reply cannot race
  // it — while the deadline is clocked from the trigger, instead of the
  // caller's trigger silently eating the delivery budget. Everything the
  // wait saw is reported on failure; see `privmsgWait.ts`.
  //
  // #373 — proves grappa routed an operator's DM to the LIVE (renamed)
  // nick with NO 401: if routing had followed the stale old nick the peer
  // never receives it and this fails with cause SILENCE.
  waitForPrivmsg(
    fromNick: string,
    body: string,
    trigger: () => void | Promise<void>,
    timeoutMs = PRIVMSG_TIMEOUT_MS,
  ): Promise<void> {
    return awaitPrivmsg(this.client, { fromNick, body, timeoutMs, trigger });
  }

  // Send a raw NOTICE to a target. `target` may be a nick, a channel, or
  // a STATUSMSG-prefixed channel (`@#chan` ops-only, `+#chan` voice) —
  // used by the #218 spec to verify grappa routes a statusmsg-targeted
  // notice to the channel window. Raw (not `client.notice`) so the exact
  // wire target is preserved verbatim; `raw(array)` adds the trailing-
  // param `:` itself. Fire-and-forget — irc-framework doesn't echo own
  // commands, so observe grappa state for delivery confirmation.
  notice(target: string, body: string): void {
    this.client.raw(["NOTICE", target, body]);
  }

  // #591 — answer an inbound CTCP PING by echoing its token straight back as a
  // CTCP PING NOTICE, exactly as a real client (or shottino) does. Parsed off
  // the RAW wire line rather than irc-framework's CTCP middleware, so it works
  // regardless of the library's own CTCP handling; a `done` latch makes it
  // one-shot, so a stray library auto-response can't double-fire from here.
  // Call BEFORE the operator's `/ping` so the listener is armed when the query
  // arrives. Grappa routes the reply to `$server` (CTCP-framed, 96bedfdd) and
  // cic's correlation gate synthesises the RTT in the window `/ping` was typed.
  answerCtcpPing(): void {
    const delim = String.fromCharCode(1);
    const marker = `:${delim}PING`;
    let done = false;
    this.client.on("raw", (event: { line: string; from_server: boolean }) => {
      if (done || !event.from_server || event.line[0] !== ":") return;
      const line = event.line;
      // ":asker!user@host PRIVMSG <me> :\x01PING <token>\x01"
      if (!line.includes(" PRIVMSG ")) return;
      const at = line.indexOf(marker);
      if (at < 0) return;
      done = true;
      const asker = line.slice(1, line.search(/[! ]/));
      // Token = the bytes after ":\x01PING " up to the closing \x01 (optional),
      // echoed verbatim — the whole protocol is that it returns byte for byte.
      let rest = line.slice(at + marker.length);
      if (rest.startsWith(" ")) rest = rest.slice(1);
      const end = rest.indexOf(delim);
      const token = end >= 0 ? rest.slice(0, end) : rest;
      const body = token === "" ? `${delim}PING${delim}` : `${delim}PING ${token}${delim}`;
      this.client.raw(["NOTICE", asker, body]);
    });
  }

  // Register a nick with NickServ. Used by P-0a e2es to put a peer
  // into +r (registered) state so a subsequent /whois returns 307
  // RPL_WHOISREGNICK. With EMAIL:1 (the config since GH #349 wired the
  // registration wizard's real-services e2e) REGISTER sets NI_AUTH and
  // emails a confirmation code — the nick does NOT reach +r until the
  // caller sends `AUTH <code>` (see `nickservAuth`). Services also
  // validates the email FORMAT (`*.local` TLDs rejected) — use a
  // well-formed address.
  async nickservRegister(password: string, email: string): Promise<void> {
    const noticeReceived = once(
      this.client,
      "notice",
      NICKSERV_TIMEOUT_MS,
      `nickserv register notice for ${this.nick}`,
    );
    this.client.raw(["PRIVMSG", "NickServ", `REGISTER ${password} ${email}`]);
    await noticeReceived;
  }

  // Identify with NickServ + wait for the +r umode to actually land
  // BEFORE resolving. Services emits SVSMODE +r over the S2S link
  // after the IDENTIFY notice, and the leaf-side `m_svsmode` then
  // emits a regular MODE event back to the locally-connected user.
  // Both events can land in either order; starting both listeners
  // BEFORE the IDENTIFY rules out the race that otherwise lets a
  // post-identify /whois fire before bahamut's `IsRegNick` gate
  // (s_user.c:2240) is satisfied. Requires services to be U-lined on
  // the leaf the peer connects to (azzurra-testnet d998d09).
  //
  // Note on the irc-framework event name: it emits `mode` (NOT
  // `user mode`) for both channel and user MODE lines, distinguished
  // by `target` (channel name vs nick). User-targeted MODE arrives as
  // `:nick MODE nick :+modes` so `target === this.nick`.
  async nickservIdentify(password: string): Promise<void> {
    const noticeReceived = once(
      this.client,
      "notice",
      NICKSERV_TIMEOUT_MS,
      `nickserv identify notice for ${this.nick}`,
    );
    const umodeRSet = onceMatching(
      this.client,
      "mode",
      (event: { target: string; raw_modes: string }) =>
        event.target === this.nick && event.raw_modes.includes("+r"),
      NICKSERV_TIMEOUT_MS,
      `umode +r on ${this.nick}`,
    );
    this.client.raw(["PRIVMSG", "NickServ", `IDENTIFY ${password}`]);
    await Promise.all([noticeReceived, umodeRSet]);
  }

  // Complete a fresh registration's email-auth: send `AUTH <code>` and
  // wait for the +r umode to land BEFORE resolving. With EMAIL:1 (the
  // testnet config since GH #349) a just-REGISTERed nick carries NI_AUTH
  // and is NOT +r until AUTH clears it; do_register already identified
  // the caller, so AUTH alone flips +r (nickserv.c do_auth) — no separate
  // IDENTIFY needed. The caller reads `code` from the mailpit sink the
  // REGISTER mail was relayed to (fixtures/mailpit). Same +r-race guard
  // as nickservIdentify: start the mode listener BEFORE sending AUTH.
  async nickservAuth(code: string): Promise<void> {
    const noticeReceived = once(
      this.client,
      "notice",
      NICKSERV_TIMEOUT_MS,
      `nickserv auth notice for ${this.nick}`,
    );
    const umodeRSet = onceMatching(
      this.client,
      "mode",
      (event: { target: string; raw_modes: string }) =>
        event.target === this.nick && event.raw_modes.includes("+r"),
      NICKSERV_TIMEOUT_MS,
      `umode +r on ${this.nick}`,
    );
    this.client.raw(["PRIVMSG", "NickServ", `AUTH ${code}`]);
    await Promise.all([noticeReceived, umodeRSet]);
  }

  // Set the peer's AWAY message. Resolves on bahamut's 306 RPL_NOWAWAY
  // (which it sends back to the AWAY-issuing client). Used by P-0b
  // peer-away e2e — once the peer is away, the operator's PRIVMSG to
  // them triggers a 301 RPL_AWAY back to the operator.
  //
  // Empty `message` is the "I'm back" form; bahamut replies with 305
  // RPL_UNAWAY instead. Caller can pass empty + change the predicate
  // if they need that path.
  async away(message: string): Promise<void> {
    const ack = onceMatching(
      this.client,
      "raw",
      (event: { line?: string }) =>
        typeof event.line === "string" && / 306 /.test(event.line),
      AWAY_TIMEOUT_MS,
      `away ack (306 RPL_NOWAWAY) for ${this.nick}`,
    );
    this.client.raw(["AWAY", `:${message}`]);
    await ack;
  }

  // Fire a WHOIS at `nick`. Fire-and-forget: the caller witnesses the
  // reply lines via `waitForLine` (e.g. a `301` RPL_AWAY when `nick` is
  // currently away). Used by the #671 auto-away-on-disconnect e2e to
  // witness the bouncer's upstream AWAY after its last socket dies stale.
  whois(nick: string): void {
    this.client.raw(["WHOIS", nick]);
  }

  async part(channel: string, reason: string): Promise<void> {
    const parted = onceMatching(
      this.client,
      "part",
      (event: { nick: string; channel: string }) =>
        event.nick === this.nick && event.channel === channel,
      PART_TIMEOUT_MS,
      `part ${channel}`,
    );
    this.client.part(channel, reason);
    await parted;
  }

  // Issue a raw INVITE <target_nick> <channel> line. Fire-and-forget
  // (no upstream ack to await — bahamut emits 341 RPL_INVITING back to
  // the inviter, but the test cares about the operator-side relay
  // landing in cic, not the inviter-side ack). Used by no-silent-drops
  // B6.4 b2-inbound-invite-cta.spec.ts.
  rawInvite(targetNick: string, channel: string): void {
    this.client.raw(["INVITE", targetNick, channel]);
  }

  // Set channel modes. Resolves once upstream echoes the MODE event for
  // the target channel matching the requested raw_modes string.
  // Examples: `mode("#chan", "+i")`, `mode("#chan", "+o", "nick")`,
  // `mode("#chan", "+b", "*!*@evil")`. Param-bearing modes accept a
  // single extra arg (matching irc-framework's `mode(ch, m, extra_args)`
  // signature; arrays are also accepted by the lib for batched ops).
  //
  // Predicate matches `raw_modes` rather than the parsed `modes` array
  // because some servers (bahamut included) echo the modes back with
  // adjacent-mode-letter packing (`+ot`) where the test asked for `+o`
  // alone — `raw_modes.includes(rawModes.replace(/^[+-]/, ''))` would
  // be a stricter check, but for our use sites (single-letter modes)
  // the literal echo is reliable enough.
  async mode(channel: string, rawModes: string, extraArg?: string): Promise<void> {
    const modeEcho = onceMatching(
      this.client,
      "mode",
      (event: { target: string; raw_modes: string }) =>
        event.target === channel && event.raw_modes === rawModes,
      MODE_TIMEOUT_MS,
      `mode ${channel} ${rawModes}${extraArg ? " " + extraArg : ""}`,
    );
    this.client.mode(channel, rawModes, extraArg);
    await modeEcho;
  }

  // Set a channel topic. Resolves once upstream echoes the `topic`
  // event for the target channel carrying the new text. The peer must
  // be able to set the topic — on a freshly-created channel the creator
  // is chanop (+o), which satisfies the default `+t` (topic-lock) mode.
  // Used by #220 to seed a URL-bearing LIST topic on an unjoined channel
  // so the /list row's link routing can be exercised.
  //
  // NB: pass the raw text — `client.raw(array)` adds the IRC
  // trailing-param `:` itself; a manual leading colon would be stored
  // literally (the double-colon `TOPIC #c ::text` trap).
  async topic(channel: string, text: string): Promise<void> {
    const topicSet = onceMatching(
      this.client,
      "topic",
      (event: { channel: string; topic: string }) =>
        event.channel === channel && event.topic === text,
      TOPIC_TIMEOUT_MS,
      `topic ${channel}`,
    );
    this.client.raw(["TOPIC", channel, text]);
    await topicSet;
  }

  // Witness an INBOUND topic change: resolve once THIS peer (already
  // joined to `channel`) receives a TOPIC carrying `text` — i.e. someone
  // ELSE set it. Used by #74 to prove the cic inline-topic-edit reached
  // upstream for real (not an optimistic client paint). The listener is
  // attached synchronously when this is CALLED, so arm it BEFORE
  // triggering the set to avoid a race:
  //   const seen = peer.waitForTopic(ch, txt); // listener attached now
  //   ...submit the topic in cic...
  //   await seen;                              // real upstream send proven
  async waitForTopic(channel: string, text: string): Promise<void> {
    await onceMatching(
      this.client,
      "topic",
      (event: { channel: string; topic: string }) =>
        event.channel === channel && event.topic === text,
      TOPIC_TIMEOUT_MS,
      `witness topic ${channel}`,
    );
  }

  // KICK a target nick from a channel with a reason. Resolves once
  // upstream echoes the KICK on the channel topic. Caller must be op
  // (`+o`) on the channel — bahamut otherwise emits 482
  // ERR_CHANOPRIVSNEEDED and this resolves never (the test times out).
  async kick(channel: string, target: string, reason: string): Promise<void> {
    const kicked = onceMatching(
      this.client,
      "kick",
      (event: { nick: string; kicked: string; channel: string }) =>
        event.nick === this.nick && event.kicked === target && event.channel === channel,
      KICK_TIMEOUT_MS,
      `kick ${channel} ${target}`,
    );
    this.client.raw(["KICK", channel, target, reason]);
    await kicked;
  }

  // Issue a raw KILL <target> :<reason> (oper-only upstream) — #554 e2e:
  // an opered peer KILLs the grappa session's upstream nick to prove the
  // KILL-terminal path. Fire-and-forget: irc-framework doesn't echo own
  // commands, and the victim's disconnect is observed SERVER-side (the
  // credential goes connection_state :failed), not on this peer.
  // `raw(array)` adds the trailing-param `:` itself, so the reason ships
  // as one token. Requires a prior `oper(...)`.
  kill(targetNick: string, reason: string): void {
    this.client.raw(["KILL", targetNick, reason]);
  }

  // /OPER up to ircop. Required to bypass bahamut's "no ops on new
  // channels in split-mode" gate that otherwise locks every freshly
  // created channel out of any kind of mode-setting (including +i, +k,
  // +o). Resolves on 381 RPL_YOUREOPER.
  //
  // Reason this matters for e2e: the testnet leaf isn't S2S-linked to
  // the hub at the time peer clients connect (255 reports `0 servers`),
  // so bahamut keeps the leaf in split-mode permanently — fresh JOINers
  // never auto-op. Without ircop bypass, the peer can JOIN but cannot
  // MODE +i / MODE +o anyone, including itself. With +O (and the
  // configured `OaARD` flagset on the leaf's O: line), ircops issue
  // MODE / SAMODE freely on any channel they're in.
  //
  // #367 — we wait on the raw `381` wire-line, NOT an `rpl_youreoper`
  // named event: irc-framework does not surface 381 as a typed event, so
  // the prior `once(client, "rpl_youreoper", …)` never fired even though
  // bahamut DID send 381 (this method had no caller until #367's WHOIS
  // oper-text e2e, so the dead event name went unnoticed). `waitForLine`
  // is registered BEFORE the OPER frame goes out, so a fast 381 can't
  // race the listener.
  async oper(name: string, password: string): Promise<void> {
    const opered = this.waitForLine(/ 381 /, `oper ${name}`, OPER_TIMEOUT_MS);
    this.client.raw(["OPER", name, password]);
    await opered;
  }

  // Change own nick. Resolves after the upstream `nick` event with
  // matching old→new transition. Updates `this.nick` so subsequent
  // verbs use the new nick. The `irc-framework` event payload is
  // `{nick: oldNick, new_nick: newNick}` per the lib's own naming.
  async changeNick(newNick: string): Promise<void> {
    const oldNick = this.nick;
    const renamed = onceMatching(
      this.client,
      "nick",
      (event: { nick: string; new_nick: string }) =>
        event.nick === oldNick && event.new_nick === newNick,
      NICK_TIMEOUT_MS,
      `nick ${oldNick} → ${newNick}`,
    );
    this.client.changeNick(newNick);
    await renamed;
    this.nick = newNick;
  }

  // Witness an inbound server line matching `pattern`. Unlike `mode` /
  // `kick` / `oper` above — which await the peer's OWN action echo —
  // this awaits a line the peer receives because a THIRD PARTY acted in
  // a channel it shares (e.g. a MODE or PRIVMSG issued by another member).
  // The `raw` event fires for every wire-line; `from_server` filters out
  // the peer's own outbound frames. Used by the #153 visitor-verbs spec
  // to prove a visitor's /mode and /quote reached upstream AND took
  // effect — the peer only sees the line if bahamut applied and relayed
  // it.
  waitForLine(pattern: RegExp, label: string, timeoutMs = 8_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.removeListener("raw", handler);
        reject(new Error(`IrcPeer: timeout waiting for ${label} (${timeoutMs}ms)`));
      }, timeoutMs);
      const handler = (event: { line: string; from_server: boolean }) => {
        if (!event.from_server || !pattern.test(event.line)) return;
        clearTimeout(timer);
        this.client.removeListener("raw", handler);
        resolve(event.line);
      };
      this.client.on("raw", handler);
    });
  }

  async disconnect(reason: string): Promise<void> {
    return new Promise((resolve) => {
      this.client.on("close", () => resolve());
      this.client.quit(reason);
    });
  }
}

// #806 — every wait below detaches its handler on the TIMEOUT branch too,
// not just on the match. Rejecting without detaching leaves the handler
// attached for the life of the peer: harmless-looking, but `waitForLine`'s
// runs a regex over every wire line thereafter, and the next helper written
// in this shape inherits it.
function once<T = unknown>(
  client: Client,
  event: string,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener(event, handler);
      reject(new Error(`IrcPeer: timeout waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);
    const handler = (payload: T) => {
      clearTimeout(timer);
      client.removeListener(event, handler);
      resolve(payload);
    };
    client.on(event, handler);
  });
}

function onceMatching<T>(
  client: Client,
  event: string,
  predicate: (payload: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener(event, handler);
      reject(new Error(`IrcPeer: timeout waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      client.removeListener(event, handler);
      resolve(payload);
    };
    client.on(event, handler);
  });
}
