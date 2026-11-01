// issue 2486 — asking a peer to start an encrypted chat, and the answer.
//
// grappa holds the asking (`Grappa.E2eRequests`, CLIENT_PROTOCOL §4i): one
// request per peer and network, whoever asked, so neither user has to be
// online when the other acts. This store is the MIRROR of what grappa holds,
// fed by a fetch on every user-topic (re)join and per network as the list
// brings it, then by the `e2e_request` / `e2e_request_gone` pushes. It
// originates nothing: every change is a door, and what the door answered,
// or the push it raises on every device, is what lands here.
//
// The asking is consent, not trust. Accepting opens the encrypted chat and
// asks the peer for its keys (`askEncryptedKeys`); the keys are pinned and
// checked as any key is (trust on first use, the alarm, the SAS). grappa
// never asks for keys on anyone's behalf, so both sides do it themselves:
// the one who accepts at once, the one who asked when it sees `accepted`.
//
// Every consent line goes from this device, and carries our master key as a
// hint (`{"v":2,"master":…}`), never a proof: grappa does not read it.

import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  ApiError,
  answerE2eRequest,
  askE2eRequest,
  dismissE2eRequest,
  type E2eConsentLine,
  listE2eRequests,
} from "./api";
import { token } from "./auth";
import { fold } from "./e2e/wire";
import { askEncryptedKeys, encryptedDevice, openEncryptedChat } from "./encryptedChats";
import { openEncryptedWindow } from "./encryptedWindow";
import { identityMoved } from "./identityMoved";
import { identityScopedStore } from "./identityScopedStore";
import { networks } from "./networks";
import { selectedChannel } from "./selection";
import type { E2eRequestsWireRequest } from "./wireTypes";

export type E2eRequest = E2eRequestsWireRequest;

/**
 * What the banner over the query with the peer shows, as of `now` (ms):
 * the peer asking (`incoming`), our asking still waiting (`pending`), the
 * peer's answer (`accepted`, `refused`), or our asking unanswered for 24 h
 * (`expired`). An incoming request past its deadline shows nothing: grappa
 * no longer lists it, and withdraws it within the hour.
 */
export type RequestView = {
  kind: "incoming" | "pending" | "accepted" | "refused" | "expired";
  request: E2eRequest;
};

/** The request's view as of `now`: the wire's `expired` is derived, and so is it here, at `expires_at`. */
export function requestView(request: E2eRequest | undefined, now: number): RequestView | null {
  if (request === undefined) return null;
  const lapsed = request.expires_at !== null && now >= Date.parse(request.expires_at);
  switch (request.state) {
    case "incoming":
      return lapsed ? null : { kind: "incoming", request };
    case "outgoing":
      return { kind: lapsed ? "expired" : "pending", request };
    case "expired":
    case "accepted":
    case "refused":
      return { kind: request.state, request };
  }
}

function bearer(): string {
  const t = token();
  if (!t) throw new Error("not logged in");
  return t;
}

// What a consent line goes as: from this device, our master key as the hint.
async function consentLine(slug: string): Promise<E2eConsentLine> {
  const { did, master } = await encryptedDevice(slug);
  return { from: did, payload: JSON.stringify({ v: 2, master }) };
}

