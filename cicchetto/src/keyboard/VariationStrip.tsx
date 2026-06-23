import { type Component, For } from "solid-js";
import type { StripGeometry } from "./gesture";

export interface VariationStripProps {
  variants: string[];
  geom: StripGeometry;
  highlight: number | null;
}

const CELL_WIDTH = 44;

const VariationStrip: Component<VariationStripProps> = (props) => (
  <div
    class="kbd-strip"
    style={{
      top: `${props.geom.top}px`,
      left: `${Math.min(...props.geom.cellCentersX) - CELL_WIDTH / 2}px`,
      height: `${props.geom.bottom - props.geom.top}px`,
    }}
  >
    <For each={props.variants}>
      {(v, i) => (
        <div
          class={`kbd-strip-cell${props.highlight === i() ? " kbd-strip-cell--active" : ""}`}
          style={{ width: `${CELL_WIDTH}px` }}
        >
          {v}
        </div>
      )}
    </For>
  </div>
);

export default VariationStrip;
