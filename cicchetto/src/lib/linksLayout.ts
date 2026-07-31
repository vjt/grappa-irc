// #238 — LINKS topology layout. A PURE, DETERMINISTIC function turning the
// parsed 364/365 `links_bundle` entries (server + uplink + hopcount) into a
// positioned radial tidy-tree: nodes at polar coordinates, one edge per
// parent→child link.
//
// WHY a tree, not a force-directed graph: an IRC network is a SPANNING TREE by
// protocol (no loops). Each 364 carries the node's uplink (`linked_to`), so we
// reconstruct the real parent edges — the topology IS a hierarchy, and a
// deterministic radial layout renders it more readably than a force sim thrown
// at hierarchical data. Deterministic also means the layout is unit-testable
// and the e2e can assert exact node/edge counts from parsed numerics (a force
// sim's random jitter makes both impossible). Zero dependencies — this is
// plain geometry the house style prefers over a WebGL/d3 dep in the PWA.
//
// The layout is pure geometry only: depth colouring, node radii, hover state,
// zoom/pan all live in `LinksModal.tsx` (the display concerns).

import type { LinksEntry } from "./api";

export type LayoutNode = {
  server: string;
  description: string | null;
  // Hopcount as reported by the ircd (distance from the server grappa is
  // connected to). May differ from `depth` when the reply is partial/masked;
  // both are surfaced — `depth` drives geometry, `hopcount` is shown verbatim.
  hopcount: number | null;
  // Tree depth from the reconstructed root (root = 0). Drives the ring radius.
  depth: number;
  // Uplink server name (null only for the root). The parent EDGE key.
  parent: string | null;
  isRoot: boolean;
  angle: number;
  radius: number;
  x: number;
  y: number;
  // #578 — label placement, all resolved here so the modal is a dumb renderer
  // and the geometry stays unit-testable. `label` is the short display string
  // (leftmost DNS segment); `labelAnchor` + `labelX`/`labelY` are the
  // node-RELATIVE (post-translate) text placement, derived from the node's
  // polar angle so a side node's label sits outward instead of always centred
  // above; `labelVisible` is the greedy-declutter verdict (root always true) —
  // the modal ORs the hovered/selected node on top of it.
  label: string;
  labelAnchor: LabelAnchor;
  labelX: number;
  labelY: number;
  labelVisible: boolean;
};

// SVG text-anchor, chosen per node from its angle (#578).
export type LabelAnchor = "start" | "middle" | "end";

export type LayoutEdge = {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type Layout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  // Bounding box the SVG viewBox fits (origin at 0,0). #578 — FITTED to the real
  // node extent (every glyph disc + every visible label box, grown by margin),
  // NOT the old full-disc `2*(maxDepth*ringGap+margin)`. A small mesh no longer
  // opens as a few dots on a half-empty black square.
  width: number;
  height: number;
  maxDepth: number;
};

export type LayoutOpts = {
  // Radial distance between successive depth rings.
  ringGap: number;
  // Padding around the fitted node extent so glyphs + labels are not clipped.
  margin: number;
  // #578 — glyph radii + label metrics live in the opts so the LAYOUT (not the
  // modal) owns every dimension that feeds the fitted viewBox + the declutter.
  // The modal reads these back for the <circle r>, so there is ONE source.
  rootRadius: number;
  nodeRadius: number;
  // Clearance between a glyph edge and its label.
  labelGap: number;
  // Deterministic estimate of the rendered label size in viewBox units. The CSS
  // label is 11px `var(--font-mono)`; a monospace advance is ~0.6em, so
  // `labelCharWidth` ≈ 6.6 and `labelHeight` ≈ the font size. Estimating (vs
  // DOM getBBox) keeps radialLayout PURE + deterministic — the viewBox is an
  // attribute computed BEFORE paint, so a measure-then-resize loop is neither
  // testable nor race-free. A slightly generous estimate errs toward MORE
  // decluttering, never toward a visible overlap.
  labelCharWidth: number;
  labelHeight: number;
};

