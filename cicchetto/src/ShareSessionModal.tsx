import { type Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { mintShareToken } from "./lib/api";
import { token } from "./lib/auth";
import { createOverlayLock } from "./lib/overlayScrollLock";

// Visitor session-sharing — modal that displays a one-time share URL.
//
// Flow when `props.open` flips true:
//   1. POST /me/share-token via mintShareToken — server returns
//      {token, expires_at}. ISO8601 string in UTC.
//   2. Build the share URL as `${origin}/#/share/${token}` (hash route
//      so the cic SPA owns it without any server-side routing change).
//   3. Render the URL + a copy-to-clipboard button + a live countdown
//      to expiry. The mint is one-shot per modal-open: we don't refetch
//      a fresh token unless the user closes and re-opens. (Refetching
//      while a token is unconsumed would orphan the previous one in
//      the operator's clipboard.)
//
// Server side guarantees:
//   - Visitor-only — the api 403s for user subjects. The Settings UI
//     should hide the entry point for user subjects anyway, but the
//     server enforces.
//   - Single-use — if the operator clicks the link twice (or two devices
//     race) the second consume returns 410 share_token_consumed.
//
// No optimistic UI for mint failure — if the network is down we show
// an explicit error string; the operator can close + retry.

export type Props = {
  open: boolean;
  onClose: () => void;
};

const ShareSessionModal: Component<Props> = (props) => {
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [expiresAt, setExpiresAt] = createSignal<Date | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [now, setNow] = createSignal(new Date());

  // Refetch on every open transition. Closure-tracked `wasOpen` so a
  // re-render with the same value doesn't re-mint.
  let wasOpen = false;
  createEffect(() => {
    if (props.open && !wasOpen) {
      wasOpen = true;
      void mintOnOpen();
    } else if (!props.open && wasOpen) {
      wasOpen = false;
      // Clear state so the next open mints fresh — the previous URL is
      // potentially leaked to anyone watching the screen, no point
      // keeping it visible behind the closed modal.
      setShareUrl(null);
      setExpiresAt(null);
      setError(null);
      setCopied(false);
    }
  });

  // 1s tick driving the countdown text. Only runs while the modal is
  // open AND a token is live; cleared on close.
  let tickId: ReturnType<typeof setInterval> | null = null;
  createEffect(() => {
    if (props.open && expiresAt() !== null) {
      if (tickId === null) {
        tickId = setInterval(() => setNow(new Date()), 1000);
      }
    } else if (tickId !== null) {
      clearInterval(tickId);
      tickId = null;
    }
  });
  onCleanup(() => {
    if (tickId !== null) clearInterval(tickId);
  });

  // Overlay scroll-lock + #232 shared Esc-to-close. ShareSessionModal had NO
  // Esc handler before — this is the a11y gap #232 closes. props.onClose is
  // the same close verb the × / backdrop use (topmost-first, focus-independent);
  // createOverlayLock also pops the refcount on unmount so a route nav-away
  // doesn't strand it.
  createOverlayLock(
    () => props.open,
    ".share-modal",
    () => props.onClose(),
  );

  const mintOnOpen = async () => {
    const t = token();
    if (t === null) {
      setError("not_authenticated");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token: shareToken, expires_at } = await mintShareToken(t);
      // Plain path route (NOT hash) — `@solidjs/router` v0.16 uses
      // path-mode by default; the hash isn't visible to the router.
      // nginx's `try_files $uri /index.html` falls back to the SPA
      // for any unknown path, so /share/<token> reaches the
      // ShareConsume route.
      const url = `${window.location.origin}/share/${encodeURIComponent(shareToken)}`;
      setShareUrl(url);
      setExpiresAt(new Date(expires_at));
    } catch (err) {
      const code = err instanceof Error ? err.message : "mint_failed";
      setError(code);
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async () => {
    const url = shareUrl();
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // Reset the "copied!" affordance after a beat so a second copy
      // re-flashes the same feedback.
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard API can fail on insecure origins or denied perms.
      // Fall through silently — the URL is still selectable in the
      // input field, the operator can copy manually.
    }
  };

  const remainingSeconds = (): number => {
    const exp = expiresAt();
    if (exp === null) return 0;
    return Math.max(0, Math.floor((exp.getTime() - now().getTime()) / 1000));
  };

  const countdownText = (): string => {
    const s = remainingSeconds();
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  };

  return (
    <Show when={props.open}>
      <div
        class="share-modal-backdrop"
        onClick={props.onClose}
        data-testid="share-modal-backdrop"
        aria-hidden="true"
      />
      <div class="share-modal" role="dialog" aria-label="share session" data-testid="share-modal">
        <header class="share-modal-header">
          <h2>share session</h2>
          <button
            type="button"
            class="share-modal-close"
            aria-label="close share session"
            data-testid="share-modal-close"
            onClick={props.onClose}
          >
            ×
          </button>
        </header>

        <p class="share-modal-help">
          send this link to yourself — open it on another device to access this same session.
        </p>

        <Show when={busy()}>
          <p class="share-modal-busy" data-testid="share-modal-busy">
            generating link…
          </p>
        </Show>

        <Show when={error() !== null}>
          <p class="share-modal-error" role="alert" data-testid="share-modal-error">
            {error()}
          </p>
        </Show>

        <Show when={shareUrl() !== null}>
          <div class="share-modal-url-row">
            <input
              type="text"
              readonly
              class="share-modal-url"
              data-testid="share-modal-url"
              value={shareUrl() ?? ""}
              onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
            />
            <button
              type="button"
              class="share-modal-copy"
              data-testid="share-modal-copy"
              onClick={() => {
                void copyToClipboard();
              }}
            >
              {copied() ? "copied!" : "copy"}
            </button>
          </div>
          <p class="share-modal-countdown" data-testid="share-modal-countdown">
            expires in {countdownText()}
          </p>
          <p class="share-modal-note">single use — consumed on first open.</p>
        </Show>
      </div>
    </Show>
  );
};

export default ShareSessionModal;
