import { describe, expect, it } from "vitest";
import type { BrowserObservation } from "@browser-agent-next/core";
import { effectiveFrameUrl } from "./frameOrigin.js";

type Frames = BrowserObservation["frames"];

function observation(
  frames: Array<{
    frameId: string;
    parentFrameId?: string;
    url?: string;
  }>,
): Pick<BrowserObservation, "frames" | "tab"> {
  return {
    tab: { origin: "https://tab.test" } as BrowserObservation["tab"],
    frames: frames as unknown as Frames,
  };
}

describe("effectiveFrameUrl", () => {
  it("顶层 frame 使用自身 url，缺 url 时回落到 tab origin", () => {
    expect(
      effectiveFrameUrl(
        observation([{ frameId: "root", url: "https://a.test/page" }]),
        "root",
      ),
    ).toBe("https://a.test/page");
    expect(
      effectiveFrameUrl(observation([{ frameId: "root" }]), "root"),
    ).toBe("https://tab.test");
  });

  it("about:blank / about:srcdoc 沿父链继承，可多级", () => {
    const frames = observation([
      { frameId: "root", url: "https://a.test/page" },
      { frameId: "blank", parentFrameId: "root", url: "about:blank" },
      { frameId: "srcdoc", parentFrameId: "blank", url: "about:srcdoc" },
    ]);

    expect(effectiveFrameUrl(frames, "blank")).toBe("https://a.test/page");
    expect(effectiveFrameUrl(frames, "srcdoc")).toBe("https://a.test/page");
  });

  it("子 frame 使用自身 url，不继承父 frame", () => {
    expect(
      effectiveFrameUrl(
        observation([
          { frameId: "root", url: "https://a.test/page" },
          { frameId: "child", parentFrameId: "root", url: "https://b.test/x" },
        ]),
        "child",
      ),
    ).toBe("https://b.test/x");
  });

  it("带 fragment 的 about:blank 不继承，按原值交给 allowlist 判定（fail closed）", () => {
    expect(
      effectiveFrameUrl(
        observation([
          { frameId: "root", url: "https://a.test/page" },
          { frameId: "blank", parentFrameId: "root", url: "about:blank#x" },
        ]),
        "blank",
      ),
    ).toBe("about:blank#x");
  });

  it("缺 url 的子 frame、不存在的 frame、断开的父链与成环都返回 undefined", () => {
    expect(
      effectiveFrameUrl(
        observation([
          { frameId: "root", url: "https://a.test/page" },
          { frameId: "child", parentFrameId: "root" },
        ]),
        "child",
      ),
    ).toBeUndefined();
    expect(
      effectiveFrameUrl(observation([]), "missing"),
    ).toBeUndefined();
    expect(
      effectiveFrameUrl(
        observation([
          { frameId: "blank", parentFrameId: "gone", url: "about:blank" },
        ]),
        "blank",
      ),
    ).toBeUndefined();
    expect(
      effectiveFrameUrl(
        observation([
          { frameId: "a", parentFrameId: "b", url: "about:blank" },
          { frameId: "b", parentFrameId: "a", url: "about:blank" },
        ]),
        "a",
      ),
    ).toBeUndefined();
  });
});
