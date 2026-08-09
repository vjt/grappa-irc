import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { mintShareToken } from "./lib/api";
import { token } from "./lib/auth";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { qrSvg } from "./lib/qr";
import { closeShareModal, SHARE_SESSION_LABEL, shareModalOpen } from "./lib/shareModal";

// #392 — session-wide "open on another device" modal. ONE instance mounted
// in Shell; opened by BOTH the home "open on another device" button and the
// settings share entry (openShareModal → shareModalOpen). Reverses
// #335's sub-page back to a modal so the QR + native-share + countdown live in
// a focused overlay reachable from home.
//
// Reuses the #335 mint/countdown/native-share/copy logic; adds a scannable QR
// (lib/qr.ts). VISITOR-ONLY by design — the server's /me/share-token 403s for
// password-holding users, and BOTH triggers gate their button on the visitor
// subject, so a user never reaches this modal (they log in directly on the
// second device). #392 keeps the existing visitor-only token/TTL infra
// untouched: no server change.
//
// SECURITY: the share URL is a signed, single-use, short-TTL credential.
// Closing DISCARDS it (a token left on screen leaks to anyone watching) and
// re-opening mints a fresh one — mirrors the #335 sub-page's mount lifecycle.

// Web Share API feature-detect. Stubbable in tests. Guarded for the
// non-browser/jsdom path where `navigator.share` is absent.
function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

const ShareSessionModal: Component = () => {
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [expiresAt, setExpiresAt] = createSignal<Date | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [now, setNow] = createSignal(new Date());

  const close = (): void => closeShareModal();

  // Refcounted overlay scroll-lock + shared Esc-to-close, same wiring as the
  // other modals. onEscape MUST equal the ×/backdrop close verb.
  createOverlayLock(() => shareModalOpen(), ".share-modal", close);

  let tickId: ReturnType<typeof setInterval> | null = null;
  const stopTick = (): void => {
    if (tickId !== null) {
      clearInterval(tickId);
      tickId = null;
    }
  };
  const startTick = (): void => {
    if (tickId === null) tickId = setInterval(() => setNow(new Date()), 1_000);
  };
  onCleanup(stopTick);

  const mint = async (): Promise<void> => {
    const t = token();
    if (t === null) {
      setError("not_authenticated");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token: shareToken, expires_at } = await mintShareToken(t);
      // Bail if the modal closed DURING the POST: writing the token here
      // would re-populate the discarded state (a stale single-use token
      // flashing on the next reopen) AND start a countdown interval that
      // ticks while closed — exactly the leak the close-edge stopTick()
      // prevents. The once-mounted modal must guard this manually (the
      // #335 sub-page got it free by unmounting on close).
      if (!shareModalOpen()) return;
      // Plain path route — @solidjs/router v0.16 is path-mode; nginx try_files
      // falls back to the SPA so /share/<token> reaches ShareConsume.
      setShareUrl(`${window.location.origin}/share/${encodeURIComponent(shareToken)}`);
      setExpiresAt(new Date(expires_at));
      setNow(new Date());
      startTick();
    } catch (err) {
      setError(err instanceof Error ? err.message : "mint_failed");
    } finally {
      setBusy(false);
    }
  };

  // Mint on the OPEN edge — NOT at boot. The modal is mounted once and this
  // effect's first run sees the closed state (no fetch). Closing discards the
  // token + stops the countdown; re-opening mints fresh. No createResource /
  // onMount, so nothing fires until the user actually opens the modal.
  createEffect(
    on(shareModalOpen, (open) => {
      if (open) {
        // Fresh open: clear any prior render state so the "generating link…"
        // spinner shows alone (no stale QR/URL flash), then mint.
        setCopied(false);
        setError(null);
        setShareUrl(null);
        setExpiresAt(null);
        void mint();
      } else {
        stopTick();
        setShareUrl(null);
        setExpiresAt(null);
        setError(null);
        setBusy(false);
      }
    }),
  );

  const qrMarkup = createMemo(() => {
    const u = shareUrl();
    return u === null ? "" : qrSvg(u);
  });

  const copyToClipboard = async (): Promise<void> => {
    const url = shareUrl();
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard API can fail on insecure origins / denied perms — the URL
      // is still selectable in the input, copy it manually.
    }
  };

  // Native share sheet (Web Share API): the link goes out via email /
  // WhatsApp / etc. Rejections (user cancels) are expected and swallowed.
  const nativeShare = async (): Promise<void> => {
    const url = shareUrl();
    if (url === null) return;
    try {
      await navigator.share({
        title: "grappa session",
        text: "open this grappa session on another device",
        url,
      });
    } catch {
      // Cancelled or failed — the copy button remains as the fallback.
    }
  };

  const remainingSeconds = (): number => {
    const exp = expiresAt();
    if (exp === null) return 0;
    return Math.max(0, Math.floor((exp.getTime() - now().getTime()) / 1000));
  };

  const countdownText = (): string => {
    const s = remainingSeconds();
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  };

  return (
    <Show when={shareModalOpen()}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape) */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim */}
      <div class="modal-backdrop modal-backdrop-viewport share-modal-backdrop" onClick={close}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-modal-title"
          class="share-modal"
          data-testid="share-modal"
          onClick={(e) => e.stopPropagation()}
          tabIndex={-1}
        >
          <header class="share-modal-header">
            <h2 id="share-modal-title">{SHARE_SESSION_LABEL}</h2>
            <button
              type="button"
              class="modal-chrome-button share-modal-close"
              data-testid="share-modal-close"
              aria-label="close"
              onClick={close}
            >
              ×
            </button>
          </header>

          <Show when={busy()}>
            <p class="share-modal-busy" data-testid="share-busy">
              generating link…
            </p>
          </Show>

          <Show when={error() !== null}>
            <p class="share-modal-error" role="alert" data-testid="share-error">
              {error()}
            </p>
          </Show>

          <Show when={shareUrl() !== null}>
            <p class="share-modal-qr-heading">
              scan this code on another device to access your session
            </p>
            <div class="qr-frame" data-testid="share-qr" innerHTML={qrMarkup()} />

            <p class="share-modal-alt muted">alternatively, send yourself a link</p>
            <Show when={canNativeShare()}>
              <button
                type="button"
                class="share-modal-native"
                data-testid="share-native"
                onClick={() => {
                  void nativeShare();
                }}
              >
                send link…
              </button>
            </Show>
            <div class="share-modal-url-row">
              <input
                type="text"
                readonly
                class="share-modal-url"
                data-testid="share-url"
                value={shareUrl() ?? ""}
                onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
              />
              <button
                type="button"
                class="share-modal-copy"
                data-testid="share-copy"
                onClick={() => {
                  void copyToClipboard();
                }}
              >
                {copied() ? "copied!" : "copy"}
              </button>
            </div>

            <p class="share-modal-countdown" data-testid="share-countdown">
              expires in {countdownText()}
            </p>
            <p class="share-modal-note">single use — consumed on first open.</p>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default ShareSessionModal;
