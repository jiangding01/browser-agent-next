import type {
  AuthorizationAssurance,
  EffectAssessment,
  EffectClass,
} from "@browser-agent-next/core";
import {
  authorizationAssuranceSatisfies,
} from "./authorizationStore.js";

export type PolicyVerdict = "allow" | "confirm" | "deny" | "escalate";

export interface EffectPolicyInput {
  effect: EffectAssessment;
  tabOwnedBySession: boolean;
  originAllowed: boolean;
  authorizationAssurance?: AuthorizationAssurance;
}

export interface EffectPolicyDecision {
  verdict: PolicyVerdict;
  reasons: string[];
  requiredAssurance?: AuthorizationAssurance;
}

export function minimumAuthorizationAssurance(
  effectClass: EffectClass,
  tabOwnedBySession: boolean,
): AuthorizationAssurance | undefined {
  switch (effectClass) {
    case "read":
    case "local-ui":
      return undefined;

    case "navigation":
    case "draft-mutation":
      return tabOwnedBySession
        ? undefined
        : "operator-approved";

    case "unknown":
      return "control-plane";

    case "download":
    case "external-mutation":
    case "irreversible":
    case "credential":
    case "file-egress":
    case "permission":
    case "payment":
      return "operator-approved";
  }
}

export function evaluateEffectPolicy(
  input: EffectPolicyInput,
): EffectPolicyDecision {
  if (!input.originAllowed) {
    return {
      verdict: "deny",
      reasons: ["origin is not allowed by runtime policy"],
    };
  }

  const requiredAssurance =
    minimumAuthorizationAssurance(
      input.effect.class,
      input.tabOwnedBySession,
    );

  if (requiredAssurance === undefined) {
    return { verdict: "allow", reasons: [] };
  }

  const authorized =
    input.authorizationAssurance !== undefined &&
    authorizationAssuranceSatisfies(
      input.authorizationAssurance,
      requiredAssurance,
    );

  if (authorized) {
    return {
      verdict: "allow",
      reasons: [
        "authorization assurance satisfies required level: " +
          requiredAssurance,
      ],
      requiredAssurance,
    };
  }

  if (input.effect.class === "unknown") {
    return {
      verdict: "escalate",
      reasons: [
        "action effect is unknown",
        "required authorization assurance: " + requiredAssurance,
        ...(input.effect.confidence === "unknown"
          ? ["effect could not be classified confidently"]
          : []),
      ],
      requiredAssurance,
    };
  }

  return {
    verdict: "confirm",
    reasons: [
      input.effect.class +
        " effect requires authorization assurance: " +
        requiredAssurance,
    ],
    requiredAssurance,
  };
}