// #238 fix — ringGap cut 120→72 so the parent→child edges read short instead
// of stringy; paired with the bigger node radii (11/7 → 14/10) this lifts the
// glyph-to-edge ratio from ~17:1 to ~7:1 (dots you can actually hit, edges that
// don't dominate). #578 folds the display geometry (radii, label metrics) in
// here so the fitted viewBox + declutter are computed from the SAME numbers the
// modal renders with.
export const DEFAULT_LAYOUT_OPTS: LayoutOpts = {
  ringGap: 72,
  // #578 — margin is now pure breathing room around the FITTED extent (which
  // already includes each glyph + its label), so it dropped 80→32. The old 80
  // padded past the outermost RING to clear a label the box otherwise clipped;
  // that job now belongs to the extent union, and an 80-unit border would just
  // reprint the dead space the fit exists to kill.
  margin: 32,
  rootRadius: 14,
  nodeRadius: 10,
  labelGap: 4,
  labelCharWidth: 6.6,
  labelHeight: 12,
};

// Internal tree node built before geometry is assigned.
type TreeNode = {
  server: string;
  entry: LinksEntry;
  children: TreeNode[];
  depth: number;
  angle: number;
};

// Reconstruct the spanning tree from the flat entry list.
//
// Root selection (in priority order, all deterministic):
//   1. a self-linked node (`server === linked_to`) — the canonical ircd root;
//   2. else the node with the smallest hopcount;
//   3. else (empty hopcounts) the first entry.
// A node whose `linked_to` is absent from the set (a masked/partial reply)
// is re-parented to the root as an orphan, so no node is ever dropped. Cycles
// (a server listing itself or a mutual pair as uplinks) are broken by a
// visited-set during the depth walk — every node appears exactly once.
function buildTree(entries: LinksEntry[]): TreeNode | null {
  if (entries.length === 0) return null;

  // De-dupe by server name (last write wins — a repeated 364 is malformed but
  // must not fork the node). Keyed on the raw server string; IRC server names
  // are compared case-insensitively but the topology only needs identity here.
  const byServer = new Map<string, LinksEntry>();
  for (const e of entries) byServer.set(e.server, e);

  const rootEntry = selectRoot([...byServer.values()]);

  // Build children lists keyed by parent server. Deterministic child order:
  // sort by server name so the leaf-angle assignment is stable.
  const childrenOf = new Map<string, LinksEntry[]>();
  for (const e of byServer.values()) {
    if (e.server === rootEntry.server) continue;
    const parent =
      e.linked_to !== null && e.linked_to !== e.server && byServer.has(e.linked_to)
        ? e.linked_to
        : rootEntry.server; // orphan → attach to root
    const list = childrenOf.get(parent) ?? [];
    list.push(e);
    childrenOf.set(parent, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
  }

  const visited = new Set<string>();
  const build = (entry: LinksEntry, depth: number): TreeNode => {
    visited.add(entry.server);
    const kids = childrenOf.get(entry.server) ?? [];
    const children = kids
      .filter((k) => !visited.has(k.server)) // cycle break
      .map((k) => build(k, depth + 1));
    return { server: entry.server, entry, children, depth, angle: 0 };
  };

  const root = build(rootEntry, 0);

  // Sweep any node NOT reached by the walk from the root. A DISCONNECTED cycle
  // — every member's uplink points inside the cycle, so none is reachable from
  // the root — would otherwise vanish silently, breaking the "no node is ever
  // dropped" contract (the orphan re-parenting above only catches uplinks
  // ABSENT from the set, not a self-contained loop). Attach each straggler under
  // the root at depth 1; `build` itself breaks the stray's own cycle via
  // `visited`. Deterministic order (by server name).
  const strays = [...byServer.values()]
    .filter((e) => !visited.has(e.server))
    .sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
  for (const e of strays) {
    if (!visited.has(e.server)) root.children.push(build(e, 1));
  }

  return root;
}

function selectRoot(entries: LinksEntry[]): LinksEntry {
  // buildTree only calls this on a de-duped, non-empty list — make that
  // contract explicit so the first-entry fallback is a real LinksEntry, not
  // `T | undefined` under noUncheckedIndexedAccess.
  const first = entries[0];
  if (first === undefined) throw new Error("selectRoot: empty entries (buildTree guards this)");

  const selfLinked = entries.find((e) => e.linked_to === e.server);
  if (selfLinked !== undefined) return selfLinked;

  let best: LinksEntry | undefined;
  for (const e of entries) {
    if (e.hopcount === null) continue;
    if (best === undefined || best.hopcount === null || e.hopcount < best.hopcount) best = e;
  }
  return best ?? first;
}

// Assign a radial angle to every node: leaves get an equal slice of the full
// circle in DFS order; each internal node sits at the mean of its children's
// angles (the polar Reingold–Tilford tidy-tree simplification). Returns the
// leaf count so callers know the angular granularity.
function assignAngles(root: TreeNode): void {
  const leaves: TreeNode[] = [];
  const collectLeaves = (n: TreeNode): void => {
    if (n.children.length === 0) leaves.push(n);
    else for (const c of n.children) collectLeaves(c);
  };
  collectLeaves(root);

  // A lone root (no children) sits at angle 0 (placed at centre anyway).
  const leafCount = Math.max(leaves.length, 1);
  leaves.forEach((leaf, i) => {
    leaf.angle = ((i + 0.5) / leafCount) * Math.PI * 2;
  });

  // Post-order: internal node angle = mean of its children's (already set).
  const setInternal = (n: TreeNode): number => {
    if (n.children.length === 0) return n.angle;
    const sum = n.children.reduce((acc, c) => acc + setInternal(c), 0);
    n.angle = sum / n.children.length;
    return n.angle;
  };
  setInternal(root);
}

// Short label: the leftmost DNS label of the server name (irc.azzurra.org →
// "irc"), which reads better in the dense tree. The full name + description live
// in the modal's detail footer. Lives here (not the modal) so radialLayout can
// size + declutter the exact string that gets rendered. #578.
export function shortLabel(server: string): string {
  const dot = server.indexOf(".");
  return dot === -1 ? server : server.slice(0, dot);
}

// Glyph radius for a node — the root reads bigger. #578.
export function glyphRadius(node: { isRoot: boolean }, opts: LayoutOpts): number {
  return node.isRoot ? opts.rootRadius : opts.nodeRadius;
}

// #578 — choose a label's anchor + node-relative offset from the node's polar
// ANGLE, not a fixed centred-above placement. Collisions are a function of
// ANGULAR distance, not node count: a one-child internal node inherits its
// child's angle exactly, so parent + child land on the same ray one ring apart;
// centring both labels above their glyphs then stacks them. Swinging the label
// to the OUTWARD side (right for the east half, left for the west) breaks that
// pile-up for free, and near-vertical nodes keep the centred above/below
// placement (a side label there would collide with the ring neighbours). The
// root's radius is 0 so its angle is meaningless — it always centres above.
export function placeLabel(
  angle: number,
  isRoot: boolean,
  opts: LayoutOpts,
): { anchor: LabelAnchor; x: number; y: number } {
  const gap = opts.labelGap;
  if (isRoot) {
    return { anchor: "middle", x: 0, y: -(opts.rootRadius + gap) };
  }
  const off = opts.nodeRadius + gap;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Horizontal-dominant → outward side; vertical-dominant → centred above/below.
  if (Math.abs(c) >= Math.abs(s)) {
    // `y = labelHeight/3` nudges the side label to vertically straddle the glyph
    // (SVG text is baseline-anchored).
    return c >= 0
      ? { anchor: "start", x: off, y: opts.labelHeight / 3 } // east → right of glyph
      : { anchor: "end", x: -off, y: opts.labelHeight / 3 }; // west → left of glyph
  }
  // SVG y grows downward: sin<0 is up (north), sin>0 is down (south).
  return s < 0
    ? { anchor: "middle", x: 0, y: -off } // north → above
    : { anchor: "middle", x: 0, y: off + opts.labelHeight }; // south → below
}

// #578 — the ABSOLUTE (viewBox-unit) bounding box a node's label occupies, given
// its already-resolved placement fields. The declutter + the fitted viewBox both
// union these; the estimated text width is `label.length * labelCharWidth`. Pure
// so tests assert extent/overlap with the very function the layout fits with.
export function labelBox(
  node: {
    x: number;
    y: number;
    label: string;
    labelAnchor: LabelAnchor;
    labelX: number;
    labelY: number;
  },
  opts: LayoutOpts,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const textW = node.label.length * opts.labelCharWidth;
  const bx = node.x + node.labelX;
  const by = node.y + node.labelY;
  const minX =
    node.labelAnchor === "start" ? bx : node.labelAnchor === "end" ? bx - textW : bx - textW / 2;
  return { minX, maxX: minX + textW, minY: by - opts.labelHeight, maxY: by };
}

const boxesOverlap = (
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
  pad: number,
): boolean =>
  a.minX - pad < b.maxX && b.minX - pad < a.maxX && a.minY - pad < b.maxY && b.minY - pad < a.maxY;

// Public entry point: entries → fully positioned layout. Empty input yields an
// empty layout (the modal renders the "hidden topology" empty state instead).
export function radialLayout(entries: LinksEntry[], opts: LayoutOpts): Layout {
  const root = buildTree(entries);
  if (root === null) {
    return { nodes: [], edges: [], width: 0, height: 0, maxDepth: 0 };
  }

  assignAngles(root);

  let maxDepth = 0;
  const flat: TreeNode[] = [];
  const walk = (n: TreeNode): void => {
    flat.push(n);
    if (n.depth > maxDepth) maxDepth = n.depth;
    for (const c of n.children) walk(c);
  };
  walk(root);

  // Raw polar positions with the root at the ORIGIN (0,0); the fitted box is
  // shifted to a 0-origin viewBox at the end. Positioning around the origin (not
  // a pre-guessed `outer` centre) is what lets the box hug the REAL extent — the
  // #578 fix for a small mesh opening as a few dots on a mostly-black square.
  const nodes: LayoutNode[] = flat.map((n) => {
    const radius = n.depth * opts.ringGap;
    const isRoot = n.depth === 0;
    // Root sits at the origin (radius 0); cos/sin of its angle is irrelevant.
    const x = radius * Math.cos(n.angle);
    const y = radius * Math.sin(n.angle);
    const label = shortLabel(n.server);
    const place = placeLabel(n.angle, isRoot, opts);
    return {
      server: n.server,
      description: n.entry.description,
      hopcount: n.entry.hopcount,
      depth: n.depth,
      parent: isRoot ? null : n.entry.linked_to,
      isRoot,
      angle: n.angle,
      radius,
      x,
      y,
      label,
      labelAnchor: place.anchor,
      labelX: place.x,
      labelY: place.y,
      labelVisible: false, // resolved by the declutter pass below
    };
  });

  // Greedy declutter: place the root first (always kept), then by depth, then in
  // flat order. A candidate whose label box hits an already-placed one is
  // dropped. The label-anchor swing above minimises drops; this pass GUARANTEES
  // no two SURVIVING labels overlap. The hovered/selected node is force-shown by
  // the modal on top of this static baseline — dynamic state doesn't belong in
  // the pure layout. `labelGap` pad keeps a breathing gap around each box.
  const placed: ReturnType<typeof labelBox>[] = [];
  for (const n of [...nodes].sort((a, b) => a.depth - b.depth)) {
    const box = labelBox(n, opts);
    if (n.isRoot || !placed.some((p) => boxesOverlap(box, p, opts.labelGap))) {
      n.labelVisible = true;
      placed.push(box);
    }
  }

  // Fit the viewBox to the REAL extent: the union of every glyph disc and every
  // VISIBLE label box, grown by one margin on each side. Then translate all
  // coordinates so that extent's top-left maps to (0,0) — the modal renders a
  // `viewBox="0 0 width height"` and clampPan/viewBoxFit assume that origin, so
  // shifting the geometry (not the viewBox origin) keeps both intact.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of nodes) {
    const r = glyphRadius(n, opts);
    minX = Math.min(minX, n.x - r);
    minY = Math.min(minY, n.y - r);
    maxX = Math.max(maxX, n.x + r);
    maxY = Math.max(maxY, n.y + r);
    if (n.labelVisible) {
      const b = labelBox(n, opts);
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
  }

  const dx = opts.margin - minX;
  const dy = opts.margin - minY;
  const width = maxX - minX + 2 * opts.margin;
  const height = maxY - minY + 2 * opts.margin;
  for (const n of nodes) {
    n.x += dx;
    n.y += dy;
  }

  const posByServer = new Map(nodes.map((n) => [n.server, n]));
  const edges: LayoutEdge[] = [];
  const addEdges = (n: TreeNode): void => {
    const from = posByServer.get(n.server);
    for (const c of n.children) {
      const to = posByServer.get(c.server);
      if (from !== undefined && to !== undefined) {
        edges.push({ from: n.server, to: c.server, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
      }
      addEdges(c);
    }
  };
  addEdges(root);

  return { nodes, edges, width, height, maxDepth };
}

// Client-pixel → viewBox-unit mapping for the topology <svg>, laid out under
// `preserveAspectRatio="xMidYMid meet"`. `meet` scales the viewBox UNIFORMLY by
// the smaller of the two axis ratios, then CENTERS the drawn content (a
// letterbox gap on the larger axis). Getting both right is what keeps a
// wheel/pinch zoom anchored under the cursor and a drag locked to the finger on
// a NON-square canvas (i.e. every phone) — a naive per-axis ratio with no offset
// makes the map jump on zoom and lag on pan. Pure + DOM-free so LinksModal's
// interaction math is unit-testable (the gemello of pinchZoom.ts for #213, whose
// center-origin/clamped-pan model does NOT fit this free-pan viewBox surface).
export type ViewBoxFit = { scale: number; offsetX: number; offsetY: number };

export function viewBoxFit(clientW: number, clientH: number, vbW: number, vbH: number): ViewBoxFit {
  // A zero client/viewBox dimension (unmeasured ref, empty layout) degrades to
  // an identity 1:1 map rather than dividing by zero.
  const scale = Math.min(clientW / vbW, clientH / vbH) || 1;
  return { scale, offsetX: (clientW - vbW * scale) / 2, offsetY: (clientH - vbH * scale) / 2 };
}

// Map a point already made relative to the svg's client box (clientX - rect.left,
// clientY - rect.top) into viewBox units under the given fit.
export function clientToViewBox(
  relX: number,
  relY: number,
  fit: ViewBoxFit,
): { x: number; y: number } {
  return { x: (relX - fit.offsetX) / fit.scale, y: (relY - fit.offsetY) / fit.scale };
}

// #238 fix — bound the free-pan translate so the topology can't be dragged out
// of view (the pre-fix free-pan let a drag fling the whole map off-screen). The
// inner <g> transform is `translate(tx ty) scale(k)`, so content spanning
// [0, span] in viewBox units maps to [tx, tx + k*span]; the <svg viewBox="0 0
// width height"> under preserveAspectRatio="xMidYMid meet" always renders that
// WHOLE square, so keeping [tx, tx + k*span] overlapping [0, span] keeps the map
// framed. Pure viewBox math — no client box needed (meet guarantees the full
// viewBox is on screen). Two regimes fall out of one clamp: the scaled content
// SMALLER than the frame (k<1) stays fully inside; LARGER (k>1) pans only within
// its overflow. `slack = span - k*span`: k<1 → slack>0 → t∈[0, slack]; k>1 →
// slack<0 → t∈[slack, 0]; k==1 → t pinned to 0 (the map exactly fills the frame).
export function clampPan(
  tx: number,
  ty: number,
  k: number,
  layout: { width: number; height: number },
): { tx: number; ty: number } {
  const axis = (t: number, span: number): number => {
    const slack = span - k * span;
    const lo = Math.min(0, slack);
    const hi = Math.max(0, slack);
    return Math.min(hi, Math.max(lo, t));
  };
  return { tx: axis(tx, layout.width), ty: axis(ty, layout.height) };
}
