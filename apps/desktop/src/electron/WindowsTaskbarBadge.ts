import * as Electron from "electron";

const OVERLAY_SIZE = 16;
const OVERLAY_DESCRIPTION = "Completed thread awaiting review";

let unreadCompletionOverlay: Electron.NativeImage | undefined;

function getUnreadCompletionOverlay(): Electron.NativeImage {
  if (unreadCompletionOverlay !== undefined) {
    return unreadCompletionOverlay;
  }

  // The Windows bitmap representation is BGRA. Opaque pixels avoid
  // platform-specific alpha premultiplication while keeping the icon crisp.
  const bitmap = Buffer.alloc(OVERLAY_SIZE * OVERLAY_SIZE * 4);
  const center = (OVERLAY_SIZE - 1) / 2;
  for (let y = 0; y < OVERLAY_SIZE; y += 1) {
    for (let x = 0; x < OVERLAY_SIZE; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const offset = (y * OVERLAY_SIZE + x) * 4;
      if (distance <= 4.5) {
        bitmap.set([129, 185, 16, 255], offset);
      } else if (distance <= 6.25) {
        bitmap.set([255, 255, 255, 255], offset);
      }
    }
  }

  unreadCompletionOverlay = Electron.nativeImage.createFromBitmap(bitmap, {
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE,
  });
  return unreadCompletionOverlay;
}

export function setWindowsTaskbarUnreadIndicator(input: {
  readonly platform: NodeJS.Platform;
  readonly window: Pick<Electron.BrowserWindow, "isDestroyed" | "setOverlayIcon"> | null;
  readonly visible: boolean;
}): boolean {
  if (input.platform !== "win32" || input.window === null || input.window.isDestroyed()) {
    return false;
  }

  try {
    input.window.setOverlayIcon(
      input.visible ? getUnreadCompletionOverlay() : null,
      input.visible ? OVERLAY_DESCRIPTION : "",
    );
    return true;
  } catch {
    return false;
  }
}
