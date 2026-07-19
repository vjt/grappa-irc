import { type Component, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { mintShareToken } from "./lib/api";
import { token } from "./lib/auth";

// #335 — visitor session-sharing as an in-panel SUB-PAGE (was a modal).
//
// #335 converts the old `ShareSessionModal` into a settings sub-page that
// behaves like the vhost / themes sub-pages: the drawer's "share session"
// section-button pushes into it (setSettingsPage("share")), and it reports
// "back" via `onBack` (setSettingsPage("main")) — no Esc/backdrop, the
// back button is the single close door (consistent with vhost/themes).
//
// Because the drawer renders this behind `<Show when={settingsPage() ===
// "share"}>`, the component MOUNTS fresh on every entry — so the mint is a
// plain `onMount`, not the modal's open-transition effect. Leaving the
// section unmounts it, discarding the URL (a token left on screen is
// leaked to anyone watching); re-entering mints a fresh one.
//
// Flow:
//   1. onMount → POST /me/share-token (mintShareToken) → {token, expires_at}.
//   2. Build `${origin}/share/<token>` (plain path route — @solidjs/router
//      v0.16 is path-mode; nginx try_files falls back to the SPA so
//      /share/<token> reaches ShareConsume).
//   3. Render URL + copy-to-clipboard + a live countdown + a native-share
//      button (Web Share API) that falls back to hidden where unsupported.
//
// Server guarantees (unchanged from the modal): visitor-only (403 for
// users — the drawer already gates the entry on isVisitor()), single-use
// (a second consume returns 410 share_token_consumed).

export type Props = {
  onBack: () => void;
};

// Web Share API feature-detect. Stubbable in tests via addInitScript
// (Object.defineProperty(navigator, "share", …)). Guarded for the
// non-browser/jsdom path where `navigator.share` is absent.
function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

const ShareSessionPage: Component<Props> = (props) => {
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [expiresAt, setExpiresAt] = createSignal<Date | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [now, setNow] = createSignal(new Date());

  const mint = async () => {
    const t = token();
    if (t === null) {
      setError("not_authenticated");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token: shareToken, expires_at } = await mintShareToken(t);
      const url = `${window.location.origin}/share/${encodeURIComponent(shareToken)}`;
      setShareUrl(url);
      setExpiresAt(new Date(expires_at));
    } catch (err) {
      setError(err instanceof Error ? err.message : "mint_failed");
    } finally {
      setBusy(false);
    }
  };

  onMount(() => {
    void mint();
  });

  // 1s tick driving the countdown text; starts once a token is live.
  let tickId: ReturnType<typeof setInterval> | null = null;
  createEffect(() => {
    if (shareUrl() !== null && tickId === null) {
      tickId = setInterval(() => setNow(new Date()), 1_000);
    }
  });
  onCleanup(() => {
    if (tickId !== null) clearInterval(tickId);
  });

  const copyToClipboard = async () => {
    const url = shareUrl();
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard API can fail on insecure origins / denied perms — the
      // URL is still selectable in the input, copy it manually.
    }
  };

  // Native share sheet (Web Share API) — the #335 mobile affordance so the
  // link goes out via email / WhatsApp / etc. Rejections (user cancels, or
  // the share is dismissed) are expected and swallowed.
  const nativeShare = async () => {
    const url = shareUrl();
    if (url === null) return;
    try {
      await navigator.share({
        title: "grappa session",
        text: "open this grappa session on this device",
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
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  };

  return (
    <section class="settings-subpage share-subpage" data-testid="share-subpage">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="share-back"
          aria-label="back to settings"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>share session</h3>
      </header>

      <p class="share-subpage-help">
        send this link to yourself — open it on another device to access this same session.
      </p>

      <Show when={busy()}>
        <p class="share-subpage-busy" data-testid="share-busy">
          generating link…
        </p>
      </Show>

      <Show when={error() !== null}>
        <p class="share-subpage-error" role="alert" data-testid="share-error">
          {error()}
        </p>
      </Show>

      <Show when={shareUrl() !== null}>
        <div class="share-subpage-url-row">
          <input
            type="text"
            readonly
            class="share-subpage-url"
            data-testid="share-url"
            value={shareUrl() ?? ""}
            onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
          />
          <button
            type="button"
            class="share-subpage-copy"
            data-testid="share-copy"
            onClick={() => {
              void copyToClipboard();
            }}
          >
            {copied() ? "copied!" : "copy"}
          </button>
        </div>

        <Show when={canNativeShare()}>
          <button
            type="button"
            class="share-subpage-native"
            data-testid="share-native"
            onClick={() => {
              void nativeShare();
            }}
          >
            share via…
          </button>
        </Show>

        <p class="share-subpage-countdown" data-testid="share-countdown">
          expires in {countdownText()}
        </p>
        <p class="share-subpage-note">single use — consumed on first open.</p>
      </Show>
    </section>
  );
};

export default ShareSessionPage;
