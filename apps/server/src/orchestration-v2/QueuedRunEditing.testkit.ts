import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in queue editing tests"),
} satisfies ProviderAdapterV2["Service"];
export const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "queued-run-editing" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

export const createQueue = Effect.fnUntraced(function* (
  name: string,
  worktreePath: string | null = process.cwd(),
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${name}:create`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    modelSelection,
    createdBy: "user",
    creationSource: "web",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
  });
  for (const [index, text] of ["Active", "Original", "Later"].entries()) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${name}:message:${index}`),
      threadId,
      messageId: MessageId.make(`${name}:message:${index}`),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      modelSelection,
      dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
    });
  }
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const [active, queued, later] = projection.runs;
  assert.isDefined(active);
  assert.isDefined(queued);
  assert.isDefined(later);
  const editId = CommandId.make(`${name}:begin`);
  const begin = {
    type: "queued-run.edit.begin" as const,
    commandId: editId,
    threadId,
    runId: queued.id,
    previousEditId: null,
  };
  const complete = Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${name}:complete`),
          type: "run.updated",
          threadId,
          runId: active.id,
          providerInstanceId: active.providerInstanceId,
          occurredAt: now,
          payload: { ...active, status: "completed", completedAt: now },
        },
      ],
    });
    yield* orchestrator.resumeQueuedRuns;
  });
  return { orchestrator, threadId, active, queued, later, editId, begin, complete };
});
