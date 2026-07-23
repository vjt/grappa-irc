import { type Component, createSignal, type JSX, Show } from "solid-js";
import { dragHasFiles, dropUpload } from "./lib/dropUpload";

// #351 — whole-message-pane drag-and-drop upload target.
//
// Wraps the scrollback + compose stack (Shell composes ScrollbackPane +
// ComposeBox vertically inside `.shell-main`). A file dropped ANYWHERE over
// the pane uploads exactly as a drop on the compose box does today — the
// operator no longer has to aim at the small compose strip. The upload path
// is the shared `dropUpload` helper (backed by uploadOrchestrator), reused
// verbatim by ComposeBox — no duplicated orchestrator wiring.
//
// Layout: `.drop-upload-zone` is a transparent pass-through flex column
// (`flex: 1`) occupying the exact slot the stack used to fill directly, so
// `.scrollback-pane`'s `flex: 1` still grows within it and TopicBar /
// AudioMiniPlayer / ComposeBox keep their natural heights. `position:
// relative` anchors the overlay.
//
// Drag-depth counter: dragenter/dragleave fire once per child element the
// cursor crosses, so a naive boolean flickers the overlay off every time the
// cursor moves between scrollback rows. We count enter(+1)/leave(-1) and show
// the overlay while depth > 0 — stable until the drag truly leaves the pane
// (or drops). `depth` is plain instance state, not a signal: only its
// zero-crossing drives the reactive `dragging` signal.
//
// File-drag guard: ONLY file drags (`dataTransfer.types` includes "Files")
// arm the overlay, are counted, and are preventDefault'd. Dragging selected
// text or an in-app element over the pane is left entirely to native
// handling — no overlay, no swallowed drop.

export type Props = {
  networkSlug: string;
  channelName: string;
  children: JSX.Element;
};

const DropUploadZone: Component<Props> = (props) => {
  const [dragging, setDragging] = createSignal(false);
  let depth = 0;

  const reset = (): void => {
    depth = 0;
    setDragging(false);
  };

  const onDragEnter = (e: DragEvent): void => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth += 1;
    setDragging(true);
  };

  const onDragOver = (e: DragEvent): void => {
    // A file dragover MUST preventDefault or the browser rejects the drop.
    // Guarded so a text / in-app drag keeps its native drop behaviour.
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
  };

  const onDragLeave = (e: DragEvent): void => {
    if (!dragHasFiles(e.dataTransfer)) return;
    depth -= 1;
    if (depth <= 0) reset();
  };

  const onDrop = (e: DragEvent): void => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    reset();
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    dropUpload(files, props.networkSlug, props.channelName);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: passive file-drop surface; drag-drop has no keyboard equivalent — the keyboard-accessible upload path is ComposeBox's picker button + clipboard paste
    <div
      class="drop-upload-zone"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {props.children}
      {/* Purely visual affordance — aria-hidden + pointer-events:none in CSS
          so drag events keep reaching the underlying children (feeding the
          depth counter) and the drop lands on the zone. */}
      <Show when={dragging()}>
        <div class="drop-upload-overlay" aria-hidden="true">
          <span class="drop-upload-overlay-label">Drop to upload</span>
        </div>
      </Show>
    </div>
  );
};

export default DropUploadZone;
