import { assert, beforeEach, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const { createFromBuffer, overlayImage } = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
  overlayImage: { isEmpty: vi.fn(() => false) },
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer },
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
    createFromBuffer.mockReset();
    createFromBuffer.mockReturnValue(overlayImage);
    overlayImage.isEmpty.mockReset();
    overlayImage.isEmpty.mockReturnValue(false);
  });

  it("sets and clears the Windows taskbar overlay", () => {
    const window = makeWindow();
    const badgeDataUrl = "data:image/png;base64,one";

    assert.isTrue(
      setWindowsTaskbarUnreadIndicator({ platform: "win32", window, count: 1, badgeDataUrl }),
    );
    assert.deepEqual(createFromBuffer.mock.calls, [
      [Buffer.from("one", "base64"), { width: 64, height: 64, scaleFactor: 4 }],
    ]);
    assert.deepEqual(window.setOverlayIcon.mock.calls[0], [
      overlayImage,
      "1 completed thread awaiting review",
    ]);

    assert.isTrue(
      setWindowsTaskbarUnreadIndicator({
        platform: "win32",
        window,
        count: 0,
        badgeDataUrl: null,
      }),
    );
    assert.deepEqual(window.setOverlayIcon.mock.calls[1], [null, ""]);
  });

  it("caches decoded overlays", () => {
    const window = makeWindow();
    const badgeDataUrl = "data:image/png;base64,two";

    assert.isTrue(
      setWindowsTaskbarUnreadIndicator({ platform: "win32", window, count: 2, badgeDataUrl }),
    );
    assert.isTrue(
      setWindowsTaskbarUnreadIndicator({ platform: "win32", window, count: 2, badgeDataUrl }),
    );

    assert.equal(createFromBuffer.mock.calls.length, 1);
  });

  it("rejects missing, malformed, and empty badge images", () => {
    const window = makeWindow();

    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "win32",
        window,
        count: 1,
        badgeDataUrl: null,
      }),
    );
    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "win32",
        window,
        count: 1,
        badgeDataUrl: "data:image/svg+xml;base64,badge",
      }),
    );

    overlayImage.isEmpty.mockReturnValueOnce(true);
    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "win32",
        window,
        count: 1,
        badgeDataUrl: "data:image/png;base64,empty",
      }),
    );
    assert.lengthOf(window.setOverlayIcon.mock.calls, 0);
  });

  it("does nothing outside Windows or without a live window", () => {
    const window = makeWindow();
    const destroyedWindow = makeWindow(true);
    const badgeDataUrl = "data:image/png;base64,platform";

    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "darwin",
        window,
        count: 1,
        badgeDataUrl,
      }),
    );
    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "linux",
        window,
        count: 1,
        badgeDataUrl,
      }),
    );
    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "win32",
        window: null,
        count: 1,
        badgeDataUrl,
      }),
    );
    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "win32",
        window: destroyedWindow,
        count: 1,
        badgeDataUrl,
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

    assert.isFalse(
      setWindowsTaskbarUnreadIndicator({
        platform: "win32",
        window,
        count: 1,
        badgeDataUrl: "data:image/png;base64,failure",
      }),
    );
  });
});
