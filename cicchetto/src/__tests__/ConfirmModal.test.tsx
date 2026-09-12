import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "../ConfirmModal";
import { type ConfirmAttachment, dismissConfirm, requestConfirm } from "../lib/confirmDialog";
import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";

// #195 — the explicit confirm modal that replaces the removed #172
// hold-to-close gesture. Store-driven singleton: it renders whatever
// requestConfirm queued, fires the action ONLY on the affirmative button, and
// dismisses (without firing) on Cancel / backdrop / Esc.

describe("ConfirmModal (#195)", () => {
  afterEach(() => {
    dismissConfirm();
    __resetForTest();
  });

  it("renders nothing when no request is pending", () => {
    render(() => <ConfirmModal />);
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("renders the title + interpolated body when a request is pending", () => {
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "Leave channel",
      body: "Do you want to leave #italia?",
      confirmLabel: "Yes",
      onConfirm: vi.fn(),
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-modal-body").textContent).toBe(
      "Do you want to leave #italia?",
    );
    // The affirmative button shows the caller's label.
    expect(screen.getByTestId("confirm-modal-confirm").textContent).toBe("Yes");
  });

  it("the affirmative button fires the action and closes", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    fireEvent.click(screen.getByTestId("confirm-modal-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("Cancel dismisses WITHOUT firing the action", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    fireEvent.click(screen.getByTestId("confirm-modal-cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("backdrop click dismisses WITHOUT firing the action", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    fireEvent.click(screen.getByTestId("confirm-modal-backdrop"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  // #232 — Esc dismisses via the shared overlay stack (dismissConfirm, the
  // safe close verb) and never fires the carried action. runTopmostOverlayEscape
  // is the exact verb the global keydown listener invokes (focus-independent).
  it("Escape dismisses WITHOUT firing the action (shared overlay stack)", async () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    await waitFor(() => expect(overlayEscapeDepth()).toBe(1));
    expect(runTopmostOverlayEscape()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("confirm-modal")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // #816 — the optional THIRD button. A request may carry an alternative way
  // to get what the operator wanted (the paste guard's "send it as a .txt
  // upload"), offered ALONGSIDE Cancel and the affirmative. Two-button
  // requests must be unchanged: the button appears only when the request
  // carries one.
  describe("#816 — the alternative button", () => {
    it("is absent when the request carries no alternative", () => {
      render(() => <ConfirmModal />);
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm: vi.fn(),
        alternative: null,
        choice: null,
        attachments: null,
        defaultButton: "cancel",
      });
      expect(screen.queryByTestId("confirm-modal-alternative")).toBeNull();
    });

    it("renders the alternative's label and fires ONLY its action, then closes", () => {
      const onConfirm = vi.fn();
      const onSelect = vi.fn();
      render(() => <ConfirmModal />);
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Paste",
        onConfirm,
        alternative: { label: "Upload as .txt", onSelect },
        choice: null,
        attachments: null,
        defaultButton: "cancel",
      });
      const btn = screen.getByTestId("confirm-modal-alternative");
      expect(btn.textContent).toBe("Upload as .txt");
      fireEvent.click(btn);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(screen.queryByTestId("confirm-modal")).toBeNull();
    });
  });

  // 1883 — the OPTIONAL attachment list. A question about files cannot be
  // asked in a sentence: "Send this?" is only answerable if the operator can
  // see WHICH file. Text-only requests must be untouched — the list appears
  // only when the request carries one.
  describe("1883 — the attachment list", () => {
    const attachment = (over: Partial<ConfirmAttachment>): ConfirmAttachment => ({
      id: "a1",
      label: "cat.png",
      detail: "12 KB",
      preview: null,
      ...over,
    });

    const withAttachments = (items: ConfirmAttachment[], onRemove: (id: string) => void): void => {
      requestConfirm({
        title: "Send to #a?",
        body: "b",
        confirmLabel: "Send",
        onConfirm: vi.fn(),
        alternative: null,
        choice: null,
        attachments: { items: () => items, onRemove },
        defaultButton: "confirm",
      });
    };

    it("is absent when the request carries no attachments", () => {
      render(() => <ConfirmModal />);
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm: vi.fn(),
        alternative: null,
        choice: null,
        attachments: null,
        defaultButton: "cancel",
      });
      expect(screen.queryByTestId("confirm-modal-attachments")).toBeNull();
    });

    it("renders one row per attachment, with its label and detail", () => {
      render(() => <ConfirmModal />);
      withAttachments(
        [
          attachment({ id: "a1", label: "cat.png", detail: "12 KB" }),
          attachment({ id: "a2", label: "spec.pdf", detail: "2 KB" }),
        ],
        vi.fn(),
      );
      expect(screen.getAllByTestId("confirm-modal-attachment")).toHaveLength(2);
      expect(screen.getByText("spec.pdf")).toBeInTheDocument();
      expect(screen.getByText("2 KB")).toBeInTheDocument();
    });

    it("renders a thumbnail for a row that carries a picture, and none for one that does not", () => {
      render(() => <ConfirmModal />);
      withAttachments(
        [
          attachment({
            id: "a1",
            label: "cat.png",
            preview: { kind: "image", blob: new Blob(["x"], { type: "image/png" }) },
          }),
          attachment({ id: "a2", label: "spec.pdf", preview: null }),
        ],
        vi.fn(),
      );
      const thumbs = screen.getAllByTestId("confirm-modal-attachment-thumb");
      expect(thumbs).toHaveLength(1);
      // A real object URL, not a data: placeholder — the row is showing the
      // operator's own bytes back to them.
      expect(thumbs[0]?.getAttribute("src")).toMatch(/^blob:/);
    });

    it("the remove button reports the row's id and does NOT resolve the dialog", () => {
      const onRemove = vi.fn();
      render(() => <ConfirmModal />);
      withAttachments([attachment({ id: "a2", label: "drop.png" })], onRemove);

      fireEvent.click(screen.getByRole("button", { name: /remove drop\.png/i }));

      expect(onRemove).toHaveBeenCalledWith("a2");
      // Removing a file is not answering the question — the dialog stays.
      expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    });

    it("revokes a row's object URL when the dialog closes", () => {
      const revoke = vi.spyOn(URL, "revokeObjectURL");
      render(() => <ConfirmModal />);
      withAttachments(
        [attachment({ preview: { kind: "image", blob: new Blob(["x"], { type: "image/png" }) } })],
        vi.fn(),
      );
      const src = screen.getByTestId("confirm-modal-attachment-thumb").getAttribute("src");
      expect(src).toMatch(/^blob:/);

      dismissConfirm();

      expect(revoke).toHaveBeenCalledWith(src);
      revoke.mockRestore();
    });

    // #1964 — the preview is per KIND. Each arm below is a different element,
    // and the reason they are separate assertions rather than one loop is that
    // a wrong element is exactly the defect: a `<video>` rendered as an `<img>`
    // shows a broken-image glyph, which is what the issue reported.
    it("renders a video frame for a video row", () => {
      render(() => <ConfirmModal />);
      withAttachments(
        [
          attachment({
            label: "clip.mp4",
            preview: { kind: "video", blob: new Blob(["x"], { type: "video/mp4" }) },
          }),
        ],
        vi.fn(),
      );
      const video = screen.getByTestId("confirm-modal-attachment-video");
      // The media fragment is what asks for a frame instead of a black poster.
      expect(video.getAttribute("src")).toMatch(/^blob:.*#t=0\.1$/);
      // Playable, not a still: a video is a thing that moves, so checking the
      // operator picked the right take means watching it.
      expect(video.hasAttribute("controls")).toBe(true);
      expect(video.getAttribute("aria-label")).toBe("Play clip.mp4");
      // It is NOT the head thumbnail — a control bar is unusable at 2.5rem, so
      // it takes a full-width block under the row like the sound player.
      expect(screen.queryByTestId("confirm-modal-attachment-thumb")).toBeNull();
    });

    it("renders a player for an audio row — for sound, listening IS the preview", () => {
      render(() => <ConfirmModal />);
      withAttachments(
        [
          attachment({
            label: "song.mp3",
            preview: { kind: "audio", blob: new Blob(["x"], { type: "audio/mpeg" }) },
          }),
        ],
        vi.fn(),
      );
      const audio = screen.getByTestId("confirm-modal-attachment-audio");
      expect(audio.getAttribute("src")).toMatch(/^blob:/);
      // Operable, so it needs a name of its own: "audio" beside a filename the
      // operator cannot hear is not one.
      expect(audio.getAttribute("aria-label")).toBe("Play song.mp3");
    });

    it("renders the first lines of a text row — the paste case the issue was filed for", async () => {
      render(() => <ConfirmModal />);
      withAttachments(
        [
          attachment({
            label: "paste.txt",
            preview: {
              kind: "text",
              blob: new Blob(["alpha\nbeta\ngamma\ndelta\nepsilon\nzeta"], {
                type: "text/plain",
              }),
            },
          }),
        ],
        vi.fn(),
      );

      // Read asynchronously off the Blob, so the row paints before the lines do.
      const source = await screen.findByTestId("confirm-modal-attachment-source");
      expect(source.textContent).toContain("alpha");
      expect(source.textContent).toContain("delta");
      // Capped at TEXT_PREVIEW_LINES: this is a HEAD, not the file.
      expect(source.textContent).not.toContain("epsilon");
    });

    // A text row renders a <pre> of lines read from the Blob, so a URL there
    // would pin the Blob for the dialog's life and be handed to nothing.
    it("mints no object URL for a text row", async () => {
      const create = vi.spyOn(URL, "createObjectURL");
      render(() => <ConfirmModal />);
      withAttachments(
        [
          attachment({
            label: "paste.txt",
            preview: { kind: "text", blob: new Blob(["a\nb"], { type: "text/plain" }) },
          }),
        ],
        vi.fn(),
      );

      await screen.findByTestId("confirm-modal-attachment-source");
      expect(create).not.toHaveBeenCalled();
      create.mockRestore();
    });

    // The row that cannot be previewed shows NO box at all. #1883's neutral ☐
    // glyph kept rows the same height, but it reads as a picture that failed
    // to load — a different claim from "this type has no viewer" — and the
    // rows stopped being uniform when audio and text previews arrived.
    it("a row with nothing renderable shows no box at all, and mints no URL", () => {
      const create = vi.spyOn(URL, "createObjectURL");
      render(() => <ConfirmModal />);
      withAttachments(
        [attachment({ label: "spec.pdf", detail: "2 KB · preview not supported", preview: null })],
        vi.fn(),
      );

      expect(screen.getByText("2 KB · preview not supported")).toBeInTheDocument();
      expect(document.querySelector(".confirm-modal-attachment-icon")).toBeNull();
      expect(screen.queryByTestId("confirm-modal-attachment-thumb")).toBeNull();
      expect(screen.queryByTestId("confirm-modal-attachment-video")).toBeNull();
      expect(screen.queryByTestId("confirm-modal-attachment-audio")).toBeNull();
      expect(screen.queryByTestId("confirm-modal-attachment-source")).toBeNull();
      expect(create).not.toHaveBeenCalled();
      create.mockRestore();
    });
  });

  // #1964 — what a bare Enter answers. #195 focused Cancel unconditionally;
  // the upload confirm is the one dialog whose Cancel loses work, so the
  // request now names its own default and the modal focuses that button.
  describe("#1964 — the default button", () => {
    const openWith = (defaultButton: "cancel" | "confirm", onConfirm: () => void): void => {
      requestConfirm({
        title: "Send to #a?",
        body: "b",
        confirmLabel: "Send",
        onConfirm,
        alternative: null,
        choice: null,
        attachments: null,
        defaultButton,
      });
    };

    it("focuses Cancel by default, so a stray Enter dismisses", async () => {
      const onConfirm = vi.fn();
      render(() => <ConfirmModal />);
      openWith("cancel", onConfirm);

      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("confirm-modal-cancel")),
      );
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("focuses the affirmative when the request asks for it, so Enter sends", async () => {
      const onConfirm = vi.fn();
      render(() => <ConfirmModal />);
      openWith("confirm", onConfirm);

      const send = screen.getByTestId("confirm-modal-confirm");
      await waitFor(() => expect(document.activeElement).toBe(send));

      // The browser turns Enter on a focused button into a click; asserting the
      // click is asserting the outcome that reaches the operator.
      fireEvent.click(send);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    // Measured in the browser during #1964, not reasoned: the × the operator
    // presses unmounts with its row, focus falls to <body>, and the next Enter
    // answers nothing — in the one dialog where Enter is meant to send.
    it("hands focus back to the default button after a row is removed", async () => {
      const items = [
        { id: "a1", label: "one.png", detail: "1 KB", preview: null },
        { id: "a2", label: "two.png", detail: "1 KB", preview: null },
      ];
      render(() => <ConfirmModal />);
      requestConfirm({
        title: "Send to #a?",
        body: "b",
        confirmLabel: "Send",
        onConfirm: vi.fn(),
        alternative: null,
        choice: null,
        attachments: {
          items: () => items,
          onRemove: (id: string): void => {
            const at = items.findIndex((i) => i.id === id);
            if (at >= 0) items.splice(at, 1);
          },
        },
        defaultButton: "confirm",
      });

      const remove = screen.getByRole("button", { name: /remove one\.png/i });
      remove.focus();
      fireEvent.click(remove);

      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("confirm-modal-confirm")),
      );
    });

    // The paste path: the guard's third door clears the store and opens the
    // send confirm in the SAME tick, so the modal never observes a closed
    // state between them. An open/closed edge guard left focus on the old
    // dialog's Cancel — which is the button that discards the upload.
    it("re-focuses when one request REPLACES another without the dialog closing", async () => {
      render(() => <ConfirmModal />);
      openWith("cancel", vi.fn());
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("confirm-modal-cancel")),
      );

      openWith("confirm", vi.fn());

      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("confirm-modal-confirm")),
      );
    });
  });
  // #2094 — the optional single choice. The store carries a pre-formatted
  // control; this component only has to show it, name it, and report back.
  describe("the single choice (#2094)", () => {
    const openWithChoice = (value: () => string, onSelect: (v: string) => void): void =>
      requestConfirm({
        title: "Send to #a?",
        body: "b",
        confirmLabel: "Send",
        onConfirm: vi.fn(),
        alternative: null,
        choice: {
          label: "Delete after",
          options: [
            { value: "3600", label: "1 hour" },
            { value: "86400", label: "24 hours" },
          ],
          value,
          onSelect,
        },
        attachments: null,
        defaultButton: "confirm",
      });

    it("renders nothing when the request carries no choice", () => {
      render(() => <ConfirmModal />);
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm: vi.fn(),
        alternative: null,
        choice: null,
        attachments: null,
        defaultButton: "cancel",
      });
      expect(screen.queryByTestId("confirm-modal-choice")).toBeNull();
    });

    it("shows the options and the current selection", () => {
      render(() => <ConfirmModal />);
      openWithChoice(() => "86400", vi.fn());

      const select = screen.getByTestId("confirm-modal-choice-select") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual(["1 hour", "24 hours"]);
      expect(select.value).toBe("86400");
    });

    // A bare dropdown reading "24 hours" says nothing about what happens then,
    // which is why this one carries a visible label — and the label IS the
    // accessible name, so there is exactly one.
    it("names the control visibly, and only once", () => {
      render(() => <ConfirmModal />);
      openWithChoice(() => "3600", vi.fn());

      expect(screen.getByTestId("confirm-modal-choice").textContent).toContain("Delete after");
      expect(screen.getByLabelText("Delete after")).toBe(
        screen.getByTestId("confirm-modal-choice-select"),
      );
    });

    it("reports a pick back to the caller, which owns the value", () => {
      const onSelect = vi.fn();
      render(() => <ConfirmModal />);
      openWithChoice(() => "86400", onSelect);

      fireEvent.change(screen.getByTestId("confirm-modal-choice-select"), {
        target: { value: "3600" },
      });

      expect(onSelect).toHaveBeenCalledWith("3600");
    });

    // Reactive, like the attachment list: the caller's signal changing must
    // re-render the selection WITHOUT the request being replaced, which would
    // re-run the open transition and steal focus back to the default button.
    it("follows the caller's value without the request being replaced", async () => {
      const [value, setValue] = createSignal("86400");
      render(() => <ConfirmModal />);
      openWithChoice(value, setValue);

      fireEvent.change(screen.getByTestId("confirm-modal-choice-select"), {
        target: { value: "3600" },
      });

      await waitFor(() =>
        expect((screen.getByTestId("confirm-modal-choice-select") as HTMLSelectElement).value).toBe(
          "3600",
        ),
      );
      // Still the same dialog, still answering with Enter on Send.
      expect(document.activeElement).toBe(screen.getByTestId("confirm-modal-confirm"));
    });
  });
});
