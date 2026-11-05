import { describe, expect, it } from "vitest";
import type { BrowserObservation } from "./types.js";
import {
  FRAME_ORIGIN_MAX_LENGTH,
  effectiveFrameOrigin,
  isSerializedOrigin,
} from "./frameOrigin.js";

type Frames = BrowserObservation["frames"];

function observation(
  frames: Array<{
    frameId: string;
    parentFrameId?: string;
    url?: string;
    origin?: string;
  }>,
  tabOrigin = "https://tab.test",
): Pick<BrowserObservation, "frames" | "tab"> {
  return {
    tab: { origin: tabOrigin } as BrowserObservation["tab"],
    frames: frames as unknown as Frames,
  };
}

describe("isSerializedOrigin", () => {
  it.each(["null", "https://a.test", "http://127.0.0.1:4173", "http://[::1]:8080"])(
    "accepts %s",
    (value) => {
      expect(isSerializedOrigin(value)).toBe(true);
    },
  );

  it.each([
    ["path", "https://a.test/x"],
    ["trailing slash", "https://a.test/"],
    ["credentials", "https://u:p@a.test"],
    ["about:blank", "about:blank"],
    ["file scheme", "file://"],
    ["extension scheme", "chrome-extension://abc"],
    // Node 会把它们原样序列化为 origin：只有显式的 http(s) 检查能拒绝。
    ["websocket scheme", "ws://a.test"],
    ["ftp scheme", "ftp://a.test"],
    ["garbage", "not a url"],
    ["non-string", 7],
    ["too long", "https://" + "a".repeat(FRAME_ORIGIN_MAX_LENGTH) + ".test"],
  ])("rejects %s", (_label, value) => {
    expect(isSerializedOrigin(value)).toBe(false);
  });
});

describe("effectiveFrameOrigin", () => {
  it("uses the origin a frame reported about itself", () => {
    const frames = observation([
      { frameId: "root", url: "https://a.test/page", origin: "https://a.test" },
      // 跨源 frame 把同源兄弟导航到 about:blank：自报 origin 是导航发起方。
      { frameId: "hijacked", parentFrameId: "root", url: "about:blank", origin: "https://ads.test" },
      // 父文档自己创建的 about:blank / srcdoc：自报 origin 与父 frame 相同。
      { frameId: "editor", parentFrameId: "root", url: "about:blank", origin: "https://a.test" },
      { frameId: "srcdoc", parentFrameId: "root", url: "about:srcdoc", origin: "https://a.test" },
      { frameId: "child", parentFrameId: "root", url: "https://b.test/x", origin: "https://b.test" },
    ]);

    expect(effectiveFrameOrigin(frames, "root")).toBe("https://a.test");
    expect(effectiveFrameOrigin(frames, "hijacked")).toBe("https://ads.test");
    expect(effectiveFrameOrigin(frames, "editor")).toBe("https://a.test");
    expect(effectiveFrameOrigin(frames, "srcdoc")).toBe("https://a.test");
    expect(effectiveFrameOrigin(frames, "child")).toBe("https://b.test");
  });

  it("treats opaque or malformed reported origins as undetermined even when the URL looks same-origin", () => {
    const frames = observation([
      { frameId: "root", url: "https://a.test/page", origin: "null" },
      { frameId: "sandboxed", parentFrameId: "root", url: "https://a.test/ugc", origin: "null" },
      { frameId: "bad", parentFrameId: "root", url: "https://a.test/x", origin: "https://a.test/x" },
      { frameId: "file", parentFrameId: "root", url: "https://a.test/y", origin: "file://" },
    ]);

    for (const frameId of ["root", "sandboxed", "bad", "file"]) {
      expect(effectiveFrameOrigin(frames, frameId), frameId).toBeUndefined();
    }
  });

  it("never derives an unreported child frame's origin from its URL or its parent", () => {
    const frames = observation([
      { frameId: "root", url: "https://a.test/page", origin: "https://a.test" },
      { frameId: "http", parentFrameId: "root", url: "https://a.test/x" },
      { frameId: "srcdoc", parentFrameId: "root", url: "about:srcdoc" },
      { frameId: "blank", parentFrameId: "root", url: "about:blank" },
      { frameId: "missing-url", parentFrameId: "root" },
    ]);

    for (const frameId of ["http", "srcdoc", "blank", "missing-url"]) {
      expect(effectiveFrameOrigin(frames, frameId), frameId).toBeUndefined();
    }
  });

  it("falls back to the URL only for an unreported top frame", () => {
    expect(
      effectiveFrameOrigin(observation([{ frameId: "root", url: "https://a.test/page" }]), "root"),
    ).toBe("https://a.test");
    expect(effectiveFrameOrigin(observation([{ frameId: "root" }]), "root")).toBe(
      "https://tab.test",
    );
    expect(effectiveFrameOrigin(observation([{ frameId: "root" }], "null"), "root")).toBeUndefined();
    expect(
      effectiveFrameOrigin(observation([{ frameId: "root", url: "data:text/html,hi" }]), "root"),
    ).toBeUndefined();
    expect(
      effectiveFrameOrigin(observation([{ frameId: "root", url: "file:///tmp/x.html" }]), "root"),
    ).toBeUndefined();
  });

  it("returns undefined for a frame that is not in the observation", () => {
    expect(effectiveFrameOrigin(observation([]), "missing")).toBeUndefined();
  });
});
