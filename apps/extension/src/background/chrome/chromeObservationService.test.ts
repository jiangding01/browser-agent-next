import { describe, expect, it } from "vitest";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import {
  TabRevisionRegistry,
  TabStateStore,
} from "@browser-agent-next/runtime";
import { DomObservationCoordinator } from "../perception/observationCoordinator.js";
import { ChromeDomObservationService } from "./chromeObservationService.js";

function mainFrame(
  documentId = "doc-main",
  url = "https://fixture.test/path",
) {
  return [{
    frameId: 0,
    parentFrameId: -1,
    url,
    documentId,
  }];
}

function contentResponse(requestId: string) {
  return {
    type: "perception.observe-dom.result",
    requestId,
    ok: true,
    snapshot: {
      source: "dom",
      frameEpoch: "frame-epoch-main",
      viewport: {
        width: 1280,
        height: 720,
        scrollX: 0,
        scrollY: 0,
        scrollWidth: 1280,
        scrollHeight: 720,
      },
      elements: [{
        stableId: "s1",
        kind: "element",
        semantic: { role: "button", name: "Save" },
        state: { visible: true, enabled: true, focused: false },
        capabilities: [{ kind: "click" }],
      }],
      coverage: {
        actionable: { status: "complete", returned: 1, totalKnown: 1 },
        forms: { status: "complete", returned: 0, totalKnown: 0 },
        text: { status: "unknown", returned: 0, reason: "not-scanned" },
      },
      openShadowRootCount: 0,
    },
  } as const;
}

describe("ChromeDomObservationService", () => {
  it("binds canonical URL to the same catalog as documentId", async () => {
    const coordinator = new DomObservationCoordinator(
      new InMemoryPersistentRefStore(),
      new TabRevisionRegistry("runtime-a"),
      new TabStateStore(),
    );

    const service = new ChromeDomObservationService(
      {
        async get() {
          return {
            id: 3,
            title: "Fixture",
            url: "https://stale.example/",
          };
        },
        async sendMessage(_tabId, request: unknown, options) {
          const typed = request as { requestId: string };
          expect(options).toEqual({ documentId: "doc-main" });
          return contentResponse(typed.requestId);
        },
      },
      {
        async getAllFrames() {
          return mainFrame();
        },
      },
      coordinator,
    );

    const observation = await service.observe({
      tabId: 3,
      ownedBySession: true,
    });

    expect(observation.tab.url).toBe("https://fixture.test/path");
    expect(observation.revision.documentEpoch).toBe(
      "chrome-document:doc-main",
    );
  });

  it("rejects observation if navigation wins the collection race", async () => {
    const refs = new InMemoryPersistentRefStore();
    const states = new TabStateStore();
    const coordinator = new DomObservationCoordinator(
      refs,
      new TabRevisionRegistry("runtime-a"),
      states,
    );
    let discoveryCount = 0;

    const service = new ChromeDomObservationService(
      {
        async get() {
          return {
            id: 3,
            title: "Fixture",
            url: "https://fixture.test/path",
          };
        },
        async sendMessage(_tabId, request: unknown) {
          const typed = request as { requestId: string };
          return contentResponse(typed.requestId);
        },
      },
      {
        async getAllFrames() {
          discoveryCount += 1;
          return discoveryCount === 1
            ? mainFrame("doc-a")
            : mainFrame("doc-b");
        },
      },
      coordinator,
    );

    await expect(
      service.observe({
        tabId: 3,
        ownedBySession: true,
      }),
    ).rejects.toThrow(/changed during observation/);

    expect(states.revisionCount(3)).toBe(0);
    expect(refs.activeRecords()).toHaveLength(0);
  });
});
