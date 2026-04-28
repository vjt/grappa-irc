import { useNavigate } from "@solidjs/router";
import { type Component, createSignal } from "solid-js";
import { logout } from "./lib/auth";
import { getTheme, setTheme, type ThemePref } from "./lib/theme";

// Right-overlay drawer: theme toggle (auto/mIRC/irssi radios) +
// logout button. Backdrop click fires onClose; Esc is handled in
// Shell.tsx via keybindings.
//
// open prop drives the .open class on both backdrop + aside; the
// stylesheet animates the transform and pointer-events. The drawer
// stays mounted at all times — no enter/exit unmount thrashing.

export type Props = {
  open: boolean;
  onClose: () => void;
};

const SettingsDrawer: Component<Props> = (props) => {
  const navigate = useNavigate();
  const [pref, setPref] = createSignal<ThemePref>(getTheme());

  const onChange = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value as ThemePref;
    setPref(value);
    setTheme(value);
  };

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <>
      <div
        class="settings-drawer-backdrop"
        classList={{ open: props.open }}
        onClick={props.onClose}
        aria-hidden="true"
        data-testid="settings-drawer-backdrop"
      />
      <aside
        class="settings-drawer"
        classList={{ open: props.open }}
        role="dialog"
        aria-label="settings"
      >
        <h2>settings</h2>
        <fieldset>
          <legend>theme</legend>
          <label>
            <input
              type="radio"
              name="theme"
              value="auto"
              checked={pref() === "auto"}
              onChange={onChange}
            />
            auto (follow system)
          </label>
          <label>
            <input
              type="radio"
              name="theme"
              value="mirc-light"
              checked={pref() === "mirc-light"}
              onChange={onChange}
            />
            mIRC light
          </label>
          <label>
            <input
              type="radio"
              name="theme"
              value="irssi-dark"
              checked={pref() === "irssi-dark"}
              onChange={onChange}
            />
            irssi dark
          </label>
        </fieldset>
        <button
          type="button"
          class="logout"
          onClick={() => {
            void onLogout();
          }}
        >
          log out
        </button>
      </aside>
    </>
  );
};

export default SettingsDrawer;
