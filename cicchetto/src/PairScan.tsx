import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ApiError } from "./lib/api";
import { token } from "./lib/auth";
import {
  joinPairing,
  openChannel,
  type PairCode,
  type PairingChannel,
  parsePairFragment,
} from "./lib/e2e/pairing";
import { pairingDeps } from "./lib/e2e/pairingDeps";
import { type JoinerState, joinerPairing, type NetworkResult } from "./lib/e2e/pairingSession";
import { pairedHere } from "./lib/encryptedChats";
import { friendlyApiError } from "./lib/friendlyApiError";
import PairResults from "./PairResults";

// issue 2430, X1 — the `/pair` route: where the OS camera lands after
// scanning the QR another device of this account shows (AddDeviceQr). The
// code rides the FRAGMENT, `#pair=<rendezvous id>.<ephemeral key>`, and is
// scrubbed from the address bar before anything else happens, as `/share`
// does with its token. Unlike that token the code is public, but a URL left
// in history is still a URL someone else's device could follow.
//
// Outside RequireAuth on purpose: a device with no session would be bounced
// to /login and the fragment lost with it. Such a device is told to log in
// first and scan again, since the pairing is between two devices of ONE
// account and grappa refuses anything else.
//
// This route joins the rendezvous and holds its channel, and a joiner session
// (lib/e2e/pairingSession) drives it: it reads what arrives, shows the check
// code to type on the other device, and on "Pair this browser" registers this
// browser with each network offered. The route renders the session's state.

type Joined = ReturnType<typeof joinerPairing>;

type Stage =
  | { tag: "invalid" }
  | { tag: "login" }
  | { tag: "joining" }
  | { tag: "joined" }
  | { tag: "failed"; message: string };

const takeCodeFromFragment = (): PairCode | null => {
  const code = parsePairFragment(window.location.hash);
  if (window.location.hash !== "") {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return code;
};

const ENDED: Record<NonNullable<JoinerState["ended"]>, string> = {
  closed: "The other device ended the pairing.",
  expired: "The pairing expired. Show a new code on your other device.",
  replaced: "Your other device started a new pairing. Scan its new code.",
  gone: "The pairing is no longer available. Scan a new code.",
  "nothing-to-pair": "Your other browser had no network to add this browser to.",
  failed: "The pairing failed. Scan a new code.",
};

// This browser is paired where it was added now or already was.
const pairedOn = (r: NetworkResult): boolean => r.outcome === "added" || r.outcome === "paired";

const PairScan: Component = () => {
  const navigate = useNavigate();
  const [stage, setStage] = createSignal<Stage>({ tag: "joining" });
  const [session, setSession] = createSignal<Joined | null>(null);
  let channel: PairingChannel | null = null;
  let gone = false;

  onMount(async () => {
    const code = takeCodeFromFragment();
    if (code === null) {
      setStage({ tag: "invalid" });
      return;
    }
    const t = token();
    if (t === null) {
      setStage({ tag: "login" });
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
      const message =
        err instanceof ApiError ? friendlyApiError(err) : "Could not reach the server.";
      setStage({ tag: "failed", message });
    }
  });

  onCleanup(() => {
    gone = true;
    session()?.cancel();
    void channel?.close();
  });

  const cancel = async () => {
    session()?.cancel();
    await channel?.close();
    navigate("/", { replace: true });
  };

  return (
    <main class="pair-scan">
      <h1>Pair this device</h1>
      <Show when={stage().tag === "invalid"}>
        <p data-testid="pair-invalid">This pairing link is not valid. Scan the code again.</p>
      </Show>
      <Show when={stage().tag === "login"}>
        <p data-testid="pair-login">
          Log in on this device with the same account first, then scan the code again.{" "}
          <a href="/login">Log in</a>
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
                <a href="/">Back to grappa</a>
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
    </main>
  );
};

export default PairScan;
