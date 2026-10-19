import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("../lib/uuid", () => ({ uuidv4: () => "saved-edit" }));
import {
  ChatAttachmentId,
  CommandId,
  EnvironmentId,
  ComposerContextId,
  MessageId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  beginQueuedRunEdit,
  recoverQueuedRunEdit,
  getQueuedRunEdit,
  forgetQueuedRunEdit,
  endQueuedRunEdit,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";
import { appAtomRegistry } from "./atom-registry";
import {
  composerDraftsAtom,
  decodePersistedComposerState,
  getComposerDraftSnapshot,
  replaceComposerDraftAttachments,
  setComposerDraftText,
} from "./use-composer-drafts";

const image = (id: string): ChatAttachment => ({
  type: "image",
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

function edit(attachments: ReadonlyArray<ChatAttachment>): QueuedRunEdit {
  return {
    editId: CommandId.make("edit-1"),
    sequence: 1,
    runId: RunId.make("run-1"),
    messageId: MessageId.make("message-1"),
    originalText: "original",
    existingAttachments: attachments,
  };
}

function context(attachmentIds: ReadonlyArray<string>): OrchestrationMessageContext {
  return {
    version: 1,
    records: attachmentIds.map((attachmentId, index) => ({
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`ctx-${index}`),
      label: `${attachmentId}.png`,
      attachmentId,
      name: `${attachmentId}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
    })),
  };
}

describe("queued edit draft key", () => {
  it("keeps the environment readable so attachment uploads still resolve it", () => {
    const key = queuedEditDraftKey("env-1:thread-9", "run-3");

    expect(isQueuedEditDraftKey(key)).toBe(true);
    expect(isQueuedEditDraftKey("env-1:thread-9")).toBe(false);
    expect(composerDraftEnvironmentId(key, [])).toBe("env-1");
  });
});

describe("resolveQueuedEditPayload", () => {
  it("restores owned edits after persisted draft hydration and across thread navigation", () => {
    vi.useFakeTimers();
    try {
      const first = "env:thread-reload";
      const second = "env:other-thread";
      appAtomRegistry.set(composerDraftsAtom, {});
      beginQueuedRunEdit(first, edit([]), []);
      setComposerDraftText(queuedEditDraftKey(first, "run-1"), "");
      beginQueuedRunEdit(second, { ...edit([]), editId: CommandId.make("edit-2") }, []);
      const restored = decodePersistedComposerState(
        JSON.parse(
          JSON.stringify({ schemaVersion: 1, drafts: appAtomRegistry.get(composerDraftsAtom) }),
        ),
      );
      appAtomRegistry.set(composerDraftsAtom, {});
      expect(getQueuedRunEdit(first)).toBeNull();
      appAtomRegistry.set(composerDraftsAtom, restored.drafts);
      expect(getQueuedRunEdit(first)?.editId).toBe("edit-1");
      expect(getQueuedRunEdit(second)?.editId).toBe("edit-2");
      expect(getComposerDraftSnapshot(queuedEditDraftKey(first, "run-1")).text).toBe("");
      endQueuedRunEdit(first);
      expect(getQueuedRunEdit(first)).toBeNull();
      expect(getQueuedRunEdit(second)?.editId).toBe("edit-2");
    } finally {
      appAtomRegistry.set(composerDraftsAtom, {});
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["text", "attachments"])(
    "keeps a retained edit separate from newer server %s",
    (change) => {
      vi.useFakeTimers();
      try {
        const threadKey = "env:stale-thread";
        const draftKey = queuedEditDraftKey(threadKey, "run-1");
        appAtomRegistry.set(composerDraftsAtom, {});
        beginQueuedRunEdit(threadKey, edit([]), []);
        setComposerDraftText(draftKey, "My older edit");
        forgetQueuedRunEdit(threadKey);
        beginQueuedRunEdit(threadKey, edit([]), []);
        expect(getComposerDraftSnapshot(draftKey).text).toBe("My older edit");
        forgetQueuedRunEdit(threadKey);
        const newer = {
          ...edit(change === "attachments" ? [image("new")] : []),
          originalText: change === "text" ? "New server text" : "original",
        };
        beginQueuedRunEdit(
          threadKey,
          newer,
          change === "attachments"
            ? [
                {
                  type: "image",
                  id: "new",
                  name: "new.png",
                  mimeType: "image/png",
                  sizeBytes: 10,
                  previewUri: "data:image/png;base64,YWJj",
                  dataUrl: "data:image/png;base64,YWJj",
                },
              ]
            : [],
        );
        expect(getComposerDraftSnapshot(draftKey).text).toBe(newer.originalText);
        expect(
          getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
        ).toEqual(change === "attachments" ? ["new"] : []);
        const retained = Object.entries(appAtomRegistry.get(composerDraftsAtom)).find(([key]) =>
          key.startsWith(`${draftKey}~saved~`),
        )?.[1];
        expect(retained?.text).toBe("My older edit");
        expect(retained?.queuedEdit?.ownership).toBeUndefined();
      } finally {
        appAtomRegistry.set(composerDraftsAtom, {});
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["attachment removal", "text edit"])(
    "recovers the selected attachments after %s and restart beside an occupied main draft",
    (change) => {
      vi.useFakeTimers();
      try {
        const threadKey = "env:thread";
        const editing = edit([image("first"), image("second")]);
        const draftKey = queuedEditDraftKey(threadKey, editing.runId);
        const main = { text: "Unrelated draft", attachments: [] };
        appAtomRegistry.set(composerDraftsAtom, { [threadKey]: main });
        beginQueuedRunEdit(
          threadKey,
          editing,
          editing.existingAttachments.map((attachment) => ({
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUri: "data:image/png;base64,YWJj",
            dataUrl: "data:image/png;base64,YWJj",
            uploadedAttachmentId: attachment.id,
            uploadEnvironmentId: EnvironmentId.make("env"),
            source: {
              kind: "snap-shot" as const,
              capturedAt: "2026-10-19T00:00:00.000Z",
              appName: "Browser",
              windowTitle: "Test",
            },
          })),
        );
        if (change === "attachment removal") {
          replaceComposerDraftAttachments(
            draftKey,
            getComposerDraftSnapshot(draftKey).attachments.filter(
              (attachment) => attachment.id !== "first",
            ),
          );
          expect(getComposerDraftSnapshot(draftKey).text).toBe(editing.originalText);
        } else setComposerDraftText(draftKey, "edited");
        expect(recoverQueuedRunEdit(threadKey)).toBe(true);
        expect(getQueuedRunEdit(threadKey)).toBeNull();
        const restored = decodePersistedComposerState(
          JSON.parse(
            JSON.stringify({ schemaVersion: 1, drafts: appAtomRegistry.get(composerDraftsAtom) }),
          ),
        );
        expect(restored.drafts[threadKey]).toEqual(main);
        expect(restored.drafts[draftKey]?.attachments.map((attachment) => attachment.id)).toEqual(
          change === "attachment removal" ? ["second"] : ["first", "second"],
        );
        expect(restored.drafts[draftKey]?.attachments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "second",
              uploadedAttachmentId: "second",
              uploadEnvironmentId: "env",
              source: expect.objectContaining({ kind: "snap-shot" }),
            }),
          ]),
        );
      } finally {
        appAtomRegistry.set(composerDraftsAtom, {});
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("resends the kept server attachments ahead of the newly uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: undefined,
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept", "uploaded"]);
  });

  it("rebinds context records from the draft's ids to the uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["draft-1"]),
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.context?.records).toEqual([
      expect.objectContaining({ attachmentId: "uploaded" }),
    ]);
  });

  it("drops the record of an attachment the user removed", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: context(["kept", "gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept"]);
    expect(payload.context?.records).toEqual([expect.objectContaining({ attachmentId: "kept" })]);
  });

  it("returns no context when every record lost its attachment", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments).toEqual([]);
    expect(payload.context).toBeUndefined();
  });
});
