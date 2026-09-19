export type EffectClass =
  | "read"
  | "local-ui"
  | "navigation"
  | "draft-mutation"
  | "download"
  | "external-mutation"
  | "irreversible"
  | "credential"
  | "file-egress"
  | "permission"
  | "payment"
  | "unknown";

export type EffectConfidence = "known" | "inferred" | "unknown";

export interface EffectAssessment {
  class: EffectClass;
  confidence: EffectConfidence;
  evidence: string[];
}
