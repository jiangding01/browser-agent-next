import {
  BrowserRuntimeError,
  type BrowserAction,
  type BrowserObservation,
  type ElementState,
} from "@browser-agent-next/core";
import type { TabStateStore } from "../state/tabStateStore.js";
import {
  evaluateStrictPreflight,
  type LiveElementInspection,
} from "./strictPreflight.js";

export type StrictLiveResolution<TPrepared> =
  | {
      documentCompatible: false;
      reason?: string;
    }
  | {
      documentCompatible: true;
      identityMatches: false;
      reason?: string;
    }
  | {
      documentCompatible: true;
      identityMatches: true;
      live: LiveElementInspection;
      prepared: TPrepared;
    };

export interface StrictLiveResolver<TPrepared> {
  resolve(input: {
    tabId: number;
    action: BrowserAction;
    observation: BrowserObservation;
    expected: ElementState;
  }): Promise<StrictLiveResolution<TPrepared>>;
}

export interface PreparedStrictAction<TPrepared> {
  action: BrowserAction;
  observation: BrowserObservation;
  expected: ElementState;
  prepared: TPrepared;
}

/**
 * 严格动作的通用协调层。
 *
 * 调用方只提供 action + tabId；可信 expected semantics 必须从本地保留的
 * observation 读取，绝不接受模型传入的 expected role/name/geometry。
 */
export class StoredObservationStrictCoordinator<TPrepared> {
  constructor(
    private readonly states: TabStateStore,
    private readonly resolver: StrictLiveResolver<TPrepared>,
  ) {}

  async prepare(
    tabId: number,
    action: BrowserAction,
  ): Promise<PreparedStrictAction<TPrepared>> {
    if (!action.observedRevision) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "strict action requires observedRevision",
      );
    }

    if (!action.target?.ref) {
      throw new BrowserRuntimeError(
        "REF_NOT_IN_OBSERVATION",
        "strict action requires a target ref",
      );
    }

    const stored = this.states.get(
      tabId,
      action.observedRevision,
    );

    if (!stored) {
      throw new BrowserRuntimeError(
        "OBSERVATION_EXPIRED",
        "the referenced observation is no longer retained",
        {
          tabId,
          revision: action.observedRevision,
        },
      );
    }

    const expected = stored.byRef.get(action.target.ref);

    if (!expected) {
      throw new BrowserRuntimeError(
        "REF_NOT_IN_OBSERVATION",
        "the target ref does not belong to the referenced observation",
        {
          tabId,
          revision: action.observedRevision,
          ref: action.target.ref,
        },
      );
    }

    const resolution = await this.resolver.resolve({
      tabId,
      action,
      observation: stored.observation,
      expected,
    });

    if (!resolution.documentCompatible) {
      throw new BrowserRuntimeError(
        "DOCUMENT_CHANGED",
        resolution.reason ??
          "the live document no longer matches the observed document",
      );
    }

    if (!resolution.identityMatches) {
      throw new BrowserRuntimeError(
        "TARGET_IDENTITY_MISMATCH",
        resolution.reason ??
          "the live target no longer matches the observed strong identity",
      );
    }

    const preflight = evaluateStrictPreflight({
      expected,
      live: resolution.live,
      actionKind: action.kind,
      documentCompatible: true,
      identityMatches: true,
    });

    if (!preflight.ok) {
      throw new BrowserRuntimeError(
        preflight.code,
        preflight.message,
      );
    }

    return {
      action,
      observation: stored.observation,
      expected,
      prepared: resolution.prepared,
    };
  }
}
