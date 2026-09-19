import type { StateRevision } from "./types.js";

export interface RevisionClock {
  readonly stateEpoch: string;
  next(documentEpoch: string): StateRevision;
}

export function createRevisionClock(stateEpoch: string): RevisionClock {
  let sequence = 0;
  if (!stateEpoch.trim()) throw new Error("stateEpoch must be non-empty");

  return {
    stateEpoch,
    next(documentEpoch: string): StateRevision {
      if (!documentEpoch.trim()) throw new Error("documentEpoch must be non-empty");
      sequence += 1;
      return { id: stateEpoch + ":" + sequence, stateEpoch, documentEpoch, sequence };
    },
  };
}
