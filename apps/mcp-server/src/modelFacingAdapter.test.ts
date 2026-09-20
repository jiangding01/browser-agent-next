import { describe, expect, it, vi } from "vitest";
import type {
  BrowserObservation,
  BrowserOpenInput,
  BrowserOpenResult,
  BrowserObserveInput,
  BrowserWaitResult,
  VerificationResult,
} from "@browser-agent-next/core";
import {
  ModelOriginAccessPolicy,
  ModelToolExposurePolicy,
} from "@browser-agent-next/policy";
import {
  ModelFacingBrowserAdapter,
  type ModelBrowserRuntimeClient,
} from "./modelFacingAdapter.js";

function observation(
  revision = "rev-1",
  options: {
    topText?: string;
    childText?: string;
    fieldValue?: string;
  } = {},
): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "Fixture",
      url: "https://allowed.test/page",
      origin: "https://allowed.test",
      ownedBySession: true,
    },
    revision: {
      id: revision,
      stateEpoch: "runtime",
      documentEpoch: "doc-1",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: 3, totalKnown: 3 },
      forms: { status: "complete", returned: 1, totalKnown: 1 },
      text: { status: "complete", returned: 3, totalKnown: 3 },
      frames: { discovered: 2, accessible: 2, degraded: [] },
      shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
      canvas: { present: false, semanticallyCovered: false },
    },
    viewport: {
      width: 1000,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1000,
      scrollHeight: 800,
    },
    frames: [
      {
        frameId: "web:0",
        url: "https://allowed.test/page",
        documentEpoch: "doc-1",
        accessible: true,
        degradedReason: "internal detail should not leak",
      },
      {
        frameId: "web:2",
        parentFrameId: "web:0",
        url: "https://blocked.test/embed",
        documentEpoch: "doc-child",
        accessible: true,
      },
    ],
    elements: [
      {
        ref: "@top",
        kind: "element",
        semantic: {
          role: "button",
          name: "Save",
          ...(options.topText ? { text: options.topText } : {}),
        },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "click" }],
        provenance: { dom: true },
      },
      {
        ref: "@field",
        kind: "field",
        semantic: { role: "textbox", name: "Email" },
        state: { visible: true, enabled: true, focused: false },
        value: {
          kind: "text",
          display: options.fieldValue ?? "secret@example.test",
        },
        frameId: "web:0",
        capabilities: [{ kind: "setValue" }],
        provenance: { dom: true },
      },
      {
        ref: "@child",
        kind: "content",
        semantic: {
          role: "text",
          text: options.childText ?? "third-party secret",
        },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:2",
        capabilities: [],
        provenance: { dom: true },
      },
    ],
    forms: [{ ref: "@form", fieldRefs: ["@field"], actionRefs: ["@top"] }],
    capabilities: [{
      id: "page-cap",
      origin: "https://allowed.test",
      frameId: "web:0",
      name: "Dangerous page declaration",
      inputSchema: { arbitrary: "page-controlled" },
      trust: "page-declared",
    }],
    overlays: [{ kind: "menu", blocking: false }],
    dialogs: [{ title: "Dialog", modal: true }],
    delta: {
      baseRevision: "old",
      revision,
      changes: [],
    },
    warnings: ["internal runtime warning with sensitive detail"],
  };
}

function adapter(
  runtime: ModelBrowserRuntimeClient,
  tools = [
    "browser.open",
    "browser.observe",
    "browser.extract",
    "browser.verify",
    "browser.wait",
  ],
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): ModelFacingBrowserAdapter {
  return new ModelFacingBrowserAdapter(runtime, {
    tools: new ModelToolExposurePolicy(tools),
    origins: new ModelOriginAccessPolicy({
      readOrigins: ["https://allowed.test"],
      navigationOrigins: ["https://allowed.test"],
    }),
    ...options,
  });
}