const exports_ = identityScopedStore((onIdentityChange) => {
  const [requestsBySlug, setRequestsBySlug] = createSignal<
    Record<string, Record<number, E2eRequest>>
  >({});
  /** Accepted requests being opened here: the push and a fetch may both bring one. */
  const opening = new Set<string>();
  /** Per network, how many changes the mirror has taken in: a fetch can tell one landed while it was out. */
  const changes = new Map<string, number>();

  onIdentityChange(() => {
    setRequestsBySlug({});
    opening.clear();
    changes.clear();
  });

  function changed(slug: string): void {
    changes.set(slug, (changes.get(slug) ?? 0) + 1);
  }

  function put(slug: string, request: E2eRequest): void {
    changed(slug);
    setRequestsBySlug((prev) => ({
      ...prev,
      [slug]: { ...(prev[slug] ?? {}), [request.id]: request },
    }));
    if (request.state === "accepted") openArrived(slug, request);
  }

  function drop(slug: string, id: number): void {
    changed(slug);
    setRequestsBySlug((prev) => {
      if (prev[slug]?.[id] === undefined) return prev;
      const { [id]: _gone, ...rest } = prev[slug];
      return { ...prev, [slug]: rest };
    });
  }

  /** The request with `nick` on the network, if any; the newest when a push left two. */
  function e2eRequestWith(slug: string, nick: string): E2eRequest | undefined {
    const key = fold(nick);
    let found: E2eRequest | undefined;
    for (const request of Object.values(requestsBySlug()[slug] ?? {})) {
      if (fold(request.peer) === key && (found === undefined || request.id > found.id)) {
        found = request;
      }
    }
    return found;
  }

  /**
   * Reads the network's requests again; what grappa lists replaces what was
   * held. A change that landed while the read was out (a push, a door's
   * answer) may be newer than what was read, so then the network is read
   * again.
   *
   * Every verb here captures the bearer at entry and does nothing more once
   * the account changed under one of its awaits: not one request, not one
   * write (`identityMoved`).
   */
  async function loadE2eRequests(slug: string): Promise<void> {
    const t = bearer();
    const before = changes.get(slug) ?? 0;
    const listed = await listE2eRequests(t, slug);
    if (identityMoved(t)) return;
    if ((changes.get(slug) ?? 0) !== before) return loadE2eRequests(slug);
    setRequestsBySlug((prev) => ({
      ...prev,
      [slug]: Object.fromEntries(listed.map((request) => [request.id, request])),
    }));
    for (const request of listed) {
      if (request.state === "accepted") openArrived(slug, request);
    }
  }

  function loadEvery(slugs: readonly string[]): void {
    for (const slug of slugs) {
      void loadE2eRequests(slug).catch((err: unknown) => {
        console.warn(`[e2e] could not read the encrypted chat requests on ${slug}`, err);
      });
    }
  }

  /** A push is not replayed: every (re)join reads every network's requests. */
  function reloadE2eRequests(): void {
    loadEvery((networks() ?? []).map((network) => network.slug));
  }

  /**
   * The peer accepted: open the chat, ask for its keys, then the request has
   * done its job. Throws what failed: the banner's Open says it.
   */
  async function openAccepted(slug: string, request: E2eRequest): Promise<void> {
    const id = `${slug} ${request.id}`;
    if (opening.has(id)) return;
    opening.add(id);
    const t = bearer();
    try {
      // Focus moves only from the query with that peer, where the user asked:
      // anywhere else the encrypted window just appears.
      const sel = selectedChannel();
      const here =
        sel?.kind === "query" &&
        sel.networkSlug === slug &&
        fold(sel.channelName) === fold(request.peer);
      if (here) await openEncryptedWindow(slug, request.peer);
      else await openEncryptedChat(slug, request.peer);
      if (identityMoved(t)) return;
      await askEncryptedKeys(slug, request.peer);
      if (identityMoved(t)) return;
      try {
        await dismissE2eRequest(t, slug, request.id, null);
      } catch (err) {
        // Another device of the account got there first.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      if (identityMoved(t)) return;
      drop(slug, request.id);
    } finally {
      opening.delete(id);
    }
  }

  // An accepted request grappa brought (a push, a fetch) opens on its own; a
  // failure is warned, and the banner keeps offering Open.
  function openArrived(slug: string, request: E2eRequest): void {
    openAccepted(slug, request).catch((err: unknown) => {
      console.warn(
        `[e2e] could not open the encrypted chat ${request.peer} accepted on ${slug}`,
        err,
      );
    });
  }

  // A door grappa answers 404 or 409 says the request moved under this
  // device: answered or withdrawn elsewhere, or in another state now (a 404
  // may also be no session, which a read tells apart). The mirror reads the
  // network again, unless the account changed meanwhile, and the refusal
  // still reaches the caller.
  async function door<T>(slug: string, t: string, work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (err) {
      const moved = err instanceof ApiError && (err.status === 404 || err.status === 409);
      if (moved && !identityMoved(t)) loadEvery([slug]);
      throw err;
    }
  }

  /** Asks `nick`, or retries an expired asking; a request of theirs waiting is answered yes. */
  async function askEncryptedChat(slug: string, nick: string): Promise<void> {
    const t = bearer();
    const line = await consentLine(slug);
    if (identityMoved(t)) return;
    const request = await askE2eRequest(t, slug, nick, line);
    if (identityMoved(t)) return;
    put(slug, request);
  }

  /**
   * Accepts the peer's request: the chat opens here, and its keys are asked
   * for. Once grappa took the yes the request is gone, and its banner with
   * it, so what fails after is warned: the chat recovers on its own, its
   * first line asking the peer's keys.
   */
  async function acceptEncryptedChat(slug: string, request: E2eRequest): Promise<void> {
    const t = bearer();
    const line = await consentLine(slug);
    if (identityMoved(t)) return;
    await door(slug, t, answerE2eRequest(t, slug, request.id, "accept", line));
    if (identityMoved(t)) return;
    drop(slug, request.id);
    try {
      await openEncryptedWindow(slug, request.peer);
      if (identityMoved(t)) return;
      await askEncryptedKeys(slug, request.peer);
    } catch (err) {
      console.warn(`[e2e] accepted ${request.peer} on ${slug}, but the chat did not open`, err);
    }
  }

  /** Refuses the peer's request, with the dedicated REFUSE: the peer is told. */
  async function refuseEncryptedChat(slug: string, request: E2eRequest): Promise<void> {
    const t = bearer();
    const line = await consentLine(slug);
    if (identityMoved(t)) return;
    await door(slug, t, answerE2eRequest(t, slug, request.id, "refuse", line));
    if (identityMoved(t)) return;
    drop(slug, request.id);
  }

  /**
   * Withdraws our asking, or drops an answer or an expiry once shown. One we
   * asked goes with its line, which grappa needs to CANCEL it while it is
   * live; the clock here may run ahead of grappa's, so it goes whenever the
   * stored state is `outgoing`.
   */
  async function dismissEncryptedChatRequest(slug: string, request: E2eRequest): Promise<void> {
    const t = bearer();
    const line = request.state === "outgoing" ? await consentLine(slug) : null;
    if (identityMoved(t)) return;
    await door(slug, t, dismissE2eRequest(t, slug, request.id, line));
    if (identityMoved(t)) return;
    drop(slug, request.id);
  }

  /**
   * Reads each network's requests once per login as the network list brings
   * it (the user topic's join may come before the list does). Registered by
   * main.tsx.
   */
  function mountE2eRequests(): void {
    const loaded = new Set<string>();
    onIdentityChange(() => loaded.clear());
    createEffect(() => {
      if (!token()) return;
      const fresh = (networks() ?? [])
        .map((network) => network.slug)
        .filter((slug) => !loaded.has(slug));
      for (const slug of fresh) loaded.add(slug);
      loadEvery(fresh);
    });
  }

  return {
    requestsBySlug,
    putE2eRequest: put,
    dropE2eRequest: drop,
    e2eRequestWith,
    loadE2eRequests,
    reloadE2eRequests,
    openAcceptedChat: openAccepted,
    askEncryptedChat,
    acceptEncryptedChat,
    refuseEncryptedChat,
    dismissEncryptedChatRequest,
    mountE2eRequests,
  };
});

/**
 * The view of the request with `peer` on the network, kept true across its
 * deadline: read as of the moment the request changes (one may arrive
 * already past its deadline here), then one wake-up at `expires_at`, so an
 * incoming asking stops showing and ours reads expired the moment the
 * deadline passes, without waiting for grappa's sweep or the next fetch.
 * For a component (it owns an effect).
 */
export function createRequestView(
  networkSlug: () => string,
  peer: () => string,
): () => RequestView | null {
  const [now, setNow] = createSignal(Date.now());
  const request = () => exports_.e2eRequestWith(networkSlug(), peer());
  createEffect(() => {
    const at = request()?.expires_at;
    setNow(Date.now());
    if (at == null) return;
    const deadline = Date.parse(at);
    const wait = deadline - Date.now();
    if (wait <= 0) return;
    // Never read as before the deadline it woke up for.
    const timer = setTimeout(() => setNow(Math.max(Date.now(), deadline)), wait);
    onCleanup(() => clearTimeout(timer));
  });
  return () => requestView(request(), now());
}

export const requestsBySlug = exports_.requestsBySlug;
export const putE2eRequest = exports_.putE2eRequest;
export const dropE2eRequest = exports_.dropE2eRequest;
export const e2eRequestWith = exports_.e2eRequestWith;
export const loadE2eRequests = exports_.loadE2eRequests;
export const reloadE2eRequests = exports_.reloadE2eRequests;
export const openAcceptedChat = exports_.openAcceptedChat;
export const askEncryptedChat = exports_.askEncryptedChat;
export const acceptEncryptedChat = exports_.acceptEncryptedChat;
export const refuseEncryptedChat = exports_.refuseEncryptedChat;
export const dismissEncryptedChatRequest = exports_.dismissEncryptedChatRequest;
export const mountE2eRequests = exports_.mountE2eRequests;
