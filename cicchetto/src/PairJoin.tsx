import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ApiError } from "./lib/api";
import { token } from "./lib/auth";
import { joinPairing, openChannel, type PairingChannel } from "./lib/e2e/pairing";
import { pairingDeps } from "./lib/e2e/pairingDeps";
import { takeAcceptedPairing } from "./lib/e2e/pairingOffer";
import { type JoinerState, joinerPairing, type NetworkResult } from "./lib/e2e/pairingSession";
import { pairedHere } from "./lib/encryptedChats";
import { friendlyApiError } from "./lib/friendlyApiError";
import PairResults from "./PairResults";

// issue 2430, X1 — the `/pair` route, where a browser joins a pairing that
// another device of this account opened ("add a device", AddDeviceOffer).
// Issue 2549: it joins only the offer the "Pair this browser" banner handed
// it (`takeAcceptedPairing`, once, in this tab), and nothing in the address
// bar names one. A link or QR carrying the code opened in the system browser
// rather than the installed app, and paired the wrong one. A Back to this
// route, a reload of it, an old link to it, or a browser with no login finds
// nothing handed over and is told where pairing starts instead.
//
// Outside the Shell, so outside its banners, and an installed app has no
// address bar: every page that ends here offers the way back.
//
// This route joins the rendezvous and holds its channel, and a joiner session
// (lib/e2e/pairingSession) drives it: it reads what arrives, shows the check
// code to type on the other device, and on "Pair this browser" registers this
// browser with each network offered. The route renders the session's state.

type Joined = ReturnType<typeof joinerPairing>;

type Stage =
  | { tag: "none" }
  | { tag: "joining" }
  | { tag: "joined" }
  | { tag: "failed"; message: string };

const ENDED: Record<NonNullable<JoinerState["ended"]>, string> = {
  closed: "The other device ended the pairing.",
  expired: "The pairing expired. Start a new one on your other device.",
  replaced: "Your other device started a new pairing. Go back to grappa and accept it there.",
  gone: "The pairing is no longer available. Start a new one on your other device.",
  "nothing-to-pair": "Your other browser had no network to add this browser to.",
  failed: "The pairing failed. Start a new one on your other device.",
};

const failure = (err: unknown): string =>
  err instanceof ApiError ? friendlyApiError(err) : "Could not reach the server.";

// This browser is paired where it was added now or already was.
const pairedOn = (r: NetworkResult): boolean => r.outcome === "added" || r.outcome === "paired";

const PairJoin: Component = () => {
  const navigate = useNavigate();
  const [stage, setStage] = createSignal<Stage>({ tag: "joining" });
  const [session, setSession] = createSignal<Joined | null>(null);
  let channel: PairingChannel | null = null;
  let gone = false;

  onMount(async () => {
    // Taken first, login or not, so a hand-over never outlives this page.
    const code = takeAcceptedPairing();
    const t = token();
    if (code === null || t === null) {
      setStage({ tag: "none" });
      return;
    }
    let deps: Awaited<ReturnType<typeof pairingDeps>>;
    try {
      deps = await pairingDeps(t);
    } catch (err) {
      console.warn("[e2e] could not prepare this browser for pairing", err);
      setStage({ tag: "failed", message: "Could not prepare this browser for pairing." });
      return;
    }
    // Left the route while this browser was being prepared: joining now would
    // take the rendezvous's one joiner slot for a page nobody is on.
    if (gone) return;
    try {
      const rendezvous = await joinPairing(t, code.id);
      const joined = joinerPairing({ ...deps, paired: pairedHere }, code);
      channel = openChannel(t, rendezvous, {
        onMessage: (payload) => joined.onPayload(payload),
        onClosed: (reason) => joined.onClosed(reason),
      });
      // Left the route while the join was in flight: the cleanup found no
      // channel, so close it here, or the other device waits out the TTL.
      if (gone) {
        joined.cancel();
        void channel.close();
        return;
      }
      joined.attach(channel);
      setSession(joined);
      setStage({ tag: "joined" });
    } catch (err) {
      setStage({ tag: "failed", message: failure(err) });
    }
  });

  onCleanup(() => {
    gone = true;
    session()?.cancel();
    void channel?.close();
  });

  // Nothing more will happen on this page: it says why, and leads back.
  const finished = (): boolean => {
    const tag = stage().tag;
    const joined = session()?.state().stage;
    return tag === "none" || tag === "failed" || joined === "done" || joined === "ended";
  };

  const cancel = async () => {
    session()?.cancel();
    await channel?.close();
    navigate("/", { replace: true });
  };

  return (
    <main class="pair-join">
      <h1>Pair this device</h1>
      <Show when={stage().tag === "none"}>
        <p data-testid="pair-none">
          No pairing to join here. On a device that holds your encrypted chats, open "add a device",
          then tap "Pair this browser" on the banner grappa shows on this one.
        </p>
      </Show>
      <Show when={stage().tag === "joining"}>
        <p>Connecting to your other device…</p>
      </Show>
      <Show when={session()}>
        {(joined) => {
          const j = () => joined().state();
          const full = () => (
            <Show when={j().full.length > 0}>
              <p class="muted" data-testid="pair-full">
                Not offered, already 4 devices: {j().full.join(", ")}
              </p>
            </Show>
          );
          return (
            <>
              <Show when={j().stage === "joining"}>
                <p data-testid="pair-joined">
                  Connected to your other device. Keep both screens open.
                </p>
              </Show>
              <Show when={j().stage === "code"}>
                <p class="pair-code" data-testid="pair-check-code">
                  Type this code on the other device: {j().checkCode}
                </p>
              </Show>
              <Show when={j().stage === "confirm"}>
                <p>This browser will be added to your encrypted chats on:</p>
                <ul>
                  <For each={j().offered}>
                    {(slug) => <li data-testid={`pair-offered-${slug}`}>{slug}</li>}
                  </For>
                </ul>
                {full()}
                <button type="button" data-testid="pair-confirm" onClick={() => joined().confirm()}>
                  Pair this browser
                </button>
              </Show>
              <Show when={j().stage === "joining-networks"}>
                <p>Pairing…</p>
              </Show>
              <Show when={j().stage === "done"}>
                <Show
                  when={j().results.some(pairedOn)}
                  fallback={<p data-testid="pair-not-paired">This browser was not paired.</p>}
                >
                  <p data-testid="pair-done">This browser is paired.</p>
                </Show>
                <PairResults results={j().results} />
              </Show>
              <Show when={j().stage === "ended"}>
                <p data-testid="pair-ended">{ENDED[j().ended ?? "failed"]}</p>
                <Show when={j().ended === "nothing-to-pair"}>{full()}</Show>
              </Show>
              <Show when={j().stage !== "done" && j().stage !== "ended"}>
                <button type="button" data-testid="pair-cancel" onClick={() => void cancel()}>
                  Cancel
                </button>
              </Show>
            </>
          );
        }}
      </Show>
      <Show
        when={(() => {
          const s = stage();
          return s.tag === "failed" ? s : null;
        })()}
      >
        {(s) => (
          <p role="alert" data-testid="pair-failed">
            {s().message}
          </p>
        )}
      </Show>
      <Show when={finished()}>
        <a href="/">Back to grappa</a>
      </Show>
    </main>
  );
};

export default PairJoin;