describe("ModelFacingBrowserAdapter", () => {
  it("tool exposure 先于 runtime dispatch，内部控制面名称不可达", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      open: vi.fn(),
      observe: vi.fn(),
    };
    const service = adapter(runtime, ["browser.observe"]);

    await expect(service.invoke("browser.open", {
      url: "https://allowed.test/",
    })).rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    await expect(service.invoke("authorization.issue-strict-click", {}))
      .rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.observe).not.toHaveBeenCalled();
  });

  it("browser.open 使用独立 model navigation allowlist", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      open: vi.fn(async (input: BrowserOpenInput): Promise<BrowserOpenResult> => ({
        tabId: 8,
        requestedUrl: input.url,
        ownedBySession: true,
      })),
      observe: vi.fn(),
    };
    const service = adapter(runtime);

    await expect(service.invoke("browser.open", {
      url: "https://blocked.test/",
    })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    await expect(service.invoke("browser.open", {
      url: "https://user:pass@allowed.test/",
    })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    await expect(service.invoke("browser.open", {
      url: "https://allowed.test/start",
    })).resolves.toMatchObject({ tabId: 8 });
  });

  it("observation 出境时默认移除 values/page capabilities/delta，并过滤未授权 child frame", async () => {
    let received: BrowserObserveInput | undefined;
    const runtime: ModelBrowserRuntimeClient = {
      async open() {
        throw new Error("unused");
      },
      async observe(input) {
        received = input;
        return observation();
      },
    };
    const service = adapter(runtime);

    const result = await service.invoke("browser.observe", {
      tabId: 7,
      options: {
        includeValues: true,
      },
    }) as BrowserObservation;

    expect(received).toMatchObject({
      tabId: 7,
      options: {
        maxElements: 100,
        maxAxElements: 100,
        includeValues: false,
      },
    });
    expect(result.elements.map((element) => element.ref)).toEqual([
      "@top",
      "@field",
    ]);
    expect(result.elements.find((element) => element.ref === "@field")?.value)
      .toBeUndefined();
    expect(result.frames[1]).toMatchObject({
      frameId: "web:2",
      accessible: false,
      degradedReason: "model-egress-origin-blocked",
    });
    expect(result.frames[1]?.url).toBeUndefined();
    expect(result.frames[0]?.degradedReason).toBe("runtime-frame-degraded");
    expect(result.coverage.actionable.status).toBe("partial");
    expect(result.coverage.text.status).toBe("partial");
    expect(result.capabilities).toBeUndefined();
    expect(result.delta).toBeUndefined();
    expect(result.forms).toBeUndefined();
    expect(result.dialogs).toBeUndefined();
    expect(result.warnings).toEqual([
      "model-egress omitted runtime warnings",
      "model-egress omitted page-declared capabilities",
      "model-egress omitted runtime delta",
      "model-egress filtered non-allowlisted frame content",
    ]);
  });

  it("extract/verify 只能使用已成功出境的 revision，并在投影状态上本地执行", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      async observe() { return observation(); },
    };
    const service = adapter(runtime);

    await expect(service.invoke("browser.extract", {
      tabId: 7,
      observedRevision: "rev-1",
    })).rejects.toMatchObject({ code: "MODEL_EGRESS_BLOCKED" });

    await service.invoke("browser.observe", { tabId: 7 });

    const extracted = await service.invoke("browser.extract", {
      tabId: 7,
      observedRevision: "rev-1",
    }) as { items: Array<{ ref: string }> };
    expect(extracted.items.map((item) => item.ref)).toEqual([
      "@top",
      "@field",
    ]);

    const hiddenText = await service.invoke("browser.verify", {
      tabId: 7,
      observedRevision: "rev-1",
      verification: {
        mode: "all",
        conditions: [{ type: "text_present", text: "third-party secret" }],
      },
    }) as VerificationResult;

    expect(hiddenText).toMatchObject({
      verified: false,
      conclusive: false,
    });
    expect(hiddenText.evidence[0]).not.toHaveProperty("observed");
  });

  it("默认 value redaction 阻止 field_value 通过 verify 旁路泄露", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      async observe() { return observation("rev-value", { fieldValue: "top-secret" }); },
    };
    const service = adapter(runtime);
    await service.invoke("browser.observe", { tabId: 7 });

    const result = await service.invoke("browser.verify", {
      tabId: 7,
      observedRevision: "rev-value",
      verification: {
        mode: "all",
        conditions: [{ type: "field_value", ref: "@field", equals: "top-secret" }],
      },
    }) as VerificationResult;

    expect(result.verified).toBe(false);
    expect(result.conclusive).toBe(false);
    expect(result.evidence[0]).not.toHaveProperty("observed");
  });

  it("sinceRevision 必须来自当前 model-visible ledger", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      observe: vi.fn(async () => observation()),
    };
    const service = adapter(runtime);

    await expect(service.invoke("browser.observe", {
      tabId: 7,
      sinceRevision: "internal-rev",
    })).rejects.toMatchObject({ code: "MODEL_EGRESS_BLOCKED" });
    expect(runtime.observe).not.toHaveBeenCalled();
  });

  it("wait 只在 model-egress 投影后的 observation 上验证", async () => {
    let now = 0;
    let attempt = 0;
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      async observe() {
        attempt += 1;
        return observation(
          "rev-" + attempt,
          attempt >= 2 ? { topText: "Done" } : { childText: "Done" },
        );
      },
    };
    const service = adapter(runtime, undefined, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    const result = await service.invoke("browser.wait", {
      tabId: 7,
      timeoutMs: 200,
      pollIntervalMs: 50,
      verification: {
        mode: "all",
        conditions: [{ type: "text_present", text: "Done" }],
      },
    }) as BrowserWaitResult;

    expect(result).toMatchObject({
      timedOut: false,
      attempts: 2,
      verification: { verified: true },
      observation: { revision: { id: "rev-2" } },
    });
  });

  it("拒绝未知字段和超过 egress 上限的 model 输入", async () => {
    const runtime: ModelBrowserRuntimeClient = {
      async open() { throw new Error("unused"); },
      async observe() { return observation(); },
    };
    const service = adapter(runtime);

    await expect(service.invoke("browser.observe", {
      tabId: 7,
      ownedBySession: true,
    })).rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    await expect(service.invoke("browser.observe", {
      tabId: 7,
      options: { maxElements: 101 },
    })).rejects.toMatchObject({ code: "MODEL_EGRESS_BLOCKED" });
  });
});
