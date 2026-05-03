export type CaptchaProvider = "turnstile" | "hcaptcha";

const SCRIPT_URLS: Record<CaptchaProvider, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/api.js",
  hcaptcha: "https://js.hcaptcha.com/1/api.js",
};

type WidgetGlobal = {
  render: (
    container: HTMLElement,
    opts: { sitekey: string; callback: (token: string) => void },
  ) => string;
  remove: (id: string) => void;
};

export async function mountCaptchaWidget(
  provider: CaptchaProvider,
  container: HTMLElement,
  siteKey: string,
  onSolve: (token: string) => void,
): Promise<() => void> {
  await loadScript(SCRIPT_URLS[provider]);
  const widget = (window as unknown as Record<string, WidgetGlobal | undefined>)[provider];
  if (widget === undefined) throw new Error(`captcha provider ${provider} not loaded`);
  const id = widget.render(container, { sitekey: siteKey, callback: onSolve });
  return () => widget.remove(id);
}

async function loadScript(url: string): Promise<void> {
  if (document.querySelector(`script[src="${url}"]`) !== null) return;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}
