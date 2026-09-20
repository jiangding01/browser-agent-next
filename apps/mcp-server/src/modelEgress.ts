import {
  BrowserRuntimeError,
  type BrowserObservation,
  type ElementState,
  type VerificationResult,
} from "@browser-agent-next/core";
import type {
  ModelOriginAccessPolicy,
} from "@browser-agent-next/policy";

export interface ModelEgressOptions {
  includeValues?: boolean;
  maxObservationElements?: number;
  maxVisibleRevisions?: number;
}

export function sanitizedVerification(
  result: VerificationResult,
): VerificationResult {
  return {
    verified: result.verified,
    conclusive: result.conclusive,
    evidence: result.evidence.map((item) => {
      const { observed: _observed, ...safe } = item;
      return safe;
    }),
    ...(result.revision !== undefined
      ? { revision: result.revision }
      : {}),
  };
}

function sanitizedElement(
  element: ElementState,
  includeValues: boolean,
): ElementState {
  if (includeValues) return element;
  const { value: _value, ...safe } = element;
  return safe;
}

interface StoredModelObservation {
  observation: BrowserObservation;
}

export class ModelVisibleObservationStore {
  private readonly observations =
    new Map<string, StoredModelObservation>();

  constructor(private readonly maxEntries: number) {}

  put(observation: BrowserObservation): void {
    const key = this.key(
      observation.tab.tabId,
      observation.revision.id,
    );
    this.observations.delete(key);
    this.observations.set(key, { observation });

    while (this.observations.size > this.maxEntries) {
      const oldest = this.observations
        .keys()
        .next()
        .value as string | undefined;
      if (oldest === undefined) break;
      this.observations.delete(oldest);
    }
  }

  get(
    tabId: number,
    revision: string,
  ): BrowserObservation | undefined {
    return this.observations.get(
      this.key(tabId, revision),
    )?.observation;
  }

  private key(tabId: number, revision: string): string {
    return tabId + ":" + revision;
  }
}

export class ModelEgressProjector {
  constructor(
    private readonly origins: ModelOriginAccessPolicy,
    private readonly maxObservationElements: number,
  ) {}

  project(
    observation: BrowserObservation,
    includeValues: boolean,
  ): BrowserObservation {
    if (!this.origins.canRead(observation.tab.origin)) {
      throw new BrowserRuntimeError(
        "MODEL_EGRESS_BLOCKED",
        "top-level observation origin is not allowlisted for model egress",
      );
    }
    if (
      observation.elements.length >
      this.maxObservationElements
    ) {
      throw new BrowserRuntimeError(
        "MODEL_EGRESS_BLOCKED",
        "runtime observation exceeded model egress element bound",
      );
    }

    const frames = new Map(
      observation.frames.map((frame) => [
        frame.frameId,
        frame,
      ]),
    );
    const allowed = new Map<string, boolean>();
    const resolving = new Set<string>();

    const frameAllowed = (frameId: string): boolean => {
      const cached = allowed.get(frameId);
      if (cached !== undefined) return cached;

      const frame = frames.get(frameId);
      if (!frame || resolving.has(frameId)) {
        return false;
      }
      resolving.add(frameId);

      let result: boolean;
      if (frame.parentFrameId === undefined) {
        result = this.origins.canRead(
          frame.url ?? observation.tab.origin,
        );
      } else if (
        frame.url === "about:blank" ||
        frame.url === "about:srcdoc"
      ) {
        result = frameAllowed(frame.parentFrameId);
      } else if (frame.url !== undefined) {
        result = this.origins.canRead(frame.url);
      } else {
        result = false;
      }

      resolving.delete(frameId);
      allowed.set(frameId, result);
      return result;
    };

    for (const frame of observation.frames) {
      frameAllowed(frame.frameId);
    }

    const blockedAccessibleFrames = new Set(
      observation.frames
        .filter(
          (frame) =>
            frame.accessible &&
            !allowed.get(frame.frameId),
        )
        .map((frame) => frame.frameId),
    );

    const visibleElements = observation.elements
      .filter(
        (element) =>
          allowed.get(element.frameId) === true,
      )
      .map((element) =>
        sanitizedElement(element, includeValues)
      );

    const filteredContent =
      blockedAccessibleFrames.size > 0 ||
      visibleElements.length !==
        observation.elements.length;

    const projectedFrames = observation.frames.map(
      (frame) => {
        if (allowed.get(frame.frameId)) {
          const {
            degradedReason: _reason,
            ...safeFrame
          } = frame;
          return {
            ...safeFrame,
            ...(frame.degradedReason !== undefined
              ? {
                  degradedReason:
                    "runtime-frame-degraded",
                }
              : {}),
          };
        }

        const {
          url: _url,
          degradedReason: _reason,
          ...withoutUrl
        } = frame;
        return {
          ...withoutUrl,
          accessible: false,
          degradedReason:
            "model-egress-origin-blocked",
        };
      },
    );

    const {
      capabilities: _capabilities,
      delta: _delta,
      forms: _forms,
      overlays: _overlays,
      dialogs: _dialogs,
      warnings: _warnings,
      ...base
    } = observation;

    const modelWarnings = [
      ...(observation.warnings !== undefined
        ? ["model-egress omitted runtime warnings"]
        : []),
      ...(observation.capabilities !== undefined
        ? [
            "model-egress omitted page-declared capabilities",
          ]
        : []),
      ...(observation.delta !== undefined
        ? ["model-egress omitted runtime delta"]
        : []),
      ...(filteredContent
        ? [
            "model-egress filtered non-allowlisted frame content",
          ]
        : []),
    ];

    return {
      ...base,
      coverage: {
        ...observation.coverage,
        actionable: filteredContent
          ? {
              ...observation.coverage.actionable,
              status: "partial",
            }
          : { ...observation.coverage.actionable },
        forms: filteredContent
          ? {
              ...observation.coverage.forms,
              status: "partial",
            }
          : { ...observation.coverage.forms },
        text: filteredContent
          ? {
              ...observation.coverage.text,
              status: "partial",
            }
          : { ...observation.coverage.text },
        frames: {
          discovered:
            observation.coverage.frames.discovered,
          accessible: projectedFrames.filter(
            (frame) => frame.accessible,
          ).length,
          degraded: [...new Set([
            ...observation.coverage.frames.degraded
              .filter(
                (frameId) =>
                  frames.has(frameId) &&
                  allowed.get(frameId) === true,
              ),
            ...[...blockedAccessibleFrames].map(
              (frameId) =>
                "model-egress:" + frameId,
            ),
          ])],
        },
        shadowDom: {
          ...observation.coverage.shadowDom,
        },
        canvas: { ...observation.coverage.canvas },
      },
      frames: projectedFrames,
      elements: visibleElements,
      ...(
        filteredContent ||
        observation.forms === undefined
          ? {}
          : { forms: observation.forms }
      ),
      ...(
        filteredContent ||
        observation.overlays === undefined
          ? {}
          : { overlays: observation.overlays }
      ),
      ...(
        filteredContent ||
        observation.dialogs === undefined
          ? {}
          : { dialogs: observation.dialogs }
      ),
      ...(modelWarnings.length > 0
        ? { warnings: modelWarnings }
        : {}),
    };
  }
}
