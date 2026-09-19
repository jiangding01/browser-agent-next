import type { BrowserObservation, CoverageState } from "./types.js";

export interface CoverageInput {
  returned: number;
  totalKnown?: number;
  truncated?: boolean;
  partial?: boolean;
  reason?: string;
}

export function createCoverageState(input: CoverageInput): CoverageState {
  const { returned, totalKnown, truncated = false, partial = false, reason } = input;

  if (!Number.isInteger(returned) || returned < 0) {
    throw new Error("coverage.returned must be a non-negative integer");
  }

  if (totalKnown !== undefined) {
    if (!Number.isInteger(totalKnown) || totalKnown < 0) {
      throw new Error("coverage.totalKnown must be a non-negative integer");
    }
    if (returned > totalKnown) {
      throw new Error("coverage.returned cannot exceed coverage.totalKnown");
    }
  }

  if (truncated && partial) {
    throw new Error("coverage cannot be both truncated and partial");
  }

  const base = {
    returned,
    ...(totalKnown !== undefined ? { totalKnown } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };

  if (truncated) {
    return { status: "truncated", ...base };
  }

  if (partial) {
    return { status: "partial", ...base };
  }

  if (totalKnown === undefined) {
    return { status: "unknown", ...base };
  }

  if (returned === totalKnown) {
    return { status: "complete", ...base };
  }

  // We know there are more items but the producer did not state why they are missing.
  // Never infer "complete" from an output count alone.
  return {
    status: "partial",
    ...base,
    ...(reason === undefined ? { reason: "returned-less-than-total-known" } : {}),
  };
}

export function isActionSpaceComplete(observation: BrowserObservation): boolean {
  return observation.coverage.actionable.status === "complete";
}

export function requireCompleteActionSpace(observation: BrowserObservation): void {
  if (isActionSpaceComplete(observation)) {
    return;
  }

  const coverage = observation.coverage.actionable;
  const known = coverage.totalKnown === undefined ? "unknown" : String(coverage.totalKnown);

  throw new Error(
    `actionable observation is not complete: status=${coverage.status}, returned=${coverage.returned}, totalKnown=${known}`,
  );
}
