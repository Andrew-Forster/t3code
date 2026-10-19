import { CommandId, EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage });
});
afterAll(() => vi.unstubAllGlobals());
import {
  DraftId,
  useComposerDraftStore,
  partializeComposerDraftStoreState,
  hydrateImagesFromPersisted,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  prepareQueuedEditAttachments,
  prepareQueuedMessageEditDraft,
  recoverQueuedMessageEdit,
  releaseQueuedMessageEditDraft,
} from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const edit = {
  editId: CommandId.make("edit-1"),
  sequence: 1,
  runId: RunId.make("run-1"),
  messageId: MessageId.make("message-1"),
};

const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("retains saved attachments alongside newly uploaded files", async () => {
    const saved = { ...uploadedFile, id: "saved:earlier" };
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [saved],
      images: [],
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "unused",
    });
    expect(attachments).toEqual([saved, uploadedFile]);
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("keeps file-only edits when another client starts the queued run", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    store.addFiles(editTarget, [file]);
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("preserves uploaded file references when a remote queue advance interrupts the edit", () => {
    const store = useComposerDraftStore.getState();
    const uploaded = {
      ...file,
      file: null,
      uploadedAttachmentId: uploadedFile.id,
      uploadEnvironmentId: environmentId,
    };
    store.addFiles(editTarget, [uploaded]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([uploaded]);
  });

  it("does not overwrite a separate draft when the queued run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe(
      "retained",
    );
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)?.files).toEqual([file]);
  });

  it("restores ownership and dirty content through draft hydration, then releases locally", async () => {
    const store = useComposerDraftStore.getState();
    await prepareQueuedMessageEditDraft({
      editTarget,
      edit,
      environmentId,
      text: "Original",
      attachments: [],
      readImage: async () => {
        throw new Error("unused");
      },
    });
    store.setPrompt(editTarget, "");
    store.setPrompt(threadTarget, "Separate draft");
    const persisted = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    const merge = useComposerDraftStore.persist.getOptions().merge!;
    useComposerDraftStore.setState(merge(persisted, useComposerDraftStore.getState()));
    expect(store.getComposerDraft(editTarget)?.queuedEdit?.ownership).toEqual({
      editId: edit.editId,
      sequence: 1,
    });
    expect(store.getComposerDraft(editTarget)?.prompt).toBe("");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    releaseQueuedMessageEditDraft(editTarget);
    expect(store.getComposerDraft(editTarget)?.queuedEdit?.ownership).toBeUndefined();
  });

  it.each(["text", "attachments"])(
    "retains an older dirty edit separately when server %s changes",
    async (change) => {
      const store = useComposerDraftStore.getState();
      const prepare = (text: string, attachments: (typeof uploadedFile)[]) =>
        prepareQueuedMessageEditDraft({
          editTarget,
          edit,
          environmentId,
          text,
          attachments,
          readImage: async () => {
            throw new Error("unused");
          },
        });
      await prepare("Original", []);
      store.setPrompt(editTarget, "My older edit");
      releaseQueuedMessageEditDraft(editTarget);
      await prepare("Original", []);
      expect(store.getComposerDraft(editTarget)?.prompt).toBe("My older edit");
      releaseQueuedMessageEditDraft(editTarget);
      await prepare(
        change === "text" ? "New server text" : "Original",
        change === "attachments" ? [uploadedFile] : [],
      );
      const fresh = store.getComposerDraft(editTarget)!;
      expect(fresh.prompt).toContain(change === "text" ? "New server text" : "Original");
      expect(fresh.files.map((file) => file.id)).toEqual(
        change === "attachments" ? [uploadedFile.id] : [],
      );
      const retained = Object.entries(useComposerDraftStore.getState().draftsByThreadKey).find(
        ([key]) => key.startsWith(`${editTarget}:saved:`),
      )?.[1];
      expect(retained?.prompt).toBe("My older edit");
      expect(retained?.queuedEdit?.ownership).toBeUndefined();
    },
  );

  it.each(["attachment removal", "text edit"])(
    "recovers the selected server attachments after %s and restart",
    async (change) => {
      const store = useComposerDraftStore.getState();
      const first = {
        type: "image" as const,
        id: "saved:first",
        name: "first.png",
        mimeType: "image/png",
        sizeBytes: 5,
      };
      const second = { ...first, id: "saved:second", name: "second.png" };
      const savedFile = { ...uploadedFile, id: "saved:file" };
      const attachments = [first, second, savedFile];
      await prepareQueuedMessageEditDraft({
        editTarget,
        edit,
        environmentId,
        text: "Original message",
        attachments,
        readImage: async (attachment) => ({
          file: new File(["image"], attachment.name, { type: attachment.mimeType }),
          dataUrl: "data:image/png;base64,aW1hZ2U=",
        }),
      });
      const originalText = store.getComposerDraft(editTarget)!.prompt;
      store.setPrompt(threadTarget, "Unrelated main draft");
      if (change === "attachment removal") {
        store.removeImage(editTarget, first.id);
        expect(store.getComposerDraft(editTarget)?.prompt).toBe(originalText);
      } else store.setPrompt(editTarget, `${originalText} edited`);
      expect(
        recoverQueuedMessageEdit({
          editTarget,
          threadTarget,
          originalText,
          originalAttachmentIds: attachments.map((attachment) => attachment.id),
        }),
      ).toBe("retained");
      const persisted = JSON.parse(
        JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
      );
      expect(
        persisted.draftsByThreadKey["queued-edit:test"].attachments.map(
          (attachment: { id: string }) => attachment.id,
        ),
      ).toEqual(change === "attachment removal" ? [second.id] : [first.id, second.id]);
      expect(
        hydrateImagesFromPersisted(persisted.draftsByThreadKey["queued-edit:test"].attachments).map(
          (attachment) => attachment.id,
        ),
      ).toEqual(change === "attachment removal" ? [second.id] : [first.id, second.id]);
      expect(persisted.draftsByThreadKey["queued-edit:test"].files).toEqual([
        expect.objectContaining({ attachmentId: savedFile.id, environmentId }),
      ]);
      expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Unrelated main draft");
    },
  );
});
