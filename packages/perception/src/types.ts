import type {
  CoverageState,
  ElementCapability,
  ElementState,
  FrameState,
  StateRevision,
  ViewportState,
} from "@browser-agent-next/core";
import type { RefKind, StrongIdentity } from "@browser-agent-next/refs";

export type PerceptionSourceKind = "ax" | "dom" | "adapter";

export interface PerceptionElementCandidate {
  source: PerceptionSourceKind;

  /**
   * Strong browser identity owned by this source.
   */
  identity: StrongIdentity;

  /**
   * A cross-source correspondence key may only be emitted when the source
   * has strong evidence that two candidates are the same live object
   * (for example a shared backend node mapping). It must never be derived
   * from role/name/text similarity.
   */
  mergeKey?: string;

  kind: RefKind;

  semantic: Partial<ElementState["semantic"]>;

  state?: Partial<ElementState["state"]>;

  value?: ElementState["value"];
  geometry?: ElementState["geometry"];
  component?: ElementState["component"];

  frameId: string;
  capabilities?: ElementCapability[];
}

export interface PerceptionSourceCoverage {
  actionable: CoverageState;
  forms: CoverageState;
  text: CoverageState;
}

export interface PerceptionSourceResult {
  source: PerceptionSourceKind;
  coverage: PerceptionSourceCoverage;
  elements: PerceptionElementCandidate[];
  degradedFrames?: string[];
  warnings?: string[];
}

export interface ObservationAssemblyInput {
  tab: {
    tabId: number;
    title: string;
    url: string;
    origin: string;
    ownedBySession: boolean;
  };

  revision: StateRevision;

  scope: {
    kind: "page" | "region" | "ref";
    ref?: string;
    description?: string;
  };

  viewport: ViewportState;
  frames: FrameState[];

  /**
   * Every source expected to contribute to this observation must be listed.
   * An omitted expected source degrades coverage instead of silently
   * pretending the observation is complete.
   */
  expectedSources: PerceptionSourceKind[];

  sources: PerceptionSourceResult[];

  shadowDom: {
    openRootsCovered: boolean;
    closedRootsUnknown: boolean;
  };

  canvas: {
    present: boolean;
    semanticallyCovered: boolean;
  };
}
