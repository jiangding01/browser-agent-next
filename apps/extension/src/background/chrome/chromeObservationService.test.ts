import { describe, expect, it } from "vitest";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import {
  TabRevisionRegistry,
  TabStateStore,
} from "@browser-agent-next/runtime";
import { DomObservationCoordinator } from "../perception/observationCoordinator.js";
import { ChromeDomObservationService } from "./chromeObservationService.js";

describe("ChromeDomObservationService", () => {
  it("observes a real-Chrome-shaped tab through document-targeted messaging", async () => {
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
            url: "https://fixture.test/path",
          };
        },
        async sendMessage(_tabId, request: unknown, options) {
          const typed = request as { requestId: string };
          expect(options).toEqual({ documentId: "doc-main" });

          return {
            type: "perception.observe-dom.result",
            requestId: typed.requestId,
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
          };
        },
      },
      {
        async getAllFrames() {
          return [{
            frameId: 0,
            parentFrameId: -1,
            url: "https://fixture.test/path",
            documentId: "doc-main",
          }];
        },
      },
      coordinator,
    );

    const observation = await service.observe({
      tabId: 3,
      ownedBySession: true,
    });

    expect(observation.revision.documentEpoch).toBe(
      "chrome-document:doc-main",
    );
    expect(observation.viewport.width).toBe(1280);
    expect(observation.elements[0]).toMatchObject({
      ref: "@e_1",
      semantic: { name: "Save" },
    });
  });
});
