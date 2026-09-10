import { assert, beforeEach, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const { createFromBitmap } = vi.hoisted(() => ({
  createFromBitmap: vi.fn(() => ({ kind: "unread-completion-overlay" })),
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBitmap },
}));

import { setWindowsTaskbarUnreadIndicator } from "./WindowsTaskbarBadge.ts";

function makeWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    setOverlayIcon: vi.fn(),
  };
}

describe("setWindowsTaskbarUnreadIndicator", () => {
  beforeEach(() => {
    createFromBitmap.mockClear();
  });

  it("sets and clears the Windows taskbar overlay", () => {
    const window = makeWindow();

    assert.isTrue(setWindowsTaskbarUnreadIndicator({ platform: "win32", window, visible: true }));
    assert.deepEqual(window.setOverlayIcon.mock.calls, [
      [{ kind: "unread-completion-overlay" }, "Completed thread awaiting review"],
    ]);

    assert.isTrue(setWindowsTaskbarUnreadIndicator({ platform: "win32", window, visible: false }));
    assert.deepEqual(window.setOverlayIcon.mock.calls[1], [null, ""]);
  });

  it("does nothing outside Windows or without a live window", () => {
    const window = makeWindow();
    const destroyedWindow = makeWindow(true);

    assert.isFalse(setWindowsTaskbarUnreadIndicator({ platform: "darwin", window, visible: true }));
    assert.isFalse(setWindowsTaskbarUnreadIndicator({ platform: "linux", window, visible: true }));
    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({ platform: "win32", window: null, visible: true }),
    );
    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "win32",
        window: destroyedWindow,
        visible: true,
      }),
    );
    assert.lengthOf(window.setOverlayIcon.mock.calls, 0);
    assert.lengthOf(destroyedWindow.setOverlayIcon.mock.calls, 0);
  });

  it("fails soft when Electron rejects the overlay", () => {
    const window = makeWindow();
    window.setOverlayIcon.mockImplementation(() => {
      throw new Error("overlay failed");
    });

    assert.isFalse(setWindowsTaskbarUnreadIndicator({ platform: "win32", window, visible: true }));
  });
});
