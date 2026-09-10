import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { hasUnseenTaskbarCompletion } from "./DesktopTaskbarUnreadCoordinator";

const environmentId = "environment-1" as EnvironmentId;
const threadId = "thread-1" as ThreadId;
const threadKey = `${environmentId}:${threadId}`;

function completedThread(
  overrides: Partial<
    Pick<EnvironmentThreadShell, "archivedAt" | "environmentId" | "id" | "latestTurn">
  > = {},
) {
  return {
    environmentId,
    id: threadId,
    archivedAt: null,
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-09-09T12:00:00.000Z",
      startedAt: "2026-09-09T12:00:01.000Z",
      completedAt: "2026-09-09T12:00:10.000Z",
      assistantMessageId: null,
    },
    ...overrides,
  } as Pick<EnvironmentThreadShell, "archivedAt" | "environmentId" | "id" | "latestTurn">;
}

describe("hasUnseenTaskbarCompletion", () => {
  it("clears after the completed thread is visited", () => {
    const threads = [completedThread()];

    expect(
      hasUnseenTaskbarCompletion(threads, {
        [threadKey]: "2026-09-09T12:00:05.000Z",
      }),
    ).toBe(true);
    expect(
      hasUnseenTaskbarCompletion(threads, {
        [threadKey]: "2026-09-09T12:00:10.000Z",
      }),
    ).toBe(false);
  });

  it("stays visible until every unseen completion is visited", () => {
    const secondThreadId = "thread-2" as ThreadId;
    const threads = [completedThread(), completedThread({ id: secondThreadId })];

    expect(
      hasUnseenTaskbarCompletion(threads, {
        [threadKey]: "2026-09-09T12:00:10.000Z",
        [`${environmentId}:${secondThreadId}`]: "2026-09-09T12:00:05.000Z",
      }),
    ).toBe(true);
  });

  it("ignores archived and never-visited historical threads", () => {
    expect(
      hasUnseenTaskbarCompletion([completedThread({ archivedAt: "2026-09-09T12:01:00.000Z" })], {
        [threadKey]: "2026-09-09T12:00:05.000Z",
      }),
    ).toBe(false);
    expect(hasUnseenTaskbarCompletion([completedThread()], {})).toBe(false);
  });
});
