import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Dev-only proxy: vite serves the SolidJS app on :5173 and forwards the
// REST + Channels surfaces to grappa on :4000. In prod, sub-task 6's
// nginx service handles the same routing — keeping the dev proxy
// shape identical means the same `/auth/login` fetch path works in
// both environments without env-var-driven base URLs.
//
// `host.docker.internal` resolves to the host gateway from inside the
// oven/bun container; on Linux Docker this requires the
// `host.docker.internal:host-gateway` extra-host (added implicitly by
// recent docker-cli versions, or wire it through if scripts/bun.sh
// gains a compose-managed run). The grappa Phoenix endpoint exposes
// :4000 on the host via `compose.yaml`, so the proxy hits the live
// backend without leaving Bandit.
//
// `ws: true` is mandatory on the /socket entry — Phoenix Channels rides
// a WebSocket upgrade and vite's default proxy is HTTP-only.
export default defineConfig({
  plugins: [solid()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/auth": "http://host.docker.internal:4000",
      "/me": "http://host.docker.internal:4000",
      "/networks": "http://host.docker.internal:4000",
      "/socket": {
        target: "http://host.docker.internal:4000",
        ws: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
