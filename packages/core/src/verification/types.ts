import type { Ref } from "../state/types.js";

export type VerifyCondition =
  | { type: "url_matches"; pattern: string }
  | { type: "title_matches"; pattern: string }
  | { type: "ref_exists"; ref: Ref }
  | { type: "ref_visible"; ref: Ref }
  | { type: "ref_absent"; ref: Ref }
  | { type: "text_present"; text: string; scopeRef?: Ref }
  | { type: "field_value"; ref: Ref; equals: unknown }
  | { type: "dialog_present"; title?: string }
  | { type: "download_started"; filenamePattern?: string }
  | { type: "network_request_completed"; urlPattern: string };

export interface VerificationSpec {
  mode: "all" | "any";
  conditions: VerifyCondition[];
}

export interface VerificationEvidence {
  condition: VerifyCondition;
  pass: boolean;

  /**
   * false 表示当前 observation 无法证明 pass/fail，而不是“验证失败”。
   */
  conclusive: boolean;

  observed?: unknown;
  reason?: string;
}

export interface VerificationResult {
  verified: boolean;
  conclusive: boolean;
  evidence: VerificationEvidence[];
  revision?: string;
}
