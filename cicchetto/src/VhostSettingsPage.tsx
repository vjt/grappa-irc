import { type Component, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import type { VhostOption, VhostSettingsView } from "./lib/userSettings";

// #252 — the vhost (source address) settings SUB-PAGE.
//
// Pure presentational widget: the SERVER owns the allow-set + the current
// selection (cic never originates state). Props in, `onSetSelection` out —
// the drawer PUTs and feeds the refreshed view back down.
//
//   * "customize your vhost" toggle — OFF (the default, = empty selection):
//     the vhost is random-from-pool; show a message + the pool read-only.
//     ON: reveal the three tap-select sections. Turning OFF resets the
//     selection to [] (PUT empty → back to random).
//   * three sections, bucketed from the #251 `granted` marker + `in_pool`:
//     exclusive to you (granted) / in pool (in_pool && !granted) / out of
//     pool (!in_pool && !granted). The exclusive section (and any empty
//     section) is hidden.
//   * each option is a `.mode-modal-toggle` button (reused from the
//     umode/chanmode modal): the NAME is the bold primary label, the /128
//     a muted subline (omitted when the name IS the raw IP — no PTR / cold).
//     Tap toggles membership → immediate PUT.

export type Props = {
  view: VhostSettingsView | null;
  error: string | null;
  onSetSelection: (addresses: string[]) => void;
  onBack: () => void;
  // #282 — the vhost is INERT until the upstream reconnects (source-bind
  // resolves per connect), so the sub-page carries an explicit sticky
  // "Reconnect to apply" footer button (the drawer owns the reconnect
  // orchestration → `reconnectConnectedNetworks`). The button is ALWAYS
  // available on-demand — deliberately NOT gated on pending-detection
  // (unreliable client-side; hiding a heavyweight externally-visible action
  // behind detection violates least-astonishment). It fires through a
  // two-tap `InlineConfirmButton` arm — the SAME confirm gate the drawer's
  // other disruptive reconnect/teardown actions use (`quit`, visitor "apply
  // identity") — so a single stray tap can't drop + rejoin every network. An
  // arm is not a disable and not a pending-gate, so this preserves the
  // always-available contract. `reconnecting` relabels the idle button while
  // the bounce is in flight (the drawer's own guard blocks re-fire);
  // `reconnectError` surfaces a failure inline.
  onReconnect: () => void;
  reconnecting: boolean;
  reconnectError: string | null;
};

const VhostSettingsPage: Component<Props> = (props) => {
  // Customize toggle state. `null` = derive from the server view (a
  // non-empty selection means the user has customized ⇒ ON); a boolean is
  // an explicit user override (so ON can reveal the sections before any
  // address is picked, and OFF survives the reset-to-[] round-trip).
  const [override, setOverride] = createSignal<boolean | null>(null);
  // #282 — local two-tap arm for the Reconnect footer button. The sub-page
  // unmounts on ‹ back (it's a `<Show>` branch in SettingsDrawer), so this
  // ephemeral flag auto-resets on leave — no drawer-side disarm needed
  // (unlike the always-mounted `quitArmed`/`identityArmed`).
  const [reconnectArmed, setReconnectArmed] = createSignal(false);
  const customizeOn = (): boolean => {
    const o = override();
    if (o !== null) return o;
    return (props.view?.selection.length ?? 0) > 0;
  };

  const available = (): VhostOption[] => props.view?.available ?? [];
  const selection = (): string[] => props.view?.selection ?? [];
  const isSelected = (address: string): boolean => selection().includes(address);

  const exclusive = createMemo(() => available().filter((o) => o.granted));
  const inPool = createMemo(() => available().filter((o) => o.in_pool && !o.granted));
  const outOfPool = createMemo(() => available().filter((o) => !o.in_pool && !o.granted));
  const poolReadonly = createMemo(() => available().filter((o) => o.in_pool));

  const onToggleCustomize = (): void => {
    if (customizeOn()) {
      // Turning OFF → reset to random-from-pool.
      setOverride(false);
      props.onSetSelection([]);
    } else {
      setOverride(true);
    }
  };

  const toggleMembership = (address: string): void => {
    const cur = selection();
    const next = cur.includes(address) ? cur.filter((a) => a !== address) : [...cur, address];
    props.onSetSelection(next);
  };

  const optionButton = (o: VhostOption): JSX.Element => (
    <button
      type="button"
      class="mode-modal-toggle vhost-option"
      classList={{ "mode-modal-toggle-active": isSelected(o.address) }}
      aria-pressed={isSelected(o.address)}
      data-testid={`vhost-option-${o.address}`}
      onClick={() => toggleMembership(o.address)}
    >
      <span class="mode-modal-toggle-flag" aria-hidden="true">
        {isSelected(o.address) ? "✓" : ""}
      </span>
      <span class="mode-modal-toggle-label" title={o.name}>
        {o.name}
      </span>
      {/* Muted /128 subline — omitted when the name IS the raw IP (no PTR
          record / cold cache) so we don't render the address twice. */}
      <Show when={o.name !== o.address}>
        <span class="mode-modal-toggle-desc">{o.address}</span>
      </Show>
    </button>
  );

  // `opts` is the memo ACCESSOR (not a snapshot) so `<Show>`/`<For>` track
  // it — the section reacts to a live view update (a tap flips selection;
  // a grant/revoke changes the bucket) instead of freezing at mount.
  const section = (testid: string, heading: string, opts: () => VhostOption[]): JSX.Element => (
    <Show when={opts().length > 0}>
      <section class="vhost-section" data-testid={testid}>
        <h4 class="vhost-section-heading">{heading}</h4>
        <div class="vhost-section-list">
          <For each={opts()}>{optionButton}</For>
        </div>
      </section>
    </Show>
  );

  return (
    <section class="settings-subpage vhost-subpage" data-testid="vhost-subpage">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="vhost-back"
          aria-label="back to settings"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>source address (vhost)</h3>
      </header>

      <label class="vhost-customize-row">
        <input
          type="checkbox"
          data-testid="vhost-customize-toggle"
          checked={customizeOn()}
          onChange={onToggleCustomize}
        />
        customize your vhost
      </label>

      <Show
        when={customizeOn()}
        fallback={
          <div class="vhost-random">
            <p class="vhost-random-msg" data-testid="vhost-random-msg">
              your vhost is chosen randomly on connection from this pool
            </p>
            <ul class="vhost-pool-readonly" data-testid="vhost-pool-readonly">
              <For each={poolReadonly()}>
                {(o) => (
                  <li class="vhost-readonly-item">
                    <span class="vhost-readonly-name" title={o.name}>
                      {o.name}
                    </span>
                    <Show when={o.name !== o.address}>
                      <span class="vhost-readonly-addr">{o.address}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        }
      >
        <div class="vhost-sections">
          {section("vhost-section-exclusive", "exclusive to you", exclusive)}
          {section("vhost-section-in-pool", "in pool", inPool)}
          {section("vhost-section-out-of-pool", "out of pool", outOfPool)}
        </div>
      </Show>

      <Show when={props.error !== null}>
        <p class="vhost-error" role="alert" data-testid="vhost-error">
          {props.error}
        </p>
      </Show>

      {/* #282 — sticky "Reconnect to apply" footer. Single instance at the
          bottom of the list (no top+bottom duplication — a duplicated
          disruptive action invites accidental double-fire). Always
          available; the drawer's onReconnect bounces the connected
          networks so the new source address binds on the fresh upstream. */}
      <footer class="vhost-reconnect-footer">
        <InlineConfirmButton
          idleLabel={props.reconnecting ? "Reconnecting…" : "Reconnect to apply"}
          confirmLabel="reconnect now (drops + rejoins)"
          testId="vhost-reconnect"
          extraClass="vhost-reconnect"
          armed={reconnectArmed()}
          onArm={() => setReconnectArmed(true)}
          onConfirm={() => {
            setReconnectArmed(false);
            props.onReconnect();
          }}
        />
        <p class="vhost-reconnect-hint">
          your source address takes effect on reconnect — you'll briefly drop and rejoin your
          channels
        </p>
        <Show when={props.reconnectError !== null}>
          <p class="vhost-reconnect-error" role="alert" data-testid="vhost-reconnect-error">
            {props.reconnectError}
          </p>
        </Show>
      </footer>
    </section>
  );
};

export default VhostSettingsPage;
