import { type Component, type JSX, Show } from "solid-js";
import { isAdminNarrow } from "../lib/theme";

// Admin redesign (2026-08-07 review) — a table row's identity cell.
//
// On a phone it is the door to the row's detail panel, because the table
// has dropped its secondary columns at that width and this is how they
// come back. On desktop every column is already on screen, so there is
// nothing to open and the name is plain text — a control that reveals
// what you can already see is a control that teaches the operator to
// distrust controls.
//
// The caret is the same `▸ / ▾` the Networks slug expander has used
// since M-10, so the affordance is one the operator has already met in
// this pane rather than a second convention.
//
// #1157 — that "nothing to open on desktop" reasoning is a statement
// about a table that drops columns only below 900px, which is still
// true of Networks, Credentials and Vhosts. The unified Sessions view
// is not one of those: it carries four columns at EVERY width and keeps
// the rest of the record in the panel, so there the disclosure is the
// only door to it and `alwaysOpenable` keeps it on at all widths.
//
// #1223 — and "below 900px" is what the gate now asks. It used to ask
// `isMobile()`, which is 768px: in the 769-899 band the table had
// already dropped its columns into a panel this rendered no door to.
// The door has to open wherever the columns leave, so both read the
// SAME breakpoint (`isAdminNarrow`).

export type Props = {
  /** The row's name, e.g. `vjt @ azzurra`. */
  children: JSX.Element;
  open: boolean;
  onToggle: () => void;
  /** Accessible name for the disclosure, e.g. `details for vjt`. */
  label: string;
  testId?: string;
  /** Render the disclosure at every width, not just on a phone. For a
   * table whose panel holds fields no breakpoint puts back on screen. */
  alwaysOpenable?: boolean;
};

const AdminRowName: Component<Props> = (props) => (
  <Show
    when={props.alwaysOpenable === true || isAdminNarrow()}
    fallback={<span class="adm-row-name">{props.children}</span>}
  >
    <button
      type="button"
      class="adm-row-expand"
      aria-expanded={props.open}
      aria-label={props.label}
      onClick={props.onToggle}
      data-testid={props.testId}
    >
      <span aria-hidden="true">{props.open ? "▾" : "▸"}</span>
      {props.children}
    </button>
  </Show>
);

export default AdminRowName;
