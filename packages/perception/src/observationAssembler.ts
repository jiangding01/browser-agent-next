import type {
  BrowserObservation,
  CoverageState,
  ElementState,
  ObservationCoverage,
} from "@browser-agent-next/core";
import type { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import { mergePerceptionCandidates } from "./semanticMerge.js";
import type {
  ObservationAssemblyInput,
  PerceptionSourceKind,
  PerceptionSourceResult,
} from "./types.js";

type CoverageDimension = "actionable" | "forms" | "text";

function combineCoverage(
  expectedSources: readonly PerceptionSourceKind[],
  sources: readonly PerceptionSourceResult[],
  dimension: CoverageDimension,
  returned: number,
): CoverageState {
  const bySource = new Map(sources.map((source) => [source.source, source]));
  const missing = expectedSources.filter((source) => !bySource.has(source));

  if (missing.length > 0) {
    return {
      status: "unknown",
      returned,
      reason: "missing-expected-sources:" + missing.join(","),
    };
  }

  const states = expectedSources.map(
    (source) => bySource.get(source)!.coverage[dimension],
  );

  if (states.some((state) => state.status === "truncated")) {
    return {
      status: "truncated",
      returned,
      reason: "one-or-more-sources-truncated",
    };
  }

  if (states.some((state) => state.status === "partial")) {
    return {
      status: "partial",
      returned,
      reason: "one-or-more-sources-partial",
    };
  }

  if (states.some((state) => state.status === "unknown")) {
    return {
      status: "unknown",
      returned,
      reason: "one-or-more-sources-unknown",
    };
  }

  return {
    status: "complete",
    returned,
    totalKnown: returned,
  };
}

function buildCoverage(
  input: ObservationAssemblyInput,
  elements: readonly ElementState[],
): ObservationCoverage {
  const actionableCount = elements.filter(
    (element) =>
      (element.kind === "element" || element.kind === "field") &&
      element.capabilities.length > 0,
  ).length;

  const fieldCount = elements.filter(
    (element) => element.kind === "field",
  ).length;

  return {
    actionable: combineCoverage(
      input.expectedSources,
      input.sources,
      "actionable",
      actionableCount,
    ),
    forms: combineCoverage(
      input.expectedSources,
      input.sources,
      "forms",
      fieldCount,
    ),
    text: combineCoverage(
      input.expectedSources,
      input.sources,
      "text",
      0,
    ),
    frames: {
      discovered: input.frames.length,
      accessible: input.frames.filter((frame) => frame.accessible).length,
      degraded: [
        ...new Set(
          input.sources.flatMap((source) => source.degradedFrames ?? []),
        ),
      ],
    },
    shadowDom: input.shadowDom,
    canvas: input.canvas,
  };
}

export interface ObservationAssembler {
  assemble(input: ObservationAssemblyInput): BrowserObservation;
}

export function createObservationAssembler(
  refs: InMemoryPersistentRefStore,
): ObservationAssembler {
  return {
    assemble(input: ObservationAssemblyInput): BrowserObservation {
      const candidates = input.sources.flatMap((source) => source.elements);
      const merged = mergePerceptionCandidates(candidates);

      const elements: ElementState[] = merged.map((element) => {
        const ref = refs.getOrCreateLinked(
          element.identities,
          element.kind,
          input.revision.id,
        );

        return {
          ref,
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
      });

      const warnings = [
        ...input.sources.flatMap((source) => source.warnings ?? []),
        ...input.expectedSources
          .filter(
            (source) =>
              !input.sources.some((actual) => actual.source === source),
          )
          .map(
            (source) => "expected perception source missing: " + source,
          ),
      ];

      return {
        schemaVersion: 1,
        tab: input.tab,
        revision: input.revision,
        scope: input.scope,
        coverage: buildCoverage(input, elements),
        viewport: input.viewport,
        frames: input.frames,
        elements,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  };
}
