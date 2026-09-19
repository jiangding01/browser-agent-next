import { describe, expect, it } from "vitest";
import type { BrowserObservation } from "@browser-agent-next/core";
import {
  safeGlobMatches,
  verifyObservation,
} from "./observationVerifier.js";

function observation(
  actionable: BrowserObservation["coverage"]["actionable"]["status"] = "complete",
  text: BrowserObservation["coverage"]["text"]["status"] = "unknown",
): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "Saved - Fixture",
      url: "https://fixture.test/done?id=1",
      origin: "https://fixture.test",
      ownedBySession: true,
    },
    revision: {
      id: "rev-2",
      stateEpoch: "runtime-a",
      documentEpoch: "doc-a",
      sequence: 2,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: {
        status: actionable,
        returned: 1,
        ...(actionable === "complete"
          ? { totalKnown: 1 }
          : {}),
      },
      forms: {
        status: "complete",
        returned: 1,
        totalKnown: 1,
      },
      text: {
        status: text,
        returned: 0,
        ...(text === "complete"
          ? { totalKnown: 0 }
          : {}),
      },
      frames: {
        discovered: 1,
        accessible: 1,
        degraded: [],
      },
      shadowDom: {
        openRootsCovered: true,
        closedRootsUnknown: true,
      },
      canvas: {
        present: false,
        semanticallyCovered: true,
      },
    },
    viewport: {
      width: 1000,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1000,
      scrollHeight: 800,
    },
    frames: [{
      frameId: "web:0",
      documentEpoch: "doc-a",
      accessible: true,
    }],
    elements: [{
      ref: "@f_1",
      kind: "field",
      semantic: {
        role: "textbox",
        name: "工单标题",
      },
      state: {
        visible: true,
        enabled: true,
        focused: false,
      },
      value: {
        kind: "text",
        display: "已保存",
      },
      frameId: "web:0",
      capabilities: [{
        kind: "setValue",
        valueType: "text",
      }],
      provenance: {
        dom: true,
      },
    }],
  };
}

describe("safeGlobMatches", () => {
  it("支持 * / ?，但不是任意正则", () => {
    expect(
      safeGlobMatches(
        "https://fixture.test/done?id=1",
        "https://fixture.test/done*",
      ),
    ).toBe(true);

    expect(
      safeGlobMatches(
        "abc",
        "a?c",
      ),
    ).toBe(true);

    expect(
      safeGlobMatches(
        "aaa",
        "(a+)+$",
      ),
    ).toBe(false);
  });
});

describe("verifyObservation", () => {
  it("可以独立验证 URL 和 field value", () => {
    const result = verifyObservation(
      observation(),
      {
        mode: "all",
        conditions: [
          {
            type: "url_matches",
            pattern: "https://fixture.test/done*",
          },
          {
            type: "field_value",
            ref: "@f_1",
            equals: "已保存",
          },
        ],
      },
    );

    expect(result).toMatchObject({
      verified: true,
      conclusive: true,
      revision: "rev-2",
    });
  });

  it("complete action space 可以证明 ref_absent", () => {
    const result = verifyObservation(
      observation("complete"),
      {
        mode: "all",
        conditions: [{
          type: "ref_absent",
          ref: "@e_missing",
        }],
      },
    );

    expect(result).toMatchObject({
      verified: true,
      conclusive: true,
    });
  });

  it("partial action space 看不到 ref 时只能得到 inconclusive", () => {
    const result = verifyObservation(
      observation("partial"),
      {
        mode: "all",
        conditions: [{
          type: "ref_absent",
          ref: "@e_missing",
        }],
      },
    );

    expect(result).toMatchObject({
      verified: false,
      conclusive: false,
    });
  });

  it("text coverage 未完成时不能把没看到文本当成验证失败", () => {
    const result = verifyObservation(
      observation("complete", "unknown"),
      {
        mode: "all",
        conditions: [{
          type: "text_present",
          text: "不存在的文本",
        }],
      },
    );

    expect(result).toMatchObject({
      verified: false,
      conclusive: false,
    });
  });

  it("all 模式任一 conclusively false 即可 conclusively fail", () => {
    const result = verifyObservation(
      observation(),
      {
        mode: "all",
        conditions: [
          {
            type: "title_matches",
            pattern: "Wrong*",
          },
          {
            type: "download_started",
          },
        ],
      },
    );

    expect(result).toMatchObject({
      verified: false,
      conclusive: true,
    });
  });

  it("any 模式任一 conclusively true 即可 conclusively pass", () => {
    const result = verifyObservation(
      observation(),
      {
        mode: "any",
        conditions: [
          {
            type: "download_started",
          },
          {
            type: "title_matches",
            pattern: "Saved*",
          },
        ],
      },
    );

    expect(result).toMatchObject({
      verified: true,
      conclusive: true,
    });
  });
});
