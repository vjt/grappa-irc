import { describe, expect, it } from "vitest";
import type { LinksEntry } from "../lib/api";
import {
  clampPan,
  clientToViewBox,
  DEFAULT_LAYOUT_OPTS,
  glyphRadius,
  type LayoutNode,
  labelBox,
  placeLabel,
  radialLayout,
  viewBoxFit,
} from "../lib/linksLayout";

// #238 — radialLayout is the PURE, DETERMINISTIC heart of the /links topology
// map: parsed 364/365 `links_bundle` entries → a positioned radial tidy-tree.
// These tests are the ground the whole feature stands on — the modal render and
// the e2e both assume this geometry. TDD teeth: exact node/edge COUNTS, the
// reconstructed parent edges, root selection priority, orphan re-parenting,
// cycle termination, and the root-at-centre invariant. Nothing is asserted by
// mirroring the impl — every check would FAIL if the reconstruction were wrong.
//
// All geometry constants derive from the production `DEFAULT_LAYOUT_OPTS` so a
// tuning change to ringGap/margin re-flows the expectations, never a stale
// magic number.

const { ringGap, margin } = DEFAULT_LAYOUT_OPTS;

// outer ring / centre / canvas size for a tree of a given max depth — the same
// formula radialLayout uses, restated once so the assertions read declaratively.
const centreFor = (maxDepth: number): number => maxDepth * ringGap + margin;
const sizeFor = (maxDepth: number): number => centreFor(maxDepth) * 2;

const entry = (over: Partial<LinksEntry>): LinksEntry => ({
  server: "irc.test.org",
  linked_to: null,
  hopcount: null,
  description: null,
  ...over,
});

const edgeKey = (from: string, to: string): string => `${from}->${to}`;
const edgeSet = (layout: ReturnType<typeof radialLayout>): Set<string> =>
  new Set(layout.edges.map((e) => edgeKey(e.from, e.to)));
const serverSet = (layout: ReturnType<typeof radialLayout>): string[] =>
  layout.nodes.map((n) => n.server);
const nodeBy = (layout: ReturnType<typeof radialLayout>, server: string) =>
  layout.nodes.find((n) => n.server === server);

// #578 — the fitted-box invariants, expressed with the PRODUCTION geometry
// helpers (glyphRadius / labelBox) so they track a tuning change instead of
// re-deriving the box formula (which would be a mirror of the impl).

// Every node glyph sits fully inside the fitted [0,width]×[0,height] box.
const expectContained = (layout: ReturnType<typeof radialLayout>): void => {
  for (const n of layout.nodes) {
    const r = glyphRadius(n, DEFAULT_LAYOUT_OPTS);
    expect(n.x - r).toBeGreaterThanOrEqual(-1e-6);
    expect(n.y - r).toBeGreaterThanOrEqual(-1e-6);
    expect(n.x + r).toBeLessThanOrEqual(layout.width + 1e-6);
    expect(n.y + r).toBeLessThanOrEqual(layout.height + 1e-6);
  }
};

// The distance from the box's left/top edge (x=0 / y=0) to the nearest node
// extremity — glyph edge OR visible-label box edge. A tight fit puts this at
// exactly one `margin` (the layout's requested padding).
const minExtremity = (layout: ReturnType<typeof radialLayout>): number => {
  let min = Number.POSITIVE_INFINITY;
  for (const n of layout.nodes) {
    const r = glyphRadius(n, DEFAULT_LAYOUT_OPTS);
    min = Math.min(min, n.x - r, n.y - r);
    if (n.labelVisible) {
      const b = labelBox(n, DEFAULT_LAYOUT_OPTS);
      min = Math.min(min, b.minX, b.minY);
    }
  }
  return min;
};

const visibleLabels = (layout: ReturnType<typeof radialLayout>): LayoutNode[] =>
  layout.nodes.filter((n) => n.labelVisible);

