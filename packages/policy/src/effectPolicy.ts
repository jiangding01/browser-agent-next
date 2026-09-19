import type { EffectAssessment } from "@browser-agent-next/core";

export type PolicyVerdict = "allow" | "confirm" | "deny" | "escalate";

export interface EffectPolicyInput {
  effect: EffectAssessment;
  tabOwnedBySession: boolean;
  originAllowed: boolean;
  hasAuthorization: boolean;
}

export interface EffectPolicyDecision { verdict: PolicyVerdict; reasons: string[]; }

export function evaluateEffectPolicy(input: EffectPolicyInput): EffectPolicyDecision {
  if (!input.originAllowed) return { verdict: "deny", reasons: ["origin is not allowed by runtime policy"] };

  switch (input.effect.class) {
    case "read":
    case "local-ui":
      return { verdict: "allow", reasons: [] };
    case "navigation":
    case "draft-mutation":
      return input.tabOwnedBySession
        ? { verdict: "allow", reasons: [] }
        : { verdict: "confirm", reasons: ["action targets a user-existing tab"] };
    case "download":
      return input.hasAuthorization
        ? { verdict: "allow", reasons: [] }
        : { verdict: "confirm", reasons: ["download requires authorization"] };
    case "external-mutation":
    case "irreversible":
    case "credential":
    case "file-egress":
    case "permission":
    case "payment":
      return input.hasAuthorization
        ? { verdict: "allow", reasons: [] }
        : { verdict: "confirm", reasons: [input.effect.class + " effect requires authorization"] };
    case "unknown":
      return {
        verdict: "escalate",
        reasons: [
          "action effect is unknown",
          ...(input.effect.confidence === "unknown" ? ["effect could not be classified confidently"] : []),
        ],
      };
  }
}
