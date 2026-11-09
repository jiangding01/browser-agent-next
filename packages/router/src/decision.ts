import type { BrowserObservation, Ref } from "@browser-agent-next/core";
import type { CandidateSet } from "./candidateSet.js";
import type { StepIntent } from "./stepIntent.js";

/**
 * Jev 初始操作空间（docs/DESIGN.md）。
 *
 * 放在 router（决策层，只依赖 core）：eval 与将来的运行期 provider 共用（docs/JEV-PROVIDER.md「类型迁移」）。
 */
export const DECISION_OPERATIONS = [
  "CLICK",
  "HANDOFF_FORM",
  "HANDOFF_VERIFY",
  "ESCALATE",
] as const;

export type DecisionOperation = (typeof DECISION_OPERATIONS)[number];

export type Decision =
  | { operation: "CLICK"; ref: Ref; confidence?: number }
  | {
      operation: Exclude<DecisionOperation, "CLICK">;
      confidence?: number;
    };

export interface DecisionProviderInput {
  observation: BrowserObservation;
  microGoal: string;
  candidates: CandidateSet;
  /** fixture 带结构化 intent 时传入（运行前冻结的快照的一部分）；其余 fixture 不含该字段。 */
  intent?: StepIntent;
}

export interface DecisionProvider {
  readonly name: string;
  decide(input: DecisionProviderInput): Decision | Promise<Decision>;
}
