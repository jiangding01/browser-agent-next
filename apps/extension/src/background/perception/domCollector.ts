import type {
  CoverageState,
} from "@browser-agent-next/core";
import type {
  PerceptionSourceResult,
} from "@browser-agent-next/perception";
import type {
  ObserveDomFrameRequest,
  ObserveDomFrameResponse,
} from "../../protocol/perception.js";
import { adaptDomFrameSnapshot } from "./domSourceAdapter.js";

export interface DomFrameTarget {
  frameId: string;
  accessible: boolean;
}

export interface DomFrameTransport {
  send(
    tabId: number,
    frameId: string,
    request: ObserveDomFrameRequest,
  ): Promise<ObserveDomFrameResponse>;
}

export interface CollectDomSourceInput {
  tabId: number;
  frames: DomFrameTarget[];
  transport: DomFrameTransport;
  requestId: string;
  options?: ObserveDomFrameRequest["options"];
}

function combineFrameCoverage(
  states: CoverageState[],
  returned: number,
  failedFrameCount: number,
): CoverageState {
  if (failedFrameCount > 0) {
    return {
      status: "partial",
      returned,
      reason: "one-or-more-frames-unavailable",
    };
  }

  if (states.some((state) => state.status === "truncated")) {
    return {
      status: "truncated",
      returned,
      totalKnown: states.every((state) => state.totalKnown !== undefined)
        ? states.reduce((sum, state) => sum + (state.totalKnown ?? 0), 0)
        : undefined,
      reason: "one-or-more-frames-truncated",
    };
  }

  if (states.some((state) => state.status === "partial")) {
    return {
      status: "partial",
      returned,
      reason: "one-or-more-frames-partial",
    };
  }

  if (states.some((state) => state.status === "unknown")) {
    return {
      status: "unknown",
      returned,
      reason: "one-or-more-frames-unknown",
    };
  }

  return {
    status: "complete",
    returned,
    totalKnown: states.reduce((sum, state) => sum + (state.totalKnown ?? state.returned), 0),
  };
}

export async function collectDomSource(
  input: CollectDomSourceInput,
): Promise<PerceptionSourceResult> {
  const accessibleTargets = input.frames.filter((frame) => frame.accessible);
  const inaccessible = input.frames.filter((frame) => !frame.accessible);

  const settled = await Promise.all(
    accessibleTargets.map(async (frame, index) => {
      try {
        const response = await input.transport.send(
          input.tabId,
          frame.frameId,
          {
            type: "perception.observe-dom",
            requestId: input.requestId + ":" + index,
            ...(input.options !== undefined ? { options: input.options } : {}),
          },
        );

        if (!response.ok) {
          return {
            frameId: frame.frameId,
            ok: false as const,
            warning: response.error.code + ": " + response.error.message,
          };
        }

        return {
          frameId: frame.frameId,
          ok: true as const,
          result: adaptDomFrameSnapshot({
            tabId: input.tabId,
            frameId: frame.frameId,
            snapshot: response.snapshot,
          }),
        };
      } catch (error) {
        return {
          frameId: frame.frameId,
          ok: false as const,
          warning: error instanceof Error ? error.message.slice(0, 500) : "frame transport failed",
        };
      }
    }),
  );

  const successful = settled.filter(
    (entry): entry is Extract<(typeof settled)[number], { ok: true }> => entry.ok,
  );
  const failed = settled.filter((entry) => !entry.ok);
  const degradedFrames = [
    ...inaccessible.map((frame) => frame.frameId),
    ...failed.map((frame) => frame.frameId),
  ];

  const elements = successful.flatMap((entry) => entry.result.elements);

  const actionableStates = successful.map((entry) => entry.result.coverage.actionable);
  const formStates = successful.map((entry) => entry.result.coverage.forms);
  const textStates = successful.map((entry) => entry.result.coverage.text);

  const frameFailureCount = degradedFrames.length;

  return {
    source: "dom",
    coverage: {
      actionable: combineFrameCoverage(
        actionableStates,
        elements.length,
        frameFailureCount,
      ),
      forms: combineFrameCoverage(
        formStates,
        elements.filter((element) => element.kind === "field").length,
        frameFailureCount,
      ),
      text: combineFrameCoverage(
        textStates,
        0,
        frameFailureCount,
      ),
    },
    elements,
    ...(degradedFrames.length > 0 ? { degradedFrames } : {}),
    warnings: [
      ...failed.map((entry) => "DOM frame " + entry.frameId + " failed: " + entry.warning),
      ...inaccessible.map((entry) => "DOM frame " + entry.frameId + " is inaccessible"),
      ...successful.flatMap((entry) => entry.result.warnings ?? []),
    ],
  };
}
