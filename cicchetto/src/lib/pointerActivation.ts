// #925 — did the pointer come up inside the box it went down on? The one
// piece of geometry in a pointer-driven send activation, kept pure so the
// abort-by-sliding-off case is decidable without touch physics. Inclusive on
// all four edges: a release exactly on the boundary is a release on the
// control.
//
// issue 2429 — lifted out of ComposeBox, which had the only copy, because the
// services console's prompt grew the second send button. The rule is the
// same one, not a lookalike: a touch pointer is captured by the element the
// press landed on, so a release anywhere still targets the button, and
// sliding off to abort is the platform's cancel affordance for an
// irreversible action.
export function releasedInside(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
