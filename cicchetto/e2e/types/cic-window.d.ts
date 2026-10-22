// The ONE declaration of cic's page-side e2e/devtools probe surface.
//
// Before #484 each spec that touched a probe re-declared it inline in its own
// `declare global` block. Five copies of `__cic_socketHealth` and two of
// `__cic_bundleHash` had drifted into mutually incompatible shapes (TS2717 ×5),
// and the widest of them was still narrower than the real surface. Convergence
// here is on ONE shape, not on N compatible ones.
//
// SSOT is the production code — these are hand-mirrored from:
//   src/lib/socketHealth.ts     __cic_socketHealth
//   src/lib/bundleHash.ts       __cic_bundleHash
//   src/lib/swRegistration.ts   __cic_swRegistration
//   src/lib/socket.ts           __cic_dropSocketForTests, __cic_resumeSocketForTests,
//                               __visibilityAck
//   src/lib/subscribe.ts        __cic_{suppress,resume}ChannelDeliveryForTests,
//                               __cic_joinedTopicKeys
// The mirror is hand-kept: `e2e/tsconfig.json` cannot import from `src/` (those
// modules pull in solid-js, which e2e/node_modules does not have). A probe that
// changes shape in `src/` must be changed here too — a stale mirror types the
// spec against a surface the page no longer exposes.
//
// Spec-LOCAL probes (a `window.__cic981Sightings` a single spec installs with
// `addInitScript`) are not part of this surface and stay declared in their spec.

export {};

declare global {
  interface Window {
    // src/lib/socketHealth.ts — SocketHealth, inlined (see mirror note above).
    __cic_socketHealth?: {
      recordOpen: () => void;
      recordError: () => void;
      recordClose: (e: { code: number; reason: string } | undefined) => void;
      reset: () => void;
      state: () => {
        state: "connecting" | "open" | "error";
        errorCount: number;
        lastErrorAt: number | null;
        lastCloseCode: number | null;
        lastCloseReason: string;
        connectAttempts: number;
        errorsTotal: number;
      };
    };

    // src/lib/bundleHash.ts
    __cic_bundleHash?: {
      setServerHash: (hash: string) => void;
      setServerVersion: (version: string | null) => void;
      reset: () => void;
      bootHash: () => string | null;
      bootVersion: () => string | null;
      serverHash: () => string | null;
      __refreshProbe?: () => void;
    };

    // src/lib/swRegistration.ts — SwRegistrationHealth, inlined.
    __cic_swRegistration?: {
      recordError: (e: { name: string; message: string }) => void;
      recordRegistered: (reg?: ServiceWorkerRegistration) => void;
      reset: () => void;
      state: () => {
        state: "unknown" | "registered" | "error";
        error: { name: string; message: string } | null;
      };
    };

    // src/lib/socket.ts
    __cic_dropSocketForTests?: () => Promise<void>;
    __cic_resumeSocketForTests?: () => Promise<void>;
    __visibilityAck?: boolean;

    // src/lib/subscribe.ts
    __cic_suppressChannelDeliveryForTests?: (slug: string, name: string) => void;
    __cic_resumeChannelDeliveryForTests?: (slug: string, name: string) => void;
    __cic_joinedTopicKeys?: () => string[];

    // src/lib/e2e/identity.ts — issue 2430, wipes this browser's E2E state.
    __cic_e2eResetForTests?: () => Promise<void>;

    // src/lib/pushTarget.ts — set once the reader has ROUTED a parsed target,
    // so a spec can tell "the deep link applied" from "session restore happened
    // to select the same window".
    __cicPushTargetApplied?: boolean;
    __cicInviteLinkApplied?: boolean;
  }
}
