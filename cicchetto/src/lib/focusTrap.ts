// issue 2375 — keep Tab inside an `aria-modal` dialog.
//
// `aria-modal="true"` tells assistive tech the page behind is inert; it does
// NOT stop the browser's own Tab traversal, which walks straight out of the
// dialog onto the covered page. In cic that is worse than a lost cursor: the
// irssi auto-focus (lib/keybindings) redirects any printable key that lands
// on a non-typing element into the compose box, so a Tab out of a modal and
// the next keystrokes end up in the composer BEHIND the scrim.
//
// Wrap-only: a Tab between two inner stops is left to the browser (its order
// is the DOM order, already right); only the two edges — Tab off the last
// stop, Shift+Tab off the first — are redirected, and a focus sitting outside
// the stop list (the dialog itself, `tabIndex=-1`) enters at the edge the
// direction points to.

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Bind as the dialog's `onKeyDown`; ignores every key but Tab. */
export function trapTabKey(e: KeyboardEvent, dialog: HTMLElement): void {
  if (e.key !== "Tab") return;
  const stops = Array.from(dialog.querySelectorAll<HTMLElement>(TABBABLE));
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) {
    e.preventDefault();
    return;
  }
  const at = stops.indexOf(document.activeElement as HTMLElement);
  if (e.shiftKey && at <= 0) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === -1 || at === stops.length - 1)) {
    e.preventDefault();
    first.focus();
  }
}