describe("radialLayout (#238) — empty + single-node degenerate cases", () => {
  it("returns an empty layout for zero entries", () => {
    const layout = radialLayout([], DEFAULT_LAYOUT_OPTS);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
    expect(layout.maxDepth).toBe(0);
  });

  it("places a single self-linked node as the root, fully inside a fitted box, no edges", () => {
    const layout = radialLayout(
      [entry({ server: "hub", linked_to: "hub", hopcount: 0 })],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    const root = layout.nodes[0];
    expect(root?.isRoot).toBe(true);
    expect(root?.parent).toBeNull();
    expect(root?.depth).toBe(0);
    expect(root?.radius).toBe(0);
    // #578 — the box is FITTED to the node's real extent (glyph + label + margin),
    // NOT the full-disc `2*outer` any more. A lone root can't fill a disc: the
    // fitted box is strictly smaller than the old sizeFor(0) would demand once a
    // label is measured in, and the glyph sits fully inside it.
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    expectContained(layout);
    // Its label always survives the declutter (root is placed first).
    expect(root?.labelVisible).toBe(true);
  });

  it("treats a lone node with no self-link as the root anyway (no entry dropped)", () => {
    const layout = radialLayout(
      [entry({ server: "solo", linked_to: null, hopcount: null })],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.isRoot).toBe(true);
    expect(layout.edges).toHaveLength(0);
  });
});

describe("radialLayout (#238) — root selection priority", () => {
  it("prefers a self-linked node OVER a lower-hopcount peer", () => {
    // "a" has hopcount 0 (would win min-hopcount) but "hub" self-links with a
    // HIGHER hopcount — self-link must still win. Teeth: min-hopcount would
    // pick the wrong root.
    const layout = radialLayout(
      [
        entry({ server: "a", linked_to: "x", hopcount: 0 }),
        entry({ server: "hub", linked_to: "hub", hopcount: 5 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(nodeBy(layout, "hub")?.isRoot).toBe(true);
    expect(nodeBy(layout, "a")?.isRoot).toBe(false);
    expect(layout.nodes).toHaveLength(2);
  });

  it("picks the minimum-hopcount node as root when no node self-links", () => {
    // "b" (hop 1) is neither first nor alphabetically first — only the
    // hopcount minimum. Teeth against a first-entry or alpha fallback.
    const layout = radialLayout(
      [
        entry({ server: "a", linked_to: "b", hopcount: 3 }),
        entry({ server: "b", linked_to: "c", hopcount: 1 }),
        entry({ server: "c", linked_to: "d", hopcount: 2 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(nodeBy(layout, "b")?.isRoot).toBe(true);
    expect(nodeBy(layout, "b")?.depth).toBe(0);
  });

  it("falls back to the first entry when no self-link and all hopcounts are null", () => {
    // "z" is first but alphabetically LAST — first-entry fallback picks it,
    // proving it is not an alpha-min or a min-hopcount pick.
    const layout = radialLayout(
      [
        entry({ server: "z", linked_to: null, hopcount: null }),
        entry({ server: "a", linked_to: "z", hopcount: null }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(nodeBy(layout, "z")?.isRoot).toBe(true);
    expect(nodeBy(layout, "a")?.isRoot).toBe(false);
  });
});

describe("radialLayout (#238) — depth, edges, and geometry", () => {
  it("assigns depth from the reconstructed root and one edge per parent link", () => {
    // A three-hop chain: hub → mid → leaf.
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "mid", linked_to: "hub", hopcount: 1 }),
        entry({ server: "leaf", linked_to: "mid", hopcount: 2 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(3);
    expect(nodeBy(layout, "hub")?.depth).toBe(0);
    expect(nodeBy(layout, "mid")?.depth).toBe(1);
    expect(nodeBy(layout, "leaf")?.depth).toBe(2);
    expect(layout.maxDepth).toBe(2);

    // Depth drives the ring radius.
    expect(nodeBy(layout, "hub")?.radius).toBe(0);
    expect(nodeBy(layout, "mid")?.radius).toBe(ringGap);
    expect(nodeBy(layout, "leaf")?.radius).toBe(2 * ringGap);

    // Exactly the two parent edges, no more.
    expect(layout.edges).toHaveLength(2);
    expect(edgeSet(layout)).toEqual(new Set([edgeKey("hub", "mid"), edgeKey("mid", "leaf")]));

    // #578 — a single-child chain is COLLINEAR (each internal node inherits its
    // one child's angle), so the tree occupies a thin line, not a disc. The
    // fitted box hugs that extent: strictly smaller than the old full-disc
    // sizeFor(2) on BOTH axes, and much thinner across the line than along it.
    expect(layout.width).toBeLessThan(sizeFor(2));
    expect(layout.height).toBeLessThan(sizeFor(2));
    expect(layout.height).toBeLessThan(layout.width);
    // Every glyph is fully inside the fitted box.
    expectContained(layout);
    // Tightness: the extreme node (glyph or its visible label) is exactly one
    // margin from the box edge — computed with the SAME production helpers the
    // layout fits with, so this is not a mirror of the impl.
    expect(minExtremity(layout)).toBeCloseTo(margin, 6);
  });

  it("reconstructs a star: one root with N leaf edges", () => {
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "leafA", linked_to: "hub", hopcount: 1 }),
        entry({ server: "leafB", linked_to: "hub", hopcount: 1 }),
        entry({ server: "leafC", linked_to: "hub", hopcount: 1 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges).toHaveLength(3);
    expect(edgeSet(layout)).toEqual(
      new Set([edgeKey("hub", "leafA"), edgeKey("hub", "leafB"), edgeKey("hub", "leafC")]),
    );
    // Every leaf is depth 1; maxDepth 1.
    expect(layout.maxDepth).toBe(1);
    for (const leaf of ["leafA", "leafB", "leafC"]) {
      expect(nodeBy(layout, leaf)?.depth).toBe(1);
    }
  });

  it("passes hopcount + description through verbatim onto the node", () => {
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0, description: "the hub" }),
        entry({ server: "leaf", linked_to: "hub", hopcount: 7, description: "a \x02leaf\x02" }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(nodeBy(layout, "leaf")?.hopcount).toBe(7);
    expect(nodeBy(layout, "leaf")?.description).toBe("a \x02leaf\x02");
    expect(nodeBy(layout, "hub")?.description).toBe("the hub");
  });
});

describe("radialLayout (#238) — resilience: orphans, dupes, cycles", () => {
  it("re-parents an orphan (uplink absent from the set) onto the root", () => {
    // "orphan" claims uplink "ghost" which never appears — it must NOT vanish;
    // the layout hangs it under the root so every server stays visible.
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "orphan", linked_to: "ghost", hopcount: 5 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(2);
    // Tree edge attaches the orphan to the root...
    expect(edgeSet(layout)).toEqual(new Set([edgeKey("hub", "orphan")]));
    expect(nodeBy(layout, "orphan")?.depth).toBe(1);
    // ...while the node still reports the RAW uplink the server claimed (the
    // detail footer shows what upstream said, phantom or not).
    expect(nodeBy(layout, "orphan")?.parent).toBe("ghost");
  });

  it("de-dupes a repeated server (a malformed double 364) to a single node", () => {
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "leaf", linked_to: "hub", hopcount: 1, description: "first" }),
        entry({ server: "leaf", linked_to: "hub", hopcount: 1, description: "second" }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expect(layout.nodes).toHaveLength(2);
    // Last write wins.
    expect(nodeBy(layout, "leaf")?.description).toBe("second");
  });

  it("terminates on a mutual-uplink cycle and emits each node exactly once", () => {
    // a → b and b → a with no self-link. Without the visited-set guard the
    // depth walk would recurse forever; the layout must still terminate with
    // two unique nodes and a single edge.
    const layout = radialLayout(
      [
        entry({ server: "a", linked_to: "b", hopcount: 1 }),
        entry({ server: "b", linked_to: "a", hopcount: 1 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    const servers = serverSet(layout);
    expect(servers).toHaveLength(2);
    expect(new Set(servers).size).toBe(2); // no duplicate node
    expect(layout.edges).toHaveLength(1);
  });

  it("keeps every node of a DISCONNECTED uplink cycle (none reachable from root)", () => {
    // R is the root; a→b and b→a form a self-contained loop whose members'
    // uplinks point only at each other, so neither is reachable by the walk
    // from R. Without the post-walk stray sweep they'd vanish silently,
    // breaking the "no node is ever dropped" contract. Both must survive.
    const layout = radialLayout(
      [
        entry({ server: "R", linked_to: "R", hopcount: 0 }),
        entry({ server: "a", linked_to: "b", hopcount: 5 }),
        entry({ server: "b", linked_to: "a", hopcount: 5 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    const servers = serverSet(layout);
    expect(servers).toHaveLength(3);
    expect(new Set(servers)).toEqual(new Set(["R", "a", "b"]));
    // Connected tree of 3 nodes → 2 edges; still exactly one root.
    expect(layout.edges).toHaveLength(2);
    expect(layout.nodes.filter((n) => n.isRoot)).toHaveLength(1);
    expect(nodeBy(layout, "R")?.isRoot).toBe(true);
  });

  it("never emits a duplicate node across a larger mixed topology", () => {
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "eu", linked_to: "hub", hopcount: 1 }),
        entry({ server: "us", linked_to: "hub", hopcount: 1 }),
        entry({ server: "eu-1", linked_to: "eu", hopcount: 2 }),
        entry({ server: "eu-2", linked_to: "eu", hopcount: 2 }),
        entry({ server: "us-1", linked_to: "us", hopcount: 2 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    const servers = serverSet(layout);
    expect(servers).toHaveLength(6);
    expect(new Set(servers).size).toBe(6);
    // Every non-root node contributes exactly one edge → edges == nodes - 1.
    expect(layout.edges).toHaveLength(5);
    expect(layout.maxDepth).toBe(2);
  });
});

describe("viewBoxFit + clientToViewBox (#238) — preserveAspectRatio=xMidYMid meet", () => {
  it("is the identity map when the client box equals the (square) viewBox", () => {
    const fit = viewBoxFit(400, 400, 400, 400);
    expect(fit).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(clientToViewBox(100, 250, fit)).toEqual({ x: 100, y: 250 });
  });

  it("applies a uniform scale for a smaller square client box (no letterbox)", () => {
    const fit = viewBoxFit(200, 200, 400, 400);
    expect(fit).toEqual({ scale: 0.5, offsetX: 0, offsetY: 0 });
    // A client point maps to double its coordinate in viewBox units.
    expect(clientToViewBox(100, 100, fit)).toEqual({ x: 200, y: 200 });
  });

  it("centers content vertically on a PORTRAIT canvas (width-limited fit)", () => {
    // 360×640 client, 400×400 viewBox: scale = min(0.9, 1.6) = 0.9; drawn box
    // 360×360 centered → offsetY = (640-360)/2 = 140, offsetX = 0.
    const fit = viewBoxFit(360, 640, 400, 400);
    expect(fit.scale).toBeCloseTo(0.9, 10);
    expect(fit.offsetX).toBeCloseTo(0, 10);
    expect(fit.offsetY).toBeCloseTo(140, 10);
    // The TOP edge of the drawn content (relY = offsetY) is viewBox y = 0 — the
    // exact anchor the pre-fix per-axis math got wrong (it would have returned
    // 140 * 400/640 = 87.5, flinging zoom off-cursor).
    expect(clientToViewBox(180, 140, fit)).toEqual({ x: 200, y: 0 });
    // The client-box centre maps to the viewBox centre.
    expect(clientToViewBox(180, 320, fit)).toEqual({ x: 200, y: 200 });
  });

  it("centers content horizontally on a LANDSCAPE canvas (height-limited fit)", () => {
    // 800×400 client, 400×400 viewBox: scale = min(2, 1) = 1; offsetX = 200.
    const fit = viewBoxFit(800, 400, 400, 400);
    expect(fit).toEqual({ scale: 1, offsetX: 200, offsetY: 0 });
    expect(clientToViewBox(200, 0, fit)).toEqual({ x: 0, y: 0 });
    expect(clientToViewBox(400, 200, fit)).toEqual({ x: 200, y: 200 });
  });

  it("degrades to an identity map on a zero dimension (unmeasured ref)", () => {
    const fit = viewBoxFit(0, 0, 0, 0);
    expect(fit.scale).toBe(1);
    expect(clientToViewBox(50, 50, fit)).toEqual({ x: 50, y: 50 });
  });
});

describe("clampPan (#238 fix) — the map can't be dragged off-frame", () => {
  const layout = { width: 600, height: 600 };

  it("pins translate to the origin at k=1 (content exactly fills the frame)", () => {
    // slack = 600 - 1*600 = 0 → the only legal translate is 0 on both axes, so a
    // drag at neutral zoom snaps straight back (no pan is even possible).
    expect(clampPan(120, -80, 1, layout)).toEqual({ tx: 0, ty: 0 });
  });

  it("keeps a zoomed-OUT map fully inside the frame (k<1 → t in [0, slack])", () => {
    // slack = 600 - 0.5*600 = 300 → legal range [0, 300].
    expect(clampPan(-100, 500, 0.5, layout)).toEqual({ tx: 0, ty: 300 });
    // an in-range translate passes through untouched.
    expect(clampPan(150, 200, 0.5, layout)).toEqual({ tx: 150, ty: 200 });
  });

  it("confines a zoomed-IN map to its overflow (k>1 → t in [slack, 0])", () => {
    // slack = 600 - 2*600 = -600 → legal range [-600, 0].
    expect(clampPan(100, -700, 2, layout)).toEqual({ tx: 0, ty: -600 });
    // an in-range translate passes through untouched.
    expect(clampPan(-300, -100, 2, layout)).toEqual({ tx: -300, ty: -100 });
  });

  it("clamps the two axes independently", () => {
    // ty in range, tx over the high edge (k<1).
    expect(clampPan(9999, 42, 0.5, layout)).toEqual({ tx: 300, ty: 42 });
  });
});

describe("placeLabel (#578) — label anchor is derived from the node ANGLE", () => {
  const o = DEFAULT_LAYOUT_OPTS;

  it("anchors an EAST (right-half) node to the start, label placed to its RIGHT", () => {
    const p = placeLabel(0, false, o); // angle 0 = due east
    expect(p.anchor).toBe("start");
    expect(p.x).toBeGreaterThan(0);
  });

  it("anchors a WEST (left-half) node to the end, label placed to its LEFT", () => {
    const p = placeLabel(Math.PI, false, o); // angle π = due west
    expect(p.anchor).toBe("end");
    expect(p.x).toBeLessThan(0);
  });

  it("centres a NORTH node above the glyph (middle, negative y)", () => {
    const p = placeLabel(-Math.PI / 2, false, o); // straight up (SVG y grows down)
    expect(p.anchor).toBe("middle");
    expect(p.x).toBe(0);
    expect(p.y).toBeLessThan(0);
  });

  it("centres a SOUTH node below the glyph (middle, positive y)", () => {
    const p = placeLabel(Math.PI / 2, false, o); // straight down
    expect(p.anchor).toBe("middle");
    expect(p.x).toBe(0);
    expect(p.y).toBeGreaterThan(0);
  });

  it("always centres the ROOT above, regardless of its (meaningless) angle", () => {
    // Root radius 0 → its angle is arbitrary; the label must not swing sides.
    for (const a of [0, Math.PI, Math.PI / 2, -Math.PI / 2, 1.234]) {
      const p = placeLabel(a, true, o);
      expect(p.anchor).toBe("middle");
      expect(p.x).toBe(0);
      expect(p.y).toBeLessThan(0);
    }
  });

  it("gives a COLLINEAR parent/child pair non-stacked labels (the #578 overlap)", () => {
    // The screenshot bug: a one-child internal node inherits its child's angle
    // exactly, so both sit on the same ray one ring apart. A single leaf under
    // the root lands due WEST (angle π); the root stays centred-above while the
    // leaf swings to its LEFT — different anchors, so the labels no longer pile.
    const layout = radialLayout(
      [
        entry({ server: "root", linked_to: "root", hopcount: 0 }),
        entry({ server: "devel", linked_to: "root", hopcount: 1 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    const root = nodeBy(layout, "root");
    const devel = nodeBy(layout, "devel");
    expect(root?.labelAnchor).toBe("middle");
    expect(devel?.labelAnchor).toBe("end"); // west → left side, not centred-above
    // Both labels survive (a 2-node tree is nowhere near crowded)...
    expect(root?.labelVisible).toBe(true);
    expect(devel?.labelVisible).toBe(true);
    // ...and their measured boxes do NOT overlap (the whole point of the fix).
    const rb = labelBox(root as LayoutNode, DEFAULT_LAYOUT_OPTS);
    const db = labelBox(devel as LayoutNode, DEFAULT_LAYOUT_OPTS);
    const overlap =
      rb.minX < db.maxX && db.minX < rb.maxX && rb.minY < db.maxY && db.minY < rb.maxY;
    expect(overlap).toBe(false);
  });
});

describe("radialLayout (#578) — the viewBox fits the real node extent", () => {
  // A star: N leaves equally spaced around one self-linked hub.
  const star = (leaves: number): LinksEntry[] => [
    entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
    ...Array.from({ length: leaves }, (_, i) =>
      entry({ server: `leaf-${i}`, linked_to: "hub", hopcount: 1 }),
    ),
  ];

  it("fits TIGHTLY — the extreme node is exactly one margin from the edge", () => {
    // The property that pins the whole fix: the nearest node extremity (glyph OR
    // visible label) is exactly `margin` from x=0 / y=0. The old full-disc box
    // left a half-canvas of dead black around a small mesh — this forbids it for
    // ANY topology, and every glyph stays inside the box.
    const layout = radialLayout(star(6), DEFAULT_LAYOUT_OPTS);
    expectContained(layout);
    expect(minExtremity(layout)).toBeCloseTo(margin, 6);
  });

  it("includes visible LABELS in the fitted extent (the old box clipped them)", () => {
    // A single east/west leaf swings its label OUTWARD past the glyph; the fitted
    // box must contain that label box, not just the glyph disc. This is exactly
    // what the old glyph-only full-disc bound got wrong (labels clipped at the
    // ring). Assert the leftmost VISIBLE label sits no further left than x=0.
    const layout = radialLayout(star(6), DEFAULT_LAYOUT_OPTS);
    for (const n of visibleLabels(layout)) {
      const b = labelBox(n, DEFAULT_LAYOUT_OPTS);
      expect(b.minX).toBeGreaterThanOrEqual(-1e-6);
      expect(b.maxX).toBeLessThanOrEqual(layout.width + 1e-6);
      expect(b.minY).toBeGreaterThanOrEqual(-1e-6);
      expect(b.maxY).toBeLessThanOrEqual(layout.height + 1e-6);
    }
  });

  it("collapses the box for a collinear CHAIN (the dead-space win)", () => {
    // A single-child chain is a thin LINE, not a disc. The fitted box hugs it:
    // strictly under the old full-disc bound on both axes, and much thinner
    // across the line than along it — the exact dead black the bug reported.
    const layout = radialLayout(
      [
        entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
        entry({ server: "aa", linked_to: "hub", hopcount: 1 }),
        entry({ server: "bb", linked_to: "aa", hopcount: 2 }),
        entry({ server: "cc", linked_to: "bb", hopcount: 3 }),
      ],
      DEFAULT_LAYOUT_OPTS,
    );
    expectContained(layout);
    expect(layout.width).toBeLessThan(sizeFor(3));
    expect(layout.height).toBeLessThan(sizeFor(3));
    expect(layout.height).toBeLessThan(layout.width);
  });

  it("degrades to an empty box for an empty topology (unchanged)", () => {
    const layout = radialLayout([], DEFAULT_LAYOUT_OPTS);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });
});

describe("radialLayout (#578) — greedy label declutter", () => {
  const star = (leaves: number): LinksEntry[] => [
    entry({ server: "hub", linked_to: "hub", hopcount: 0 }),
    ...Array.from({ length: leaves }, (_, i) =>
      entry({ server: `leaf-${i}`, linked_to: "hub", hopcount: 1 }),
    ),
  ];

  it("shows ALL labels on a sparse star (angular gaps are wide)", () => {
    const layout = radialLayout(star(3), DEFAULT_LAYOUT_OPTS);
    expect(visibleLabels(layout)).toHaveLength(layout.nodes.length);
  });

  it("DROPS colliding labels on a dense star (angular distance, not node count)", () => {
    // 40 leaves crammed onto one ring → adjacent labels overlap → most are
    // dropped. The axis is ANGULAR crowding, which a node-count threshold missed.
    const layout = radialLayout(star(40), DEFAULT_LAYOUT_OPTS);
    const visible = visibleLabels(layout);
    expect(visible.length).toBeLessThan(layout.nodes.length); // some dropped
    expect(visible.length).toBeGreaterThanOrEqual(1); // not all dropped
  });

  it("ALWAYS keeps the root label (placed first, never decluttered away)", () => {
    const layout = radialLayout(star(40), DEFAULT_LAYOUT_OPTS);
    expect(nodeBy(layout, "hub")?.isRoot).toBe(true);
    expect(nodeBy(layout, "hub")?.labelVisible).toBe(true);
  });

  it("never lets two VISIBLE labels overlap (the declutter guarantee)", () => {
    const layout = radialLayout(star(40), DEFAULT_LAYOUT_OPTS);
    const boxes = visibleLabels(layout).map((n) => labelBox(n, DEFAULT_LAYOUT_OPTS));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a === undefined || b === undefined) continue;
        const overlap = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
        expect(overlap).toBe(false);
      }
    }
  });
});
