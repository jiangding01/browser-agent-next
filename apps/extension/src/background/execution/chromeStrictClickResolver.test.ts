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
        async sendInSession() {
          throw new Error("main-frame test 不应使用 child session");
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
      {
        bindingForFrame() {
          return {
            frameEpoch: "frame-a",
            cdpFrameId: "cdp-main",
            documentEpoch: "chrome-document:doc-a",
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
        async sendInSession() {
          throw new Error("main-frame test 不应使用 child session");
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
      {
        bindingForFrame() {
          return {
            frameEpoch: "frame-a",
            cdpFrameId: "cdp-main",
            documentEpoch: "chrome-document:doc-a",
          };
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

  it("OOPIF child live revalidation + projection 成功后生成顶层 prepared target", async () => {
    const refs = new InMemoryPersistentRefStore();
    const revision = "runtime:g1:t7-child";
    const ref = refs.getOrCreateLinked(
      [
        {
          source: "dom",
          tabId: 7,
          frameEpoch: "frame-child",
          stableId: "child-stable",
        },
        {
          source: "ax",
          tabId: 7,
          cdpFrameId: "cdp-child",
          documentEpoch: "chrome-document:doc-child",
          backendNodeId: 99,
        },
      ],
      "element",
      revision,
    );

    const observation: BrowserObservation = {
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
        documentEpoch: "chrome-document:doc-main",
        sequence: 1,
      },
      scope: { kind: "page" },
      coverage: {
        actionable: { status: "complete", returned: 1, totalKnown: 1 },
        forms: { status: "complete", returned: 0, totalKnown: 0 },
        text: { status: "unknown", returned: 0 },
        frames: { discovered: 2, accessible: 2, degraded: [] },
        shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
        canvas: { present: false, semanticallyCovered: false },
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
          documentEpoch: "chrome-document:doc-main",
          accessible: true,
        },
        {
          frameId: "web:2",
          parentFrameId: "web:0",
          documentEpoch: "chrome-document:doc-child",
          accessible: true,
        },
      ],
      elements: [
        {
          ref,
          kind: "element",
          semantic: { role: "button", name: "Child Save" },
          state: { visible: true, enabled: true, focused: false },
          frameId: "web:2",
          capabilities: [{ kind: "click" }],
          provenance: { dom: true, ax: true },
        },
      ],
    };

    const seen: string[] = [];
    const resolver = new ChromeStrictMainFrameClickResolver(
      refs,
      {
        async getAllFrames() {
          return [
            {
              frameId: 0,
              parentFrameId: -1,
              url: "https://fixture.test/",
              documentId: "doc-main",
            },
            {
              frameId: 2,
              parentFrameId: 0,
              url: "https://child.test/",
              documentId: "doc-child",
            },
          ];
        },
      },
      {
        async send() {
          throw new Error("child AX 不应发送到 root session");
        },
        async sendInSession(_tabId, sessionId, method) {
          seen.push("ax:" + sessionId + ":" + method);
          return {
            nodes: [{
              role: { value: "button" },
              name: { value: "Child Save" },
              backendDOMNodeId: 99,
              properties: [{
                name: "disabled",
                value: { value: false },
              }],
            }],
          } as never;
        },
      },
      {
        async stableIdsForBackendNodes(input) {
          seen.push("identity:" + (input.cdpSessionId ?? "root"));
          return new Map([[99, "child-stable"]]);
        },
      },
      {
        async inspect(input) {
          seen.push("dom:" + (input.cdpSessionId ?? "root"));
          return {
            visible: true,
            enabled: true,
            inViewport: true,
            hitTestable: true,
            rect: { x: 10, y: 20, width: 100, height: 30 },
            point: { x: 60, y: 35 },
          };
        },
      },
      {
        bindingForFrame(_tabId, frameId) {
          return frameId === "web:2"
            ? {
                frameEpoch: "frame-child",
                cdpFrameId: "cdp-child",
                cdpSessionId: "session-child",
                documentEpoch: "chrome-document:doc-child",
              }
            : undefined;
        },
      },
      {
        async project(input) {
          expect(input).toMatchObject({
            tabId: 7,
            targetFrameId: "web:2",
            point: { x: 60, y: 35 },
          });
          return {
            ok: true as const,
            point: { x: 260, y: 135 },
            rootFrameOwnerBackendNodeId: 500,
          };
        },
      },
    );

    const result = await resolver.resolve({
      tabId: 7,
      action: {
        actionId: "click-child",
        kind: "click",
        observedRevision: revision,
        target: { ref },
      },
      observation,
      expected: observation.elements[0]!,
    });

    expect(result).toMatchObject({
      documentCompatible: true,
      identityMatches: true,
      live: {
        semantic: {
          role: "button",
          name: "Child Save",
        },
      },
      prepared: {
        tabId: 7,
        ref,
        cdpFrameId: "cdp-child",
        cdpSessionId: "session-child",
        frameEpoch: "frame-child",
        coordinateSpace:
          "top-level-viewport",
        point: { x: 260, y: 135 },
      },
    });
    expect(seen).toEqual([
      "identity:session-child",
      "dom:session-child",
      "ax:session-child:Accessibility.getPartialAXTree",
    ]);
  });

  it("child projection fail closed 时不生成 prepared target", async () => {
    const refs = new InMemoryPersistentRefStore();
    const revision = "runtime:g1:t7-projection-fail";
    const ref = refs.getOrCreateLinked(
      [
        {
          source: "dom",
          tabId: 7,
          frameEpoch: "frame-child",
          stableId: "child-stable",
        },
        {
          source: "ax",
          tabId: 7,
          cdpFrameId: "cdp-child",
          documentEpoch: "chrome-document:doc-child",
          backendNodeId: 99,
        },
      ],
      "element",
      revision,
    );

    const observation: BrowserObservation = {
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
        documentEpoch: "chrome-document:doc-main",
        sequence: 1,
      },
      scope: { kind: "page" },
      coverage: {
        actionable: { status: "complete", returned: 1, totalKnown: 1 },
        forms: { status: "complete", returned: 0, totalKnown: 0 },
        text: { status: "unknown", returned: 0 },
        frames: { discovered: 2, accessible: 2, degraded: [] },
        shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
        canvas: { present: false, semanticallyCovered: false },
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
          documentEpoch: "chrome-document:doc-main",
          accessible: true,
        },
        {
          frameId: "web:2",
          parentFrameId: "web:0",
          documentEpoch: "chrome-document:doc-child",
          accessible: true,
        },
      ],
      elements: [{
        ref,
        kind: "element",
        semantic: { role: "button", name: "Child Save" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:2",
        capabilities: [{ kind: "click" }],
        provenance: { dom: true, ax: true },
      }],
    };

    const resolver = new ChromeStrictMainFrameClickResolver(
      refs,
      {
        async getAllFrames() {
          return [
            {
              frameId: 0,
              parentFrameId: -1,
              url: "https://fixture.test/",
              documentId: "doc-main",
            },
            {
              frameId: 2,
              parentFrameId: 0,
              url: "https://child.test/",
              documentId: "doc-child",
            },
          ];
        },
      },
      {
        async send() {
          throw new Error("child AX 不应发送到 root session");
        },
        async sendInSession() {
          return {
            nodes: [{
              role: { value: "button" },
              name: { value: "Child Save" },
              backendDOMNodeId: 99,
              properties: [{
                name: "disabled",
                value: { value: false },
              }],
            }],
          } as never;
        },
      },
      {
        async stableIdsForBackendNodes() {
          return new Map([[99, "child-stable"]]);
        },
      },
      {
        async inspect() {
          return {
            visible: true,
            enabled: true,
            inViewport: true,
            hitTestable: true,
            rect: { x: 10, y: 20, width: 100, height: 30 },
            point: { x: 60, y: 35 },
          };
        },
      },
      {
        bindingForFrame() {
          return {
            frameEpoch: "frame-child",
            cdpFrameId: "cdp-child",
            cdpSessionId: "session-child",
            documentEpoch: "chrome-document:doc-child",
          };
        },
      },
      {
        async project() {
          return {
            ok: false as const,
            reason: "root hit-test no longer reaches the projected frame owner",
          };
        },
      },
    );

    const result = await resolver.resolve({
      tabId: 7,
      action: {
        actionId: "click-child",
        kind: "click",
        observedRevision: revision,
        target: { ref },
      },
      observation,
      expected: observation.elements[0]!,
    });

    expect(result).toEqual({
      documentCompatible: true,
      identityMatches: false,
      reason:
        "child-frame coordinate projection failed: root hit-test no longer reaches the projected frame owner",
    });
  });

  it("child exact binding 与 retained identity 不一致时不进入 live CDP resolve", async () => {
    const refs = new InMemoryPersistentRefStore();
    const revision = "runtime:g1:t7-mismatch";
    const ref = refs.getOrCreateLinked(
      [
        {
          source: "dom",
          tabId: 7,
          frameEpoch: "frame-child",
          stableId: "child-stable",
        },
        {
          source: "ax",
          tabId: 7,
          cdpFrameId: "cdp-child",
          documentEpoch: "chrome-document:doc-child",
          backendNodeId: 99,
        },
      ],
      "element",
      revision,
    );

    const observation = {
      ...fixture(new InMemoryPersistentRefStore()).observation,
      revision: {
        id: revision,
        stateEpoch: "runtime",
        documentEpoch: "chrome-document:doc-main",
        sequence: 1,
      },
      frames: [
        {
          frameId: "web:0",
          documentEpoch: "chrome-document:doc-main",
          accessible: true,
        },
        {
          frameId: "web:2",
          parentFrameId: "web:0",
          documentEpoch: "chrome-document:doc-child",
          accessible: true,
        },
      ],
      elements: [{
        ref,
        kind: "element" as const,
        semantic: { role: "button", name: "Child Save" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:2",
        capabilities: [{ kind: "click" as const }],
        provenance: { dom: true, ax: true },
      }],
    } satisfies BrowserObservation;

    const resolver = new ChromeStrictMainFrameClickResolver(
      refs,
      {
        async getAllFrames() {
          return [
            {
              frameId: 0,
              parentFrameId: -1,
              url: "https://fixture.test/",
              documentId: "doc-main",
            },
            {
              frameId: 2,
              parentFrameId: 0,
              url: "https://child.test/",
              documentId: "doc-child",
            },
          ];
        },
      },
      {
        async send() {
          throw new Error("binding mismatch 后不应读取 CDP");
        },
        async sendInSession() {
          throw new Error("binding mismatch 后不应读取 child CDP");
        },
      },
      {
        async stableIdsForBackendNodes() {
          throw new Error("binding mismatch 后不应解析 identity");
        },
      },
      {
        async inspect() {
          throw new Error("binding mismatch 后不应 DOM inspect");
        },
      },
      {
        bindingForFrame() {
          return {
            frameEpoch: "WRONG",
            cdpFrameId: "cdp-child",
            cdpSessionId: "session-child",
            documentEpoch: "chrome-document:doc-child",
          };
        },
      },
    );

    await expect(
      new StoredObservationStrictCoordinator(
        new TabStateStore(),
        resolver,
      ).prepare(7, {
        actionId: "unused",
        kind: "click",
        observedRevision: revision,
        target: { ref },
      }),
    ).rejects.toMatchObject({
      code: "OBSERVATION_EXPIRED",
    });

    const direct = await resolver.resolve({
      tabId: 7,
      action: {
        actionId: "click-child",
        kind: "click",
        observedRevision: revision,
        target: { ref },
      },
      observation,
      expected: observation.elements[0]!,
    });

    expect(direct).toMatchObject({
      documentCompatible: true,
      identityMatches: false,
      reason:
        "stored exact frame binding does not match retained strong identity",
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
        async sendInSession() {
          throw new Error("main-frame test 不应使用 child session");
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
      {
        bindingForFrame() {
          return {
            frameEpoch: "frame-a",
            cdpFrameId: "cdp-main",
            documentEpoch: "chrome-document:doc-a",
          };
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
