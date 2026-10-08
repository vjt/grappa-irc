// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS } from "../lib/keepKeyboard";
import { HOLD_MOVE_TOLERANCE_PX } from "../lib/messageGestures";
import { bindNickLongPress } from "../lib/nickLongPress";
import { fireTouch } from "./helpers/touchEvents";

// issue 2346 — a hold on a nick opens the nick menu on a touch device. The
// binder adds no menu of its own: it delivers the `contextmenu` the nick's own
// handler already answers on desktop, which is what a long-press already is on
// Android and what iOS never sends. So these tests listen for that event on the
// nick, the same place the production handler sits.

let pane: HTMLDivElement;
let nick: HTMLButtonElement;
let plain: HTMLSpanElement;
let menus: MouseEvent[];
let dispose: () => void;

const AT = { clientX: 120, clientY: 340 };

beforeEach(() => {
  vi.useFakeTimers();
  pane = document.createElement("div");
  nick = document.createElement("button");
  nick.className = "nick-clickable";
  const inner = document.createElement("span"); // NickText renders inside
  inner.textContent = "Guest123";
  nick.appendChild(inner);
  plain = document.createElement("span");
  plain.textContent = "has quit";
  pane.append(nick, plain);
  document.body.appendChild(pane);
  menus = [];
  nick.addEventListener("contextmenu", (e) => menus.push(e));
  dispose = bindNickLongPress(pane, ".nick-clickable");
});

afterEach(() => {
  dispose();
  pane.remove();
  vi.useRealTimers();
});

describe("bindNickLongPress", () => {
  it("a hold on the nick delivers contextmenu to it, at the touch point", () => {
    fireTouch(nick.firstElementChild as HTMLElement, "touchstart", AT);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(1);
    expect(menus[0]?.clientX).toBe(AT.clientX);
    expect(menus[0]?.clientY).toBe(AT.clientY);
    expect(menus[0]?.bubbles).toBe(true);
  });

  it("swallows the release after a hold, so no click opens the query under the menu", () => {
    fireTouch(nick, "touchstart", AT);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const end = fireTouch(nick, "touchend", AT);
    expect(end.defaultPrevented).toBe(true);
  });

  it("a short tap stays a tap: no menu, and the release is left alone", () => {
    fireTouch(nick, "touchstart", AT);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    const end = fireTouch(nick, "touchend", AT);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
    expect(end.defaultPrevented).toBe(false);
  });

  it("a finger that moves past the tolerance is a scroll, not a press", () => {
    fireTouch(nick, "touchstart", AT);
    fireTouch(nick, "touchmove", {
      clientX: AT.clientX,
      clientY: AT.clientY + HOLD_MOVE_TOLERANCE_PX + 1,
    });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
  });

  it("a hold off any nick does nothing", () => {
    fireTouch(plain, "touchstart", AT);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
  });

  it("stands down when the platform sends its own contextmenu mid-hold (Android)", () => {
    fireTouch(nick, "touchstart", AT);
    nick.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    // The platform's one, and not a second from us.
    expect(menus).toHaveLength(1);
  });

  it("a second finger is a pinch, not a press", () => {
    fireTouch(nick, "touchstart", AT, { clientX: 200, clientY: 340 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
  });

  it("disposing drops a pending hold", () => {
    fireTouch(nick, "touchstart", AT);
    dispose();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
  });
});
