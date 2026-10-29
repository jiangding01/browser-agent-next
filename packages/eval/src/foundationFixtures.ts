import type {
  BrowserObservation,
  ElementState,
} from "@browser-agent-next/core";

export interface ObservationFixtureOptions {
  revision?: string;
  documentEpoch?: string;
  stateEpoch?: string;
  url?: string;
  elements?: ElementState[];
  actionableCoverage?: BrowserObservation["coverage"]["actionable"];
  frames?: BrowserObservation["frames"];
  overlays?: BrowserObservation["overlays"];
  dialogs?: BrowserObservation["dialogs"];
}

export function fixtureButton(
  ref: string,
  name: string,
  options: {
    frameId?: string;
    enabled?: boolean;
    visible?: boolean;
    role?: string;
    description?: string;
    hitTestable?: boolean;
    kind?: ElementState["kind"];
    capabilities?: ElementState["capabilities"];
  } = {},
): ElementState {
  return {
    ref,
    kind: options.kind ?? "element",
    semantic: {
      role: options.role ?? "button",
      name,
      ...(options.description !== undefined
        ? { description: options.description }
        : {}),
    },
    state: {
      visible: options.visible ?? true,
      enabled: options.enabled ?? true,
      focused: false,
    },
    geometry: {
      rect: { x: 100, y: 100, width: 120, height: 36 },
      inViewport: true,
      hitTestable: options.hitTestable ?? true,
    },
    frameId: options.frameId ?? "main",
    capabilities: options.capabilities ?? [{ kind: "click" }],
    provenance: { ax: true, dom: true },
  };
}

export function fixtureObservation(
  options: ObservationFixtureOptions = {},
): BrowserObservation {
  const elements = options.elements ?? [fixtureButton("@e_1", "Continue")];
  const revision = options.revision ?? "r1";
  const documentEpoch = options.documentEpoch ?? "doc-a";

  return {
    schemaVersion: 1,
    tab: {
      tabId: 1,
      title: "Fixture",
      url: options.url ?? "https://fixture.test/",
      origin: "https://fixture.test",
      ownedBySession: true,
    },
    revision: {
      id: revision,
      stateEpoch: options.stateEpoch ?? "state-a",
      documentEpoch,
      sequence: Number(revision.replace(/\D+/g, "")) || 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: options.actionableCoverage ?? {
        status: "complete",
        returned: elements.length,
        totalKnown: elements.length,
      },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
      frames: { discovered: 1, accessible: 1, degraded: [] },
      shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
      canvas: { present: false, semanticallyCovered: true },
    },
    viewport: {
      width: 1280,
      height: 720,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1280,
      scrollHeight: 720,
    },
    frames: options.frames ?? [
      { frameId: "main", documentEpoch, accessible: true },
    ],
    elements,
    ...(options.overlays !== undefined
      ? { overlays: options.overlays }
      : {}),
    ...(options.dialogs !== undefined
      ? { dialogs: options.dialogs }
      : {}),
  };
}

export const foundationFixtures = {
  stableSemanticUpdate: {
    before: fixtureObservation({
      revision: "r1",
      elements: [fixtureButton("@e_1", "Continue")],
    }),
    after: fixtureObservation({
      revision: "r2",
      elements: [fixtureButton("@e_1", "Proceed")],
    }),
  },

  sameLookingReplacement: {
    before: fixtureObservation({
      revision: "r1",
      elements: [fixtureButton("@e_1", "Save")],
    }),
    after: fixtureObservation({
      revision: "r2",
      elements: [fixtureButton("@e_2", "Save")],
    }),
  },

  documentReplacement: {
    before: fixtureObservation({
      revision: "r1",
      documentEpoch: "doc-a",
      elements: [fixtureButton("@e_1", "Save")],
    }),
    after: fixtureObservation({
      revision: "r2",
      documentEpoch: "doc-b",
      elements: [fixtureButton("@e_2", "Save")],
    }),
  },

  truncatedActionSpace: fixtureObservation({
    revision: "r1",
    elements: [
      fixtureButton("@e_1", "上一页"),
      fixtureButton("@e_2", "下一页"),
    ],
    actionableCoverage: {
      status: "truncated",
      returned: 2,
      totalKnown: 120,
      reason: "fixture-output-cap",
    },
  }),

  mixedLanguage: fixtureObservation({
    revision: "r1",
    elements: [
      fixtureButton("@e_1", "创建工单"),
      fixtureButton("@e_2", "Open details"),
      fixtureButton("@e_3", "提交 Submit"),
    ],
  }),
} as const;
