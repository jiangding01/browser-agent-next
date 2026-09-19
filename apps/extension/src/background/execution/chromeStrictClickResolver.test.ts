import { describe, expect, it } from "vitest";
import type { BrowserObservation } from "@browser-agent-next/core";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import {
  StoredObservationStrictCoordinator,
  TabStateStore,
} from "@browser-agent-next/runtime";
import { ChromeStrictMainFrameClickResolver } from "./chromeStrictClickResolver.js";

function fixture(
  refs: InMemoryPersistentRefStore,
): {
  observation: BrowserObservation;
  ref: string;
} {
  const revision = "runtime:g1:t7";
  const ref = refs.getOrCreateLinked(
    [
      {
        source: "dom",
        tabId: 7,
        frameEpoch: "frame-a",
        stableId: "s1",
      },
      {
        source: "ax",
        tabId: 7,
        cdpFrameId: "cdp-main",
        documentEpoch: "chrome-document:doc-a",
        backendNodeId: 42,
      },
    ],
    "element",
    revision,
  );

  return {
    ref,
    observation: {
      schemaVersion: 1,
      tab: {
        tabId: 7,
        title: "Fixture",
        url: "https://fixture.test/",
        origin: "https://fixture.test",
        ownedBySession: true,
      },
      revision: {
        id: revision,
        stateEpoch: "runtime",
        documentEpoch: "chrome-document:doc-a",
        sequence: 1,
      },
      scope: { kind: "page" },
      coverage: {
        actionable: {
          status: "complete",
          returned: 1,
          totalKnown: 1,
        },
        forms: {
          status: "complete",
          returned: 0,
          totalKnown: 0,
        },
        text: { status: "unknown", returned: 0 },
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
          semanticallyCovered: false,
        },
      },
      viewport: {
        width: 1280,
        height: 720,
        scrollX: 0,
        scrollY: 0,
        scrollWidth: 1280,
        scrollHeight: 720,
      },
      frames: [
        {
          frameId: "web:0",
          documentEpoch: "chrome-document:doc-a",
          accessible: true,
        },
      ],
      elements: [
        {
          ref,
          kind: "element",
          semantic: {
            role: "button",
            name: "Save",
          },
          state: {
            visible: true,
            enabled: true,
            focused: false,
          },
          frameId: "web:0",
          capabilities: [{ kind: "click" }],
          provenance: { dom: true, ax: true },
        },
      ],
    },
  };
}

function webNavigation(documentId = "doc-a") {
  return {
    async getAllFrames() {
      return [
        {
          frameId: 0,
          parentFrameId: -1,
          url: "https://fixture.test/",
          documentId,
        },
      ];
    },
  };
}

describe("ChromeStrictMainFrameClickResolver", () => {
  it("live DOM+AX identity 与语义均一致时生成 ephemeral click target", async () => {
    const refs = new InMemoryPersistentRefStore();
    const { observation, ref } = fixture(refs);
    const states = new TabStateStore();
    states.put(observation);

    const resolver = new ChromeStrictMainFrameClickResolver(
      refs,
      webNavigation(),
      {
        async send(_tabId, method) {
          if (method === "Page.getFrameTree") {
            return {
              frameTree: {
                frame: { id: "cdp-main" },
              },
            } as never;
          }

          return {
            nodes: [
              {
                role: { value: "button" },
                name: { value: "Save" },
                backendDOMNodeId: 42,
                properties: [
                  {
                    name: "disabled",
                    value: { value: false },
                  },
                ],
              },
            ],
          } as never;
        },
      },
      {
        async stableIdsForBackendNodes() {
          return new Map([[42, "s1"]]);
        },
      },
      {
        async inspect() {
          return {
            visible: true,
            enabled: true,
            inViewport: true,
            hitTestable: true,
            rect: {
              x: 10,
              y: 20,
              width: 100,
              height: 30,
            },
            point: {
              x: 60,
              y: 35,
            },
          };
        },
      },
    );

    const coordinator =
      new StoredObservationStrictCoordinator(
        states,
        resolver,
      );

    const prepared = await coordinator.prepare(7, {
      actionId: "click-1",
      kind: "click",
      observedRevision: observation.revision.id,
      target: { ref },
    });

    expect(prepared.prepared).toMatchObject({
      backendNodeId: 42,
      stableId: "s1",
      point: { x: 60, y: 35 },
    });
  });

  it("same-looking replacement 导致 backend→stableId 不一致时 fail closed", async () => {
    const refs = new InMemoryPersistentRefStore();
    const { observation, ref } = fixture(refs);
    const states = new TabStateStore();
    states.put(observation);

    const resolver = new ChromeStrictMainFrameClickResolver(
      refs,
      webNavigation(),
      {
        async send(_tabId, method) {
          if (method === "Page.getFrameTree") {
            return {
              frameTree: {
                frame: { id: "cdp-main" },
              },
            } as never;
          }
          throw new Error("不应读取 AX");
        },
      },
      {
        async stableIdsForBackendNodes() {
          return new Map([[42, "s2"]]);
        },
      },
      {
        async inspect() {
          throw new Error("不应执行 DOM inspection");
        },
      },
    );

    const coordinator =
      new StoredObservationStrictCoordinator(
        states,
        resolver,
      );

    await expect(
      coordinator.prepare(7, {
        actionId: "click-1",
        kind: "click",
        observedRevision: observation.revision.id,
        target: { ref },
      }),
    ).rejects.toMatchObject({
      code: "TARGET_IDENTITY_MISMATCH",
    });
  });

  it("main document epoch 改变时无需解析 target 即拒绝", async () => {
    const refs = new InMemoryPersistentRefStore();
    const { observation, ref } = fixture(refs);
    const states = new TabStateStore();
    states.put(observation);

    const resolver = new ChromeStrictMainFrameClickResolver(
      refs,
      webNavigation("doc-b"),
      {
        async send() {
          throw new Error("document mismatch 后不应执行 CDP target resolve");
        },
      },
      {
        async stableIdsForBackendNodes() {
          throw new Error("不应执行 identity bridge");
        },
      },
      {
        async inspect() {
          throw new Error("不应执行 DOM inspection");
        },
      },
    );

    const coordinator =
      new StoredObservationStrictCoordinator(
        states,
        resolver,
      );

    await expect(
      coordinator.prepare(7, {
        actionId: "click-1",
        kind: "click",
        observedRevision: observation.revision.id,
        target: { ref },
      }),
    ).rejects.toMatchObject({
      code: "DOCUMENT_CHANGED",
    });
  });
});
