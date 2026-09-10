import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useEffect, useMemo } from "react";

import { useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion } from "../Sidebar.logic";

type TaskbarUnreadThread = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "environmentId" | "id" | "latestTurn"
>;

export function hasUnseenTaskbarCompletion(
  threads: ReadonlyArray<TaskbarUnreadThread>,
  lastVisitedAtByThreadKey: Readonly<Record<string, string>>,
): boolean {
  return threads.some((thread) => {
    if (thread.archivedAt !== null) {
      return false;
    }
    const threadKey = scopedThreadKey({
      environmentId: thread.environmentId,
      threadId: thread.id,
    });
    return hasUnseenCompletion({
      latestTurn: thread.latestTurn,
      lastVisitedAt: lastVisitedAtByThreadKey[threadKey],
    });
  });
}

export function DesktopTaskbarUnreadCoordinator() {
  const threads = useThreadShells();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const visible = useMemo(
    () => hasUnseenTaskbarCompletion(threads, lastVisitedAtByThreadKey),
    [lastVisitedAtByThreadKey, threads],
  );
  const setIndicator = window.desktopBridge?.setTaskbarUnreadIndicator;

  useEffect(() => {
    if (setIndicator === undefined) {
      return;
    }
    void setIndicator({ visible }).catch(() => {});
  }, [setIndicator, visible]);

  useEffect(
    () => () => {
      void setIndicator?.({ visible: false }).catch(() => {});
    },
    [setIndicator],
  );

  return null;
}
