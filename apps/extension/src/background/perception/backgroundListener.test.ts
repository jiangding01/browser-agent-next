import { describe, expect, it, vi } from "vitest";
import { registerObserveTabBackgroundListener } from "./backgroundListener.js";
import { TabOwnershipRegistry } from "@browser-agent-next/runtime";
import type { ChromeDomObservationService } from "../chrome/chromeObservationService.js";

describe("registerObserveTabBackgroundListener", () => {
  it("accepts only own-extension typed observe requests", async () => {
    let listener:
      | ((
          message: unknown,
          sender: { id?: string },
          sendResponse: (response: unknown) => void,
        ) => boolean | void)
      | undefined;

    const runtime = {
      id: "extension-id",
      onMessage: {
        addListener(value: typeof listener) {
          listener = value;
        },
        removeListener: vi.fn(),
      },
    };

    const service = {
      async observe() {
        return {
          schemaVersion: 1 as const,
          tab: {
            tabId: 1,
            title: "Fixture",
            url: "https://fixture.test/",
            origin: "https://fixture.test",
            },
          revision: {
            id: "runtime:g1:t1",
            stateEpoch: "runtime",
            documentEpoch: "doc",
            sequence: 1,
          },
          scope: { kind: "page" as const },
          coverage: {
            actionable: { status: "complete" as const, returned: 0, totalKnown: 0 },
            forms: { status: "complete" as const, returned: 0, totalKnown: 0 },
            text: { status: "unknown" as const, returned: 0 },
            frames: { discovered: 1, accessible: 1, degraded: [] },
            shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
            canvas: { present: false, semanticallyCovered: false },
          },
          viewport: {
            width: 100,
            height: 100,
            scrollX: 0,
            scrollY: 0,
            scrollWidth: 100,
            scrollHeight: 100,
          },
          frames: [{
            frameId: "web:0",
            documentEpoch: "doc",
            accessible: true,
          }],
          elements: [],
        };
      },
    } as unknown as ChromeDomObservationService;

    const ownership = new TabOwnershipRegistry();
    registerObserveTabBackgroundListener(
      runtime,
      service,
      ownership,
    );

    const sendResponse = vi.fn();

    expect(
      listener?.(
        {
          type: "perception.observe-tab",
          requestId: "req-1",
          tabId: 1,
          ownedBySession: true,
        },
        { id: "other-extension" },
        sendResponse,
      ),
    ).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();

    expect(
      listener?.(
        {
          type: "perception.observe-tab",
          requestId: "req-1",
          tabId: 1,
          ownedBySession: true,
        },
        { id: "extension-id" },
        sendResponse,
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "perception.observe-tab.result",
          requestId: "req-1",
          ok: true,
        }),
      );
    });
  });
  it("拒绝 caller supplied ownedBySession，ownership 只能来自 registry", () => {
    let listener:
      | ((
          message: unknown,
          sender: { id?: string },
          sendResponse: (response: unknown) => void,
        ) => boolean | void)
      | undefined;

    const runtime = {
      id: "extension-id",
      onMessage: {
        addListener(value: typeof listener) {
          listener = value;
        },
        removeListener: vi.fn(),
      },
    };

    const observe = vi.fn();
    registerObserveTabBackgroundListener(
      runtime,
      { observe } as never,
      new TabOwnershipRegistry(),
    );

    const result = listener?.(
      {
        type: "perception.observe-tab",
        requestId: "spoof",
        tabId: 7,
        ownedBySession: true,
      },
      { id: "extension-id" },
      vi.fn(),
    );

    expect(result).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });
});
