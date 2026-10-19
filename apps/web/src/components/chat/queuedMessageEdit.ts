import { randomUUID } from "../../lib/utils";
import {
  queuedEditDraftMatchesSource,
  type QueuedRunEditDraft,
} from "@t3tools/client-runtime/state/queued-run-edit-draft";
import type {
  ChatAttachment,
  ChatImageAttachment,
  ChatFileAttachment,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  composerDraftHasUserContent,
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";

export async function prepareQueuedMessageEditDraft(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly edit: Pick<QueuedRunEditDraft, "runId" | "messageId" | "context"> &
    NonNullable<QueuedRunEditDraft["ownership"]>;
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly readImage: (attachment: ChatAttachment) => Promise<{ file: File; dataUrl: string }>;
}) {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(input.editTarget);
  const key = resolveComposerDraftKey(store, input.editTarget);
  if (key === null) throw new Error("Queued edit draft unavailable.");
  const matches = queuedEditDraftMatchesSource(existing?.queuedEdit, input.text, input.attachments);
  if (existing !== null && !matches) {
    const { queuedEdit, ...content } = existing;
    const retained = queuedEdit
      ? { ...content, queuedEdit: { ...queuedEdit, ownership: undefined } }
      : content;
    const next = { ...store.draftsByThreadKey, [`${key}:saved:${randomUUID()}`]: retained };
    delete next[key];
    useComposerDraftStore.setState({ draftsByThreadKey: next });
  }
  if (matches && existing?.queuedEdit) {
    const queuedEdit = existing.queuedEdit;
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [key]: {
          ...existing,
          queuedEdit: {
            ...queuedEdit,
            ownership: { editId: input.edit.editId, sequence: input.edit.sequence },
          },
        },
      },
    }));
    return;
  }
  if (
    input.attachments.some(
      (attachment) => attachment.type !== "image" && attachment.type !== "file",
    )
  )
    throw new Error("This attachment cannot be edited.");
  const images = await Promise.all(
    input.attachments
      .filter((attachment): attachment is ChatImageAttachment => attachment.type === "image")
      .map(async (image) => {
        const { file, dataUrl } = await input.readImage(image);
        return { ...image, file, previewUrl: dataUrl, dataUrl };
      }),
  );
  store.setPrompt(input.editTarget, input.text);
  store.addImages(input.editTarget, images, { allowDuplicates: true });
  await store.syncPersistedAttachments(input.editTarget, images);
  store.addFiles(
    input.editTarget,
    input.attachments
      .filter((attachment): attachment is ChatFileAttachment => attachment.type === "file")
      .map((file) => ({
        ...file,
        file: null,
        uploadedAttachmentId: file.id,
        uploadEnvironmentId: input.environmentId,
      })),
    { allowDuplicates: true, appendReference: true },
  );
  useComposerDraftStore.setState((state) => {
    const draft = state.draftsByThreadKey[key]!;
    return {
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [key]: {
          ...draft,
          queuedEdit: {
            runId: input.edit.runId,
            messageId: input.edit.messageId,
            sourceText: input.text,
            originalText: draft.prompt,
            originalAttachmentIds: input.attachments.map((attachment) => attachment.id),
            ...(input.edit.context ? { context: input.edit.context } : {}),
            ownership: { editId: input.edit.editId, sequence: input.edit.sequence },
          },
        },
      },
    };
  });
}

export function releaseQueuedMessageEditDraft(editTarget: ComposerThreadTarget) {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, editTarget);
  if (key === null) return;
  const draft = store.draftsByThreadKey[key];
  if (!draft?.queuedEdit) return;
  useComposerDraftStore.setState({
    draftsByThreadKey: {
      ...store.draftsByThreadKey,
      [key]: { ...draft, queuedEdit: { ...draft.queuedEdit, ownership: undefined } },
    },
  });
}

export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  readonly originalAttachmentIds?: ReadonlyArray<string>;
}): "kept" | "retained" | "clean" {
  releaseQueuedMessageEditDraft(input.editTarget);
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.editTarget);
  const dirty =
    draft !== null &&
    (draft.prompt !== input.originalText ||
      [...draft.images, ...draft.files].length !== (input.originalAttachmentIds?.length ?? 0) ||
      [...draft.images, ...draft.files].some(
        (attachment) => !input.originalAttachmentIds?.includes(attachment.id),
      ) ||
      draft.terminalContexts.length > 0 ||
      draft.reviewComments.length > 0 ||
      draft.previewAnnotations.length > 0 ||
      draft.threadContexts.length > 0);
  if (!dirty || draft === null) {
    store.clearComposerContent(input.editTarget);
    return "clean";
  }
  const fromKey = resolveComposerDraftKey(store, input.editTarget);
  const toKey = resolveComposerDraftKey(store, input.threadTarget);
  if (fromKey === null || toKey === null || fromKey === toKey) return "kept";
  const destination = store.getComposerDraft(input.threadTarget);
  if (composerDraftHasUserContent(destination)) return "retained";
  const { queuedEdit: _queuedEdit, ...recovered } = draft;
  const next = { ...store.draftsByThreadKey, [toKey]: recovered };
  delete next[fromKey];
  useComposerDraftStore.setState({ draftsByThreadKey: next });
  return "kept";
}

export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length)
    throw new Error("Retry or remove failed uploads before saving.");
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}
