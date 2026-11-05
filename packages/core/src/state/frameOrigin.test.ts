import { describe, expect, it } from "vitest";
import type { BrowserObservation } from "./types.js";
import {
  FRAME_ORIGIN_MAX_LENGTH,
  allowedFrameOriginChain,
  effectiveFrameOrigin,
  frameOriginChain,
  isSerializedOrigin,
} from "./frameOrigin.js";

type Frames = BrowserObservation["frames"];

function observation(
  frames: Array<{
    frameId: string;
    parentFrameId?: string;
    url?: string;
    origin?: string;
    accessible?: boolean;
  }>,
  tabOrigin = "https://tab.test",
): Pick<BrowserObservation, "frames" | "tab"> {
  return {
    tab: { origin: tabOrigin } as BrowserObservation["tab"],
    frames: frames.map((frame) => ({ accessible: true, ...frame })) as unknown as Frames,
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

  it("returns undefined for a frame that is not in the observation or whose id is duplicated", () => {
    expect(effectiveFrameOrigin(observation([]), "missing")).toBeUndefined();
    expect(
      effectiveFrameOrigin(
        observation([
          { frameId: "root", url: "https://a.test/", origin: "https://a.test" },
          { frameId: "root", url: "https://evil.test/", origin: "https://evil.test" },
        ]),
        "root",
      ),
    ).toBeUndefined();
  });
});

describe("frameOriginChain", () => {
  const frames = observation([
    { frameId: "root", url: "https://a.test/page", origin: "https://a.test" },
    { frameId: "middle", parentFrameId: "root", url: "https://ads.test/x", origin: "https://ads.test" },
    { frameId: "target", parentFrameId: "middle", url: "https://a.test/confirm", origin: "https://a.test" },
    { frameId: "unreported", parentFrameId: "middle", url: "https://a.test/y" },
    { frameId: "under-unreported", parentFrameId: "unreported", url: "https://a.test/z", origin: "https://a.test" },
    { frameId: "orphan", parentFrameId: "gone", url: "https://a.test/o", origin: "https://a.test" },
  ]);

  it("lists the target frame first and the top frame last", () => {
    expect(frameOriginChain(frames, "target")).toEqual([
      "https://a.test",
      "https://ads.test",
      "https://a.test",
    ]);
    expect(frameOriginChain(frames, "root")).toEqual(["https://a.test"]);
  });

  it("returns undefined when any layer is undetermined, missing or cyclic", () => {
    expect(frameOriginChain(frames, "unreported")).toBeUndefined();
    expect(frameOriginChain(frames, "under-unreported")).toBeUndefined();
    expect(frameOriginChain(frames, "orphan")).toBeUndefined();
    expect(frameOriginChain(frames, "missing")).toBeUndefined();
    expect(
      frameOriginChain(
        observation([
          { frameId: "a", parentFrameId: "b", origin: "https://a.test" },
          { frameId: "b", parentFrameId: "a", origin: "https://a.test" },
        ]),
        "a",
      ),
    ).toBeUndefined();
  });
});

describe("frameOriginChain hardening", () => {
  it("rejects a chain through an inaccessible frame, so a projected top frame cannot fall back to the tab origin", () => {
    const projected = observation([
      // 出境投影把不放行的顶层标为不可访问并删去 url / origin。
      { frameId: "root", accessible: false },
      { frameId: "child", parentFrameId: "root", url: "https://a.test/x", origin: "https://a.test" },
    ], "https://a.test");

    expect(frameOriginChain(projected, "child")).toBeUndefined();
    expect(frameOriginChain(projected, "root")).toBeUndefined();
  });

  it("rejects observations whose frame ids are not unique", () => {
    // 取 origin 与找父 frame 不能分别命中两条同 id 记录。
    const duplicated = observation([
      { frameId: "web:1", parentFrameId: "web:2", origin: "https://a.test" },
      { frameId: "web:2", origin: "https://evil.test" },
      { frameId: "web:1", origin: "https://a.test" },
    ]);

    expect(frameOriginChain(duplicated, "web:1")).toBeUndefined();
  });
});

describe("allowedFrameOriginChain", () => {
  const frames = observation([
    { frameId: "root", url: "https://a.test/", origin: "https://a.test" },
    { frameId: "middle", parentFrameId: "root", origin: "https://b.test" },
    { frameId: "target", parentFrameId: "middle", origin: "https://a.test" },
    { frameId: "unreported", parentFrameId: "root", url: "https://a.test/x" },
  ], "https://a.test");
  const allow = (...origins: string[]) => (origin: string) => origins.includes(origin);

  it("returns the chain only when the tab origin and every layer are allowed", () => {
    expect(allowedFrameOriginChain(frames, "root", allow("https://a.test"))).toEqual(["https://a.test"]);
    expect(allowedFrameOriginChain(frames, "middle", allow("https://a.test"))).toBeUndefined();
    expect(allowedFrameOriginChain(frames, "target", allow("https://a.test"))).toBeUndefined();
    expect(allowedFrameOriginChain(frames, "target", allow("https://a.test", "https://b.test"))).toEqual([
      "https://a.test",
      "https://b.test",
      "https://a.test",
    ]);
  });

  it("checks the tab origin even when the top frame reported a different allowed origin", () => {
    const mismatched = observation([
      { frameId: "root", url: "https://a.test/", origin: "https://a.test" },
    ], "https://tab.test");
    expect(allowedFrameOriginChain(mismatched, "root", allow("https://a.test"))).toBeUndefined();
    expect(allowedFrameOriginChain(mismatched, "root", allow("https://a.test", "https://tab.test"))).toEqual([
      "https://a.test",
    ]);
  });

  it("rejects when the tab origin is not allowed or a layer is undetermined", () => {
    expect(allowedFrameOriginChain(frames, "middle", allow("https://b.test"))).toBeUndefined();
    expect(allowedFrameOriginChain(frames, "unreported", allow("https://a.test"))).toBeUndefined();
    expect(allowedFrameOriginChain(frames, "missing", allow("https://a.test"))).toBeUndefined();
  });
});

