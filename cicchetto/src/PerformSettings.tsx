import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { getPerform, type Network, putPerform } from "./lib/api";
import { token } from "./lib/auth";
import { friendlyError } from "./lib/friendlyError";
import { networks } from "./lib/networks";

// #189 — per-network ON-CONNECT PERFORM LIST sub-page. One block per network
// (mirrors WatchlistsSettings' PresenceNetworkBlock), each loading + saving
// its own list via GET/PUT /networks/:slug/perform.
//
// The list is RAW IRC lines, run SERVER-side at 001 BEFORE the built-in
// NickServ identify and before autojoin — NOT cic slash-commands and NOT
// #385 aliases (the server has no slash interpreter; that's #288, out of
// scope). The help blurb states this plainly so the honesty is in the UI,
// not just the issue. `$nickserv_pass` / `$oper_pass` keep secrets out of
// the text; #885's `$nick` is NOT a secret — it expands to the credential's
// configured nick (not the live one), which is what makes an identify still
// name the account after a collision parked the session on an alt nick. Both passwords are WRITE-ONLY: the server returns only whether each
// is set, never the value; the inputs are leave-blank-to-keep, exactly like a
// password field (mirrors AdminCredentialsTab's edit form). #509 gave
// `$nickserv_pass` its own field, decoupled from auth_method, so it works even
// when the credential's password is spent on PASS (server-password/hostmasking).

const PerformNetworkBlock: Component<{ net: Network }> = (props) => {
  const [listDraft, setListDraft] = createSignal("");
  const [operDraft, setOperDraft] = createSignal("");
  const [operSet, setOperSet] = createSignal(false);
  const [nickservDraft, setNickservDraft] = createSignal("");
  const [nickservSet, setNickservSet] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // No server broadcast for the perform list — load it on open.
  onMount(() => {
    const t = token();
    if (!t) return;
    void getPerform(t, props.net.slug)
      .then((view) => {
        setListDraft(view.perform_list ?? "");
        setOperSet(view.oper_pass_set);
        setNickservSet(view.nickserv_pass_set);
      })
      .catch((err) => setError(friendlyError(err)));
  });

  const onSave = async (e: Event) => {
    e.preventDefault();
    const t = token();
    if (!t || busy()) return;
    setError(null);
    setBusy(true);
    try {
      const body: { perform_list?: string; oper_pass?: string; nickserv_pass?: string } = {
        perform_list: listDraft(),
      };
      // Leave-blank-to-keep: only send a secret when the user typed one, so
      // saving the list alone never disturbs the stored secrets.
      const oper = operDraft();
      if (oper !== "") body.oper_pass = oper;
      const nickserv = nickservDraft();
      if (nickserv !== "") body.nickserv_pass = nickserv;

      const view = await putPerform(t, props.net.slug, body);
      setListDraft(view.perform_list ?? "");
      setOperSet(view.oper_pass_set);
      setOperDraft("");
      setNickservSet(view.nickserv_pass_set);
      setNickservDraft("");
      setSaved(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="watchlists-network" data-testid={`perform-net-${props.net.slug}`}>
      <h5 class="watchlists-network-slug">{props.net.slug}</h5>
      <form onSubmit={(e) => void onSave(e)}>
        <textarea
          class="perform-textarea"
          autocapitalize="none"
          autocorrect="off"
          spellcheck={false}
          placeholder={"# raw IRC lines, one per line\nPRIVMSG NickServ :IDENTIFY $nickserv_pass"}
          value={listDraft()}
          data-testid={`perform-list-${props.net.slug}`}
          onInput={(e) => {
            setListDraft(e.currentTarget.value);
            setSaved(false);
          }}
        />
        <div class="perform-secret">
          <input
            type="password"
            class="perform-secret-input"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            placeholder="new nickserv password (leave blank to keep)"
            value={nickservDraft()}
            data-testid={`perform-nickserv-${props.net.slug}`}
            onInput={(e) => {
              setNickservDraft(e.currentTarget.value);
              setSaved(false);
            }}
          />
          <span
            class="perform-secret-status"
            data-testid={`perform-nickserv-status-${props.net.slug}`}
          >
            {nickservSet() ? "nickserv pass: set" : "nickserv pass: not set"}
          </span>
        </div>
        <div class="perform-secret">
          <input
            type="password"
            class="perform-secret-input"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            placeholder="new oper password (leave blank to keep)"
            value={operDraft()}
            data-testid={`perform-oper-${props.net.slug}`}
            onInput={(e) => {
              setOperDraft(e.currentTarget.value);
              setSaved(false);
            }}
          />
          <span class="perform-secret-status" data-testid={`perform-oper-status-${props.net.slug}`}>
            {operSet() ? "oper pass: set" : "oper pass: not set"}
          </span>
        </div>
        <button
          type="submit"
          class="watchlists-add-btn perform-save"
          disabled={busy()}
          data-testid={`perform-save-${props.net.slug}`}
        >
          save
        </button>
      </form>
      <Show when={saved()}>
        <p class="perform-secret-status" data-testid={`perform-saved-${props.net.slug}`}>
          saved
        </p>
      </Show>
      <Show when={error()}>
        {(msg) => (
          <p class="watchlists-error" data-testid={`perform-error-${props.net.slug}`}>
            {msg()}
          </p>
        )}
      </Show>
    </div>
  );
};

const PerformSettings: Component<{ onBack: () => void }> = (props) => {
  return (
    <section class="settings-subpage perform-subpage" data-testid="perform-subpage">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="perform-back"
          aria-label="back to settings"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>on-connect commands</h3>
      </header>

      <div class="settings-section" data-testid="perform-section">
        <p class="settings-section-blurb">
          Commands run automatically each time you connect, one <strong>raw IRC line</strong> per
          line, BEFORE channels are joined. These are <strong>not</strong> slash-commands or aliases
          — <code>/msg</code>, <code>/join</code> and <code>/alias</code> expansions do NOT work
          here. Write the wire command itself:{" "}
          <code>PRIVMSG NickServ :IDENTIFY $nickserv_pass</code>,{" "}
          <code>OPER myname $oper_pass</code>, <code>MODE $nick +x</code>. Use{" "}
          <code>$nickserv_pass</code> and <code>$oper_pass</code> so passwords stay out of the text
          — each expands from its own write-only field below (leave blank to keep the stored value).{" "}
          <code>$nickserv_pass</code> works on any network, including one whose password is already
          spent on the server password. <code>$nick</code> expands to your{" "}
          <strong>configured</strong> nick — not the one you happen to be wearing — so{" "}
          <code>NS IDENTIFY $nick $nickserv_pass</code> still names your account after a nick
          collision parked you on an alt nick. Lines starting with <code>#</code> are comments.
        </p>
        <Show
          when={(networks() ?? []).length > 0}
          fallback={<p class="watchlists-empty">no networks yet.</p>}
        >
          <For each={networks() ?? []}>{(net) => <PerformNetworkBlock net={net} />}</For>
        </Show>
      </div>
    </section>
  );
};

export default PerformSettings;
