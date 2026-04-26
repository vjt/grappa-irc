import { Route, Router, useNavigate } from "@solidjs/router";
import { type Component, createEffect, type JSX } from "solid-js";
import { render } from "solid-js/web";
import Login from "./Login";
import { isAuthenticated } from "./lib/auth";
import Shell from "./Shell";
import "./themes/default.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found in index.html");

// `RequireAuth` reads `isAuthenticated()` reactively and bounces to
// /login when the token signal goes null. `createEffect` re-runs on every
// signal change, so explicit logouts and 401-driven token clears both
// flow through the same redirect path — no special-case after-logout
// handling needed in the components that drop the token.
const RequireAuth: Component<{ children: JSX.Element }> = (props) => {
  const navigate = useNavigate();
  createEffect(() => {
    if (!isAuthenticated()) navigate("/login", { replace: true });
  });
  return <>{props.children}</>;
};

render(
  () => (
    <Router>
      <Route path="/login" component={Login} />
      <Route
        path="/"
        component={() => (
          <RequireAuth>
            <Shell />
          </RequireAuth>
        )}
      />
    </Router>
  ),
  root,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("SW register failed", err);
    });
  });
}
