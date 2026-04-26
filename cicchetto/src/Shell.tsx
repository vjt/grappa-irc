import { useNavigate } from "@solidjs/router";
import { type Component, createResource, Show } from "solid-js";
import { me } from "./lib/api";
import * as auth from "./lib/auth";

// Logged-in landing surface. Sub-tasks 4-5 turn this into the channel
// list + scrollback split-pane; for now it proves the auth round-trip
// — call /me with the bearer, show the user's name, give them a logout
// button.
//
// `createResource` is keyed on `auth.token` so a token change (logout,
// refresh) re-fetches /me without component remounts. Returning `null`
// from the source signal short-circuits the fetch — `RequireAuth`
// handles the redirect, but defending here keeps the resource state
// machine sane during the brief unauthenticated render before
// navigation completes.
const Shell: Component = () => {
  const navigate = useNavigate();
  const [user] = createResource(auth.token, async (token) => {
    if (token === null) return null;
    return me(token);
  });

  const handleLogout = async () => {
    await auth.logout();
    navigate("/login", { replace: true });
  };

  return (
    <main>
      <header class="shell-header">
        <Show when={user()} fallback={<span class="muted">loading…</span>}>
          {(u) => <span>logged in as {u().name}</span>}
        </Show>
        <button type="button" onClick={handleLogout}>
          log out
        </button>
      </header>
      <section class="shell">
        <h1>cicchetto</h1>
        <p class="muted">walking-skeleton — sub-tasks 4-7 wire channels, scrollback, compose.</p>
      </section>
    </main>
  );
};

export default Shell;
