import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { ApiError } from "./lib/api";
import { token } from "./lib/auth";
import {
  type CloseReason,
  joinPairing,
  openChannel,
  type PairCode,
  type PairingChannel,
  parsePairFragment,
} from "./lib/e2e/pairing";
import { friendlyApiError } from "./lib/friendlyApiError";

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
// This route joins the rendezvous and holds its channel. What travels on the
// channel (the ECIES handshake, the check code, the identity the other
// device signs over) is the crypto layer's, and nothing on this side reads
// it yet: that layer will supply the `onMessage` handed to `openChannel`.

type Stage =
  | { tag: "invalid" }
  | { tag: "login" }
  | { tag: "joining" }
  | { tag: "joined" }
  | { tag: "failed"; message: string }
  | { tag: "ended"; reason: CloseReason };

const takeCodeFromFragment = (): PairCode | null => {
  const code = parsePairFragment(window.location.hash);
  if (window.location.hash !== "") {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return code;
};

const ENDED: Record<CloseReason, string> = {
  closed: "The other device ended the pairing.",
  expired: "The pairing expired. Show a new code on your other device.",
  replaced: "Your other device started a new pairing. Scan its new code.",
  gone: "The pairing is no longer available. Scan a new code.",
};

const PairScan: Component = () => {
  const navigate = useNavigate();
  const [stage, setStage] = createSignal<Stage>({ tag: "joining" });
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
    try {
      const rendezvous = await joinPairing(t, code.id);
      channel = openChannel(t, rendezvous, {
        onMessage: () => undefined,
        onClosed: (reason) => setStage({ tag: "ended", reason }),
      });
      // Left the route while the join was in flight: the cleanup found no
      // channel, so close it here, or the other device waits out the TTL.
      if (gone) {
        void channel.close();
        return;
      }
      setStage({ tag: "joined" });
    } catch (err) {
      const message =
        err instanceof ApiError ? friendlyApiError(err) : "Could not reach the server.";
      setStage({ tag: "failed", message });
    }
  });

  onCleanup(() => {
    gone = true;
    void channel?.close();
  });

  const cancel = async () => {
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
      <Show when={stage().tag === "joined"}>
        <p data-testid="pair-joined">Connected to your other device. Keep both screens open.</p>
        <button type="button" data-testid="pair-cancel" onClick={() => void cancel()}>
          Cancel
        </button>
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
      <Show
        when={(() => {
          const s = stage();
          return s.tag === "ended" ? s : null;
        })()}
      >
        {(s) => <p data-testid="pair-ended">{ENDED[s().reason]}</p>}
      </Show>
    </main>
  );
};

export default PairScan;
