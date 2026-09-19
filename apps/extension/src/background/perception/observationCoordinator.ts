import type {
  BrowserObservation,
  FrameState,
} from "@browser-agent-next/core";
import { createObservationAssembler } from "@browser-agent-next/perception";
import type { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import {
  buildObservationDelta,
  type TabRevisionRegistry,
  type TabStateStore,
} from "@browser-agent-next/runtime";
import {
  collectDomSource,
  type DomFrameTarget,
  type DomFrameTransport,
} from "./domCollector.js";

export interface DomFrameLifecycleRecorder {
  recordObserved(
    tabId: number,
    frameEpochByFrame: Readonly<Record<string, string>>,
  ): void;
}

export interface ObserveTabInput {
  tab: {
    tabId: number;
    title: string;
    url: string;
    origin: string;
    ownedBySession: boolean;
  };

  frames: FrameState[];
  domFrames: DomFrameTarget[];
  mainFrameId: string;
  mainDocumentEpoch: string;

  transport: DomFrameTransport;
  sinceRevision?: string;

  domOptions?: {
    maxElements?: number;
    includeValues?: boolean;
    includeOpenShadowRoots?: boolean;
  };
}

export class DomObservationCoordinator {
  private readonly assembler;

  constructor(
    refs: InMemoryPersistentRefStore,
    private readonly revisions: TabRevisionRegistry,
    private readonly states: TabStateStore,
    private readonly lifecycle?: DomFrameLifecycleRecorder,
  ) {
    this.assembler = createObservationAssembler(refs);
  }

  async observe(input: ObserveTabInput): Promise<BrowserObservation> {
    const requestId =
      "observe:t" + input.tab.tabId + ":" + Date.now().toString(36);

    const dom = await collectDomSource({
      tabId: input.tab.tabId,
      frames: input.domFrames,
      transport: input.transport,
      requestId,
      ...(input.domOptions !== undefined ? { options: input.domOptions } : {}),
    });

    const viewport = dom.viewportByFrame[input.mainFrameId];
    if (!viewport) {
      throw new Error("main frame DOM perception is unavailable");
    }

    const revision = this.revisions.next(
      input.tab.tabId,
      input.mainDocumentEpoch,
    );

    this.lifecycle?.recordObserved(
      input.tab.tabId,
      dom.frameEpochByFrame,
    );

    const observation = this.assembler.assemble({
      tab: input.tab,
      revision,
      scope: { kind: "page" },
      viewport,
      frames: input.frames,
      expectedSources: ["dom"],
      sources: [dom],
      shadowDom: {
        openRootsCovered: input.domOptions?.includeOpenShadowRoots !== false,
        closedRootsUnknown: true,
      },
      canvas: {
        present: false,
        semanticallyCovered: false,
      },
    });

    const previous =
      input.sinceRevision !== undefined
        ? this.states.get(input.tab.tabId, input.sinceRevision)
        : undefined;

    let finalObservation = observation;

    if (previous) {
      const delta = buildObservationDelta(previous.observation, observation);

      if (delta.kind === "delta" || delta.kind === "unchanged") {
        finalObservation = { ...observation, delta: delta.delta };
      } else {
        finalObservation = {
          ...observation,
          warnings: [
            ...(observation.warnings ?? []),
            "delta fallback to full observation: " + delta.reason,
          ],
        };
      }
    } else if (input.sinceRevision !== undefined) {
      finalObservation = {
        ...observation,
        warnings: [
          ...(observation.warnings ?? []),
          "delta baseline unavailable: " + input.sinceRevision,
        ],
      };
    }

    this.states.put(finalObservation);
    return finalObservation;
  }
}
