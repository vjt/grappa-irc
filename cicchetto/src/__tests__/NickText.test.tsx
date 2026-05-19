import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { nickColorIndex } from "../lib/nickColor";
import NickText from "../NickText";

// UX-5 bucket BC2 — render-side contract for the colored-nick + irssi
// mode-prefix helper component. jsdom doesn't evaluate `var(--*)` so
// these tests assert on the literal `var(--nick-color-N)` string AND
// the structural shape (prefix span vs. nick-text span); the live
// CSS-cascade contract belongs to the Playwright e2e (cic-only buckets
// CSS-cascade-blind rule per `feedback_cicchetto_browser_smoke`).

describe("NickText", () => {
  it("renders the nick text in a `.nick-text` span with the deterministic var() color", () => {
    const { container } = render(() => <NickText nick="vjt" />);
    const text = container.querySelector(".nick-text") as HTMLElement | null;
    expect(text).not.toBeNull();
    expect(text?.textContent).toBe("vjt");
    const expected = `var(--nick-color-${nickColorIndex("vjt")})`;
    expect(text?.style.color).toBe(expected);
  });

  it("agrees on the inline color across case variants (Vjt === vjt === VJT)", () => {
    const a = render(() => <NickText nick="vjt" />);
    const b = render(() => <NickText nick="Vjt" />);
    const c = render(() => <NickText nick="VJT" />);
    const colorA = (a.container.querySelector(".nick-text") as HTMLElement).style.color;
    const colorB = (b.container.querySelector(".nick-text") as HTMLElement).style.color;
    const colorC = (c.container.querySelector(".nick-text") as HTMLElement).style.color;
    expect(colorB).toBe(colorA);
    expect(colorC).toBe(colorA);
  });

  it("omits the prefix span entirely when prefix is empty / not provided", () => {
    const { container } = render(() => <NickText nick="vjt" />);
    expect(container.querySelector(".nick-prefix")).toBeNull();
  });

  it("renders the @ prefix in a `.nick-prefix.nick-prefix-op` span when prefix='@'", () => {
    const { container } = render(() => <NickText nick="vjt" prefix="@" />);
    const prefix = container.querySelector(".nick-prefix") as HTMLElement | null;
    expect(prefix).not.toBeNull();
    expect(prefix?.classList.contains("nick-prefix-op")).toBe(true);
    expect(prefix?.textContent).toBe("@");
  });

  it("renders the % prefix as halfop class", () => {
    const { container } = render(() => <NickText nick="vjt" prefix="%" />);
    const prefix = container.querySelector(".nick-prefix") as HTMLElement | null;
    expect(prefix?.classList.contains("nick-prefix-halfop")).toBe(true);
    expect(prefix?.textContent).toBe("%");
  });

  it("renders the + prefix as voiced class", () => {
    const { container } = render(() => <NickText nick="vjt" prefix="+" />);
    const prefix = container.querySelector(".nick-prefix") as HTMLElement | null;
    expect(prefix?.classList.contains("nick-prefix-voiced")).toBe(true);
    expect(prefix?.textContent).toBe("+");
  });

  it("adds `extraClass` to the outer .nick container without dropping the baseline class", () => {
    const { container } = render(() => <NickText nick="vjt" extraClass="whois-card-target" />);
    const outer = container.querySelector(".nick") as HTMLElement | null;
    expect(outer).not.toBeNull();
    expect(outer?.classList.contains("whois-card-target")).toBe(true);
    expect(outer?.classList.contains("nick")).toBe(true);
  });

  it("flows prefix + nick as one inline unit (textContent contains '@vjt')", () => {
    const { container } = render(() => <NickText nick="vjt" prefix="@" />);
    const outer = container.querySelector(".nick") as HTMLElement | null;
    expect(outer?.textContent).toBe("@vjt");
  });
});
