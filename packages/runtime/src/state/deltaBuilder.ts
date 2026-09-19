import type {
  BrowserObservation,
  BrowserStateDelta,
  ElementState,
} from "@browser-agent-next/core";

export interface DeltaBuilderOptions {
  maxChanges?: number;
  maxChangeRatio?: number;
  minElementsForRatio?: number;
}

export type DeltaBuildResult =
  | { kind: "unchanged"; delta: BrowserStateDelta }
  | { kind: "delta"; delta: BrowserStateDelta }
  | { kind: "full"; reason: string };

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stableObservationMetadata(observation: BrowserObservation): unknown {
  return {
    tab: {
      tabId: observation.tab.tabId,
      url: observation.tab.url,
      origin: observation.tab.origin,
      ownedBySession: observation.tab.ownedBySession,
    },
    scope: observation.scope,
    coverage: observation.coverage,
    viewport: observation.viewport,
    frames: observation.frames,
    forms: observation.forms ?? null,
    capabilities: observation.capabilities ?? null,
    overlays: observation.overlays ?? null,
    dialogs: observation.dialogs ?? null,
  };
}

function elementPatch(element: ElementState): Partial<ElementState> {
  return {
    kind: element.kind,
    semantic: element.semantic,
    state: element.state,
    ...(element.value !== undefined ? { value: element.value } : {}),
    ...(element.geometry !== undefined ? { geometry: element.geometry } : {}),
    ...(element.component !== undefined ? { component: element.component } : {}),
    frameId: element.frameId,
    capabilities: element.capabilities,
    provenance: element.provenance,
  };
}

export function buildObservationDelta(
  previous: BrowserObservation,
  next: BrowserObservation,
  options: DeltaBuilderOptions = {},
): DeltaBuildResult {
  if (previous.tab.tabId !== next.tab.tabId) {
    return { kind: "full", reason: "tab-changed" };
  }

  if (previous.revision.stateEpoch !== next.revision.stateEpoch) {
    return { kind: "full", reason: "state-epoch-changed" };
  }

  if (previous.revision.documentEpoch !== next.revision.documentEpoch) {
    return { kind: "full", reason: "document-epoch-changed" };
  }

  if (!sameJson(stableObservationMetadata(previous), stableObservationMetadata(next))) {
    return { kind: "full", reason: "observation-metadata-changed" };
  }

  const before = new Map(previous.elements.map((element) => [element.ref, element]));
  const after = new Map(next.elements.map((element) => [element.ref, element]));
  const changes: BrowserStateDelta["changes"] = [];

  for (const [ref, oldElement] of before) {
    const newElement = after.get(ref);
    if (!newElement) {
      changes.push({ type: "remove", ref, reason: "not-present-in-next-observation" });
      continue;
    }

    if (!sameJson(oldElement, newElement)) {
      changes.push({ type: "update", ref, patch: elementPatch(newElement) });
    }
  }

  for (const [ref, newElement] of after) {
    if (!before.has(ref)) {
      changes.push({ type: "add", node: newElement });
    }
  }

  const delta: BrowserStateDelta = {
    baseRevision: previous.revision.id,
    revision: next.revision.id,
    changes,
  };

  if (changes.length === 0) {
    return { kind: "unchanged", delta };
  }

  const maxChanges = options.maxChanges ?? 200;
  const maxChangeRatio = options.maxChangeRatio ?? 0.6;
  const minElementsForRatio = options.minElementsForRatio ?? 20;

  if (!Number.isInteger(maxChanges) || maxChanges < 1) {
    throw new Error("maxChanges must be a positive integer");
  }
  if (!Number.isFinite(maxChangeRatio) || maxChangeRatio <= 0 || maxChangeRatio > 1) {
    throw new Error("maxChangeRatio must be within (0, 1]");
  }
  if (!Number.isInteger(minElementsForRatio) || minElementsForRatio < 1) {
    throw new Error("minElementsForRatio must be a positive integer");
  }

  if (changes.length > maxChanges) {
    return { kind: "full", reason: "delta-too-large" };
  }

  // Ratio is useful on large pages, but it is pathological on tiny pages:
  // one legitimate update on a one-button page is 100% of the page. Apply
  // the ratio guard only once the union action space is large enough.
  const distinctRefs = new Set([...before.keys(), ...after.keys()]).size;
  if (
    distinctRefs >= minElementsForRatio &&
    changes.length / distinctRefs > maxChangeRatio
  ) {
    return { kind: "full", reason: "delta-too-large" };
  }

  return { kind: "delta", delta };
}
