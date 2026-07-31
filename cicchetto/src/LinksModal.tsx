import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import {
  clampPan,
  clientToViewBox,
  DEFAULT_LAYOUT_OPTS,
  glyphRadius,
  type LayoutNode,
  radialLayout,
  viewBoxFit,
} from "./lib/linksLayout";
import { dismissLinksModal, linksModalBySlug } from "./lib/linksModal";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { selectedChannel } from "./lib/selection";
import { MircBody } from "./MircText";

// #238 — /links topology visualizer. A covering modal (mirrors WhoModal /
// NamesModal scaffolding: backdrop + role=dialog + overlay-lock + Esc) whose
// body renders the parsed 364/365 `links_bundle` as an INTERACTIVE radial
// tidy-tree of the IRC server mesh.
//
// WHY a hand-rolled SVG tree and not a graph library: an IRC network is a
// spanning TREE by protocol; each 364 carries the node's uplink, so the
// topology is a hierarchy, laid out DETERMINISTICALLY by `radialLayout`
// (`lib/linksLayout.ts`) — no WebGL/d3 dependency in the PWA, and the
// geometry is unit-testable + e2e-assertable (a force sim's jitter is
// neither). Nodes are coloured by tree depth; the root sits at centre; each
// ring is one hop out. Pan (pointer drag), zoom (wheel + pinch + buttons),
// and node select (tap/click → detail footer) make it legible on desktop AND
// device. An EMPTY topology (a restricted/oper-only network that answered a
// bare 365 with no 364 rows) renders the "this network hides its topology"
// empty state.
//
// Reads the topology for the CURRENTLY-ACTIVE network
// (`selectedChannel()?.networkSlug`) from the per-slug `linksModalBySlug`
// store. Ephemeral — dismissing drops the store entry (× / Esc / backdrop).

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;

// #578 — radial gap between the root glyph and its "you are here" halo ring.
const LABEL_HALO = 5;

// Depth → hue ramp (teal root → violet leaves). Display-only; the layout is
// pure geometry. cic owns all colour/label strings (no server display text).
// The footer legend spells this out — the ramp keys "hops from your server".
const depthColor = (depth: number, maxDepth: number): string => {
  const t = maxDepth === 0 ? 0 : depth / maxDepth;
  const hue = 190 + t * 160; // 190 (teal) → 350 (magenta)
  return `hsl(${hue} 68% 58%)`;
};

