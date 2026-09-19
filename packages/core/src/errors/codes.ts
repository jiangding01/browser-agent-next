export const RUNTIME_ERROR_CODES = [
  "OBSERVATION_EXPIRED","BASELINE_RESET","STATE_INCOMPLETE","REF_NOT_FOUND","REF_STALE",
  "REF_NOT_IN_OBSERVATION","DOCUMENT_CHANGED","FRAME_CHANGED","TARGET_GONE",
  "TARGET_IDENTITY_MISMATCH","TARGET_SEMANTIC_CHANGED","TARGET_NOT_VISIBLE","TARGET_DISABLED",
  "TARGET_OUT_OF_VIEWPORT","TARGET_OCCLUDED","POLICY_BLOCKED","AUTHORIZATION_REQUIRED",
  "EFFECT_UNKNOWN","ORIGIN_NOT_ALLOWED","MODEL_EGRESS_BLOCKED","VERIFY_FAILED","NO_EFFECT",
  "FASTPATH_LOW_CONFIDENCE","FASTPATH_INCOMPLETE_CANDIDATES","FASTPATH_PROVIDER_TIMEOUT",
  "FASTPATH_ESCALATE"
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export class BrowserRuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: unknown;
  constructor(code: RuntimeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.details = details;
  }
}
