import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import Shell from "./Shell";
import "./themes/default.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found in index.html");

render(
  () => (
    <Router>
      <Route path="/" component={Shell} />
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