const LinksModal: Component = () => {
  const activeSlug = (): string | undefined => selectedChannel()?.networkSlug;
  const bundle = () => {
    const slug = activeSlug();
    return slug === undefined ? undefined : linksModalBySlug()[slug];
  };

  const close = (): void => {
    const slug = activeSlug();
    if (slug !== undefined) dismissLinksModal(slug);
  };

  // Refcounted overlay scroll-lock — same wiring as WhoModal. The scroller is
  // `.links-modal-body` (header + footer pinned). Esc routes through the shared
  // topmost-first overlay stack.
  createOverlayLock(() => bundle() !== undefined, ".links-modal-body", close);

  // Pan/zoom transform state (viewBox units). translate(tx ty) scale(k) on the
  // inner <g>; translate is in viewBox space so it is scale-independent.
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  const [k, setK] = createSignal(1);
  const [selected, setSelected] = createSignal<LayoutNode | null>(null);
  const [hovered, setHovered] = createSignal<string | null>(null);

  let svgEl: SVGSVGElement | undefined;
  // Active pointers for drag-pan + two-finger pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  const resetView = (): void => {
    setTx(0);
    setTy(0);
    setK(1);
    setSelected(null);
    setHovered(null);
  };

  // Reset pan/zoom + selection whenever the active topology CHANGES — open, a
  // fresh /links replacing it, or the active network switching. The component is
  // permanently mounted (only the <Show> body unmounts), so its transform +
  // `selected` LayoutNode would otherwise survive a close and bleed into the
  // NEXT map: a reopen would appear pre-panned/zoomed, and the detail footer
  // would show a stale node from a different network's layout. `on(bundle)`
  // fires only when THIS network's bundle reference changes (a /links on another
  // network leaves our slug's value untouched → no reset mid-pan).
  createEffect(on(bundle, () => resetView()));

  // Client px → viewBox units under preserveAspectRatio="xMidYMid meet": a
  // UNIFORM scale + a centering letterbox offset (see `viewBoxFit`). A naive
  // per-axis ratio with no offset anchors zoom off-cursor + lags pan on any
  // non-square canvas (every phone). `fit` reads the live client box each call.
  const fitFor = (vbWidth: number, vbHeight: number) =>
    viewBoxFit(svgEl?.clientWidth ?? 0, svgEl?.clientHeight ?? 0, vbWidth, vbHeight);

  // Zoom around a fixed viewBox point (keeps that point under the cursor/pinch
  // centre). worldPoint = (vbPoint - t)/k is invariant across the zoom. The
  // resulting translate is clamped (clampPan) so a zoom near an edge can't leave
  // the map off-frame — the layout dims are threaded in, same as the pan/wheel
  // handlers already thread them.
  const zoomAround = (
    vbx: number,
    vby: number,
    factor: number,
    vbWidth: number,
    vbHeight: number,
  ): void => {
    const oldK = k();
    const newK = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldK * factor));
    if (newK === oldK) return;
    const clamped = clampPan(
      vbx - (newK / oldK) * (vbx - tx()),
      vby - (newK / oldK) * (vby - ty()),
      newK,
      { width: vbWidth, height: vbHeight },
    );
    setTx(clamped.tx);
    setTy(clamped.ty);
    setK(newK);
  };

  const onWheel = (e: WheelEvent, vbWidth: number, vbHeight: number): void => {
    e.preventDefault();
    if (svgEl === undefined) return;
    const rect = svgEl.getBoundingClientRect();
    const p = clientToViewBox(
      e.clientX - rect.left,
      e.clientY - rect.top,
      fitFor(vbWidth, vbHeight),
    );
    zoomAround(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12, vbWidth, vbHeight);
  };

  const onPointerDown = (e: PointerEvent): void => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a !== undefined && b !== undefined) pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerMove = (e: PointerEvent, vbWidth: number, vbHeight: number): void => {
    const prev = pointers.get(e.pointerId);
    if (prev === undefined) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);

    if (pointers.size >= 2) {
      // Pinch-zoom around the two-pointer midpoint.
      const [a, b] = [...pointers.values()];
      if (a === undefined || b === undefined) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && svgEl !== undefined) {
        const rect = svgEl.getBoundingClientRect();
        const mid = clientToViewBox(
          (a.x + b.x) / 2 - rect.left,
          (a.y + b.y) / 2 - rect.top,
          fitFor(vbWidth, vbHeight),
        );
        zoomAround(mid.x, mid.y, dist / pinchDist, vbWidth, vbHeight);
      }
      pinchDist = dist;
      return;
    }

    // Single-pointer drag → pan. Delta is a client-px vector; the viewBox is
    // uniformly scaled, so divide by the fit scale (same factor both axes). The
    // new translate is clamped so the map cannot be dragged off-frame (#238 fix).
    const factor = 1 / fitFor(vbWidth, vbHeight).scale;
    const clamped = clampPan(
      tx() + (cur.x - prev.x) * factor,
      ty() + (cur.y - prev.y) * factor,
      k(),
      { width: vbWidth, height: vbHeight },
    );
    setTx(clamped.tx);
    setTy(clamped.ty);
  };

  const onPointerUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
  };

  // Belt-and-braces: never leak captured pointers if the modal unmounts mid-drag.
  onCleanup(() => pointers.clear());

  return (
    <Show when={bundle()} keyed>
      {(b) => {
        const layout = createMemo(() => radialLayout(b.entries, DEFAULT_LAYOUT_OPTS));
        // Count the RECONSTRUCTED nodes, not the raw wire entries: a de-duped
        // double-364 (last-write-wins in buildTree) renders fewer dots than
        // `entries.length`, so sourcing the heading / aria-label / label
        // threshold from the layout keeps the "N servers" count honest.
        const nodeCount = (): number => layout().nodes.length;
        const detail = (): LayoutNode | null => {
          const sel = selected();
          if (sel !== null) return sel;
          const hov = hovered();
          if (hov === null) return null;
          return layout().nodes.find((n) => n.server === hov) ?? null;
        };

        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="links-modal-backdrop" onClick={close}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="links-modal-title"
              class="links-modal"
              data-testid="links-modal"
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
            >
              <header class="links-modal-header">
                <h2 id="links-modal-title">
                  network map — {nodeCount()} {nodeCount() === 1 ? "server" : "servers"}
                </h2>
                <div class="links-modal-controls">
                  <button
                    type="button"
                    class="links-modal-zoom"
                    aria-label="zoom out"
                    onClick={() =>
                      zoomAround(
                        layout().width / 2,
                        layout().height / 2,
                        1 / 1.3,
                        layout().width,
                        layout().height,
                      )
                    }
                  >
                    −
                  </button>
                  <button
                    type="button"
                    class="links-modal-zoom"
                    aria-label="reset view"
                    onClick={resetView}
                  >
                    ⊙
                  </button>
                  <button
                    type="button"
                    class="links-modal-zoom"
                    aria-label="zoom in"
                    onClick={() =>
                      zoomAround(
                        layout().width / 2,
                        layout().height / 2,
                        1.3,
                        layout().width,
                        layout().height,
                      )
                    }
                  >
                    +
                  </button>
                  <button
                    type="button"
                    class="links-modal-close"
                    aria-label="close links"
                    onClick={close}
                  >
                    ×
                  </button>
                </div>
              </header>

              <div class="links-modal-body">
                <Show
                  when={nodeCount() > 0}
                  fallback={
                    // #513a — split the empty state on the requested mask. A
                    // non-null mask that drained zero nodes MATCHED NOTHING
                    // (`/links all` → bare 365); only a null-mask (full-mesh)
                    // empty is a fair "restricted topology" guess. Pre-#513
                    // both rendered "hides its topology", which lied for masks.
                    <div
                      class="links-modal-empty"
                      data-testid="links-modal-empty"
                      data-empty-reason={b.mask !== null ? "no-match" : "restricted"}
                    >
                      <Show
                        when={b.mask !== null}
                        fallback={
                          <>
                            <p>this network hides its topology</p>
                            <p class="links-modal-empty-sub">
                              LINKS returned no servers — many networks restrict it to operators.
                            </p>
                          </>
                        }
                      >
                        <p>
                          no server matches <code>{b.mask}</code>
                        </p>
                        <p class="links-modal-empty-sub">
                          try /links with no argument for the full network map.
                        </p>
                      </Show>
                    </div>
                  }
                >
                  <svg
                    ref={svgEl}
                    class="links-modal-svg"
                    data-testid="links-modal-svg"
                    viewBox={`0 0 ${layout().width} ${layout().height}`}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={`network topology, ${nodeCount()} servers`}
                    onWheel={(e) => onWheel(e, layout().width, layout().height)}
                    onPointerDown={onPointerDown}
                    onPointerMove={(e) => onPointerMove(e, layout().width, layout().height)}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  >
                    <g transform={`translate(${tx()} ${ty()}) scale(${k()})`}>
                      <g class="links-modal-edges">
                        <For each={layout().edges}>
                          {(edge) => (
                            <line
                              class="links-modal-edge"
                              x1={edge.x1}
                              y1={edge.y1}
                              x2={edge.x2}
                              y2={edge.y2}
                            />
                          )}
                        </For>
                      </g>
                      <g class="links-modal-nodes">
                        <For each={layout().nodes}>
                          {(node) => {
                            const isActive = (): boolean =>
                              selected()?.server === node.server || hovered() === node.server;
                            // #578 — label visibility is the layout's greedy
                            // declutter verdict (`labelVisible`, root always
                            // true), with the hovered/selected node forced on
                            // top. The pure layout guarantees no two BASELINE
                            // labels overlap; a transient active label is the
                            // one the user asked for, so it always shows. Only
                            // baseline-visible labels feed the fitted extent, so
                            // hovering a DECLUTTERED edge node can push its label
                            // a few units past the box edge (clipped on the fill
                            // axis); it's transient and a pan recovers it —
                            // reserving extent for every possible hover would
                            // undo the fit.
                            const labelled = (): boolean => node.labelVisible || isActive();
                            return (
                              // biome-ignore lint/a11y/noStaticElementInteractions: SVG node glyph is a pointer-first inspect target (tap/hover), not a control; keyboard nav is a documented INC-3 follow-up
                              <g
                                class="links-modal-node"
                                classList={{
                                  "links-modal-node-root": node.isRoot,
                                  "links-modal-node-active": isActive(),
                                }}
                                transform={`translate(${node.x} ${node.y})`}
                                data-testid="links-modal-node"
                                data-server={node.server}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelected((cur) => (cur?.server === node.server ? null : node));
                                }}
                                onPointerEnter={() => setHovered(node.server)}
                                onPointerLeave={() =>
                                  setHovered((cur) => (cur === node.server ? null : cur))
                                }
                              >
                                <title>
                                  {node.server}
                                  {node.hopcount !== null ? ` (${node.hopcount} hops)` : ""}
                                  {node.isRoot ? " — you are here" : ""}
                                </title>
                                {/* #578 — a "you are here" halo ring around the
                                    root so the eye lands there first (the ramp's
                                    teal root is only legible once you know the
                                    ramp; the ring needs no key). */}
                                <Show when={node.isRoot}>
                                  <circle
                                    class="links-modal-you-ring"
                                    r={glyphRadius(node, DEFAULT_LAYOUT_OPTS) + LABEL_HALO}
                                  />
                                </Show>
                                <circle
                                  class="links-modal-dot"
                                  r={glyphRadius(node, DEFAULT_LAYOUT_OPTS)}
                                  style={{ fill: depthColor(node.depth, layout().maxDepth) }}
                                />
                                <Show when={labelled()}>
                                  <text
                                    class="links-modal-label"
                                    text-anchor={node.labelAnchor}
                                    x={node.labelX}
                                    y={node.labelY}
                                  >
                                    {node.label}
                                  </text>
                                </Show>
                              </g>
                            );
                          }}
                        </For>
                      </g>
                    </g>
                  </svg>
                </Show>
              </div>

              <footer class="links-modal-footer">
                {/* #578 (polish 3+4) — a one-line colour-ramp key + "you"
                    marker so the teal-root / hop-ramp is legible without a full
                    legend. Persistent while a topology is drawn; sits above the
                    hint/detail swap. */}
                <Show when={nodeCount() > 0}>
                  <div class="links-modal-legend" data-testid="links-modal-legend">
                    <span class="links-modal-legend-you">◎ you are here</span>
                    <span class="links-modal-legend-ramp">
                      {/* Gradient stops come from the SAME depthColor ramp the
                          nodes use (root→leaf), so a ramp tuning stays one
                          source — no hardcoded hsl() duplicated in the CSS. */}
                      <span
                        class="links-modal-legend-swatch"
                        aria-hidden="true"
                        style={{
                          background: `linear-gradient(90deg, ${depthColor(0, 1)}, ${depthColor(1, 1)})`,
                        }}
                      />
                      colour = hops from your server
                    </span>
                  </div>
                </Show>
                <Show
                  when={detail()}
                  fallback={
                    <span class="links-modal-hint">
                      {nodeCount() > 0
                        ? "drag to pan · scroll or pinch to zoom · tap a server for detail"
                        : "End of /LINKS list"}
                    </span>
                  }
                >
                  {(d) => (
                    <div class="links-modal-detail" data-testid="links-modal-detail">
                      <span class="links-modal-detail-name">{d().server}</span>
                      <Show when={d().hopcount !== null}>
                        <span class="links-modal-detail-hops">{d().hopcount} hops</span>
                      </Show>
                      <Show when={d().parent !== null}>
                        <span class="links-modal-detail-uplink">↑ {d().parent}</span>
                      </Show>
                      <Show when={d().description}>
                        <span class="links-modal-detail-desc">
                          <MircBody body={d().description ?? ""} />
                        </span>
                      </Show>
                    </div>
                  )}
                </Show>
              </footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default LinksModal;
