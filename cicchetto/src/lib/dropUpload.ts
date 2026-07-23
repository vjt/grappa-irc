import { channelKey } from "./channelKey";
import { categoryOf } from "./uploadCategory";
import { triggerUploads } from "./uploadOrchestrator";

// #351 — shared drop/paste → upload entry point.
//
// Factored out of ComposeBox's `handleFiles` so the whole message pane
// (Shell's DropUploadZone) and the compose box share ONE orchestrator
// wiring instead of duplicating it: filter the batch to uploadable
// categories, then enqueue it for (networkSlug, channelName) via
// `triggerUploads`. A mixed drop (files + text) uploads only the files;
// a drop with no uploadable file — or an empty drop — is a no-op.
//
// The category filter here is the same one ComposeBox applied inline
// (`categoryOf(f.type) !== null`): it stops obviously-uninteresting
// payloads (random binaries) from opening the upload UI. Host accept-list
// + per-category cap checks stay in the orchestrator (one gate, one error
// surface).
export function dropUpload(files: File[], networkSlug: string, channelName: string): void {
  const uploadable = files.filter((f) => categoryOf(f.type) !== null);
  if (uploadable.length === 0) return;
  triggerUploads(channelKey(networkSlug, channelName), networkSlug, channelName, uploadable);
}

// #351 — does this drag carry files (vs. selected text / an in-app
// element)? The pane's drop overlay + drop handling engage ONLY for file
// drags, so dragging text over the pane never arms the affordance or
// swallows the drop. `DataTransfer.types` includes the literal "Files"
// marker whenever a file is part of the drag.
export function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  return dataTransfer.types.includes("Files");
}
