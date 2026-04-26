import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// SolidJS components compile to fine-grained reactive primitives — vitest
// needs the same `vite-plugin-solid` transform the dev server uses, or
// JSX in tests is parsed as plain React and signal updates don't fire.
//
// `environment: "jsdom"` gives DOM globals (document, localStorage,
// fetch shim via undici) so component tests + the auth signal store
// (which side-effects to localStorage) run unmodified. `setupTests.ts`
// installs jest-dom matchers.
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
