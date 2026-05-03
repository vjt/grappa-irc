import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mountCaptchaWidget } from "../lib/captcha";

describe("mountCaptchaWidget", () => {
  let renderMock: ReturnType<typeof vi.fn>;
  let removeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    renderMock = vi.fn(() => "widget-1");
    removeMock = vi.fn();
    (window as unknown as Record<string, unknown>).turnstile = {
      render: renderMock,
      remove: removeMock,
    };
    (window as unknown as Record<string, unknown>).hcaptcha = {
      render: renderMock,
      remove: removeMock,
    };
    for (const url of [
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
      "https://js.hcaptcha.com/1/api.js",
    ]) {
      const s = document.createElement("script");
      s.src = url;
      document.head.appendChild(s);
    }
  });

  afterEach(() => {
    for (const s of document.head.querySelectorAll("script")) s.remove();
    delete (window as unknown as Record<string, unknown>).turnstile;
    delete (window as unknown as Record<string, unknown>).hcaptcha;
  });

  test("turnstile mounts via window.turnstile.render with sitekey + callback", async () => {
    const onSolve = vi.fn();
    const container = document.createElement("div");
    await mountCaptchaWidget("turnstile", container, "test-key", onSolve);
    expect(renderMock).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ sitekey: "test-key", callback: onSolve }),
    );
  });

  test("hcaptcha mounts via window.hcaptcha.render", async () => {
    const onSolve = vi.fn();
    const container = document.createElement("div");
    await mountCaptchaWidget("hcaptcha", container, "uuid-key", onSolve);
    expect(renderMock).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ sitekey: "uuid-key", callback: onSolve }),
    );
  });

  test("cleanup function calls widget.remove with returned id", async () => {
    const cleanup = await mountCaptchaWidget(
      "turnstile",
      document.createElement("div"),
      "k",
      () => undefined,
    );
    cleanup();
    expect(removeMock).toHaveBeenCalledWith("widget-1");
  });
});
