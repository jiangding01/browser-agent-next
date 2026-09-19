import { describe, expect, it } from "vitest";
import {
  BrowserRuntimeError,
  type BrowserAction,
  type BrowserObservation,
} from "@browser-agent-next/core";
import { TabStateStore } from "../state/tabStateStore.js";
import { StoredObservationStrictCoordinator } from "./storedObservationStrictCoordinator.js";

function observation(): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "Fixture",
      url: "https://fixture.test/",
      origin: "https://fixture.test",
      ownedBySession: true,
    },
    revision: {
      id: "runtime:g1:t7",
      stateEpoch: "runtime",
      documentEpoch: "doc-a",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: 1, totalKnown: 1 },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
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
    frames: [
      {
        frameId: "web:0",
        documentEpoch: "doc-a",
        accessible: true,
      },
    ],
    elements: [
      {
        ref: "@e_1",
        kind: "element",
        semantic: { role: "button", name: "Save" },
        state: { visible: true, enabled: true, focused: false },
        frameId: "web:0",
        capabilities: [{ kind: "click" }],
        provenance: { dom: true, ax: true },
      },
    ],
  };
}

function clickAction(): BrowserAction {
  return {
    actionId: "a1",
    kind: "click",
    observedRevision: "runtime:g1:t7",
    target: { ref: "@e_1" },
  };
}

describe("StoredObservationStrictCoordinator", () => {
  it("只使用 stored observation 的 expected semantics", async () => {
    const states = new TabStateStore();
    states.put(observation());

    const coordinator = new StoredObservationStrictCoordinator(
      states,
      {
        async resolve({ expected }) {
          expect(expected.semantic).toEqual({
            role: "button",
            name: "Save",
          });

          return {
            documentCompatible: true as const,
            identityMatches: true as const,
            live: {
              semantic: { role: "button", name: "Save" },
              state: { visible: true, enabled: true },
              geometry: {
                inViewport: true,
                hitTestable: true,
              },
            },
            prepared: { x: 10, y: 20 },
          };
        },
      },
    );

    const prepared = await coordinator.prepare(
      7,
      clickAction(),
    );

    expect(prepared.prepared).toEqual({ x: 10, y: 20 });
  });

  it("ref 不属于指定 observation 时 fail closed", async () => {
    const states = new TabStateStore();
    states.put(observation());

    const coordinator = new StoredObservationStrictCoordinator(
      states,
      {
        async resolve() {
          throw new Error("不应执行 live resolver");
        },
      },
    );

    await expect(
      coordinator.prepare(7, {
        ...clickAction(),
        target: { ref: "@e_missing" },
      }),
    ).rejects.toMatchObject({
      code: "REF_NOT_IN_OBSERVATION",
    } satisfies Partial<BrowserRuntimeError>);
  });

  it("document identity 变化时在 semantic preflight 前拒绝", async () => {
    const states = new TabStateStore();
    states.put(observation());

    const coordinator = new StoredObservationStrictCoordinator(
      states,
      {
        async resolve() {
          return {
            documentCompatible: false as const,
            reason: "main document epoch changed",
          };
        },
      },
    );

    await expect(
      coordinator.prepare(7, clickAction()),
    ).rejects.toMatchObject({
      code: "DOCUMENT_CHANGED",
    } satisfies Partial<BrowserRuntimeError>);
  });

  it("same-looking replacement 由 strong identity mismatch 拒绝", async () => {
    const states = new TabStateStore();
    states.put(observation());

    const coordinator = new StoredObservationStrictCoordinator(
      states,
      {
        async resolve() {
          return {
            documentCompatible: true as const,
            identityMatches: false as const,
            reason: "backend node now resolves to a different stableId",
          };
        },
      },
    );

    await expect(
      coordinator.prepare(7, clickAction()),
    ).rejects.toMatchObject({
      code: "TARGET_IDENTITY_MISMATCH",
    } satisfies Partial<BrowserRuntimeError>);
  });
});
