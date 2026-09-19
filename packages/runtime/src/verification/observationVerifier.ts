import type {
  BrowserObservation,
  VerificationEvidence,
  VerificationResult,
  VerificationSpec,
  VerifyCondition,
} from "@browser-agent-next/core";

function evidence(
  condition: VerifyCondition,
  options: {
    pass: boolean;
    conclusive: boolean;
    observed?: unknown;
    reason?: string;
  },
): VerificationEvidence {
  return {
    condition,
    pass: options.pass,
    conclusive: options.conclusive,
    ...(options.observed !== undefined
      ? { observed: options.observed }
      : {}),
    ...(options.reason !== undefined
      ? { reason: options.reason }
      : {}),
  };
}

function actionableComplete(
  observation: BrowserObservation,
): boolean {
  return observation.coverage.actionable.status === "complete";
}

function textComplete(
  observation: BrowserObservation,
): boolean {
  return observation.coverage.text.status === "complete";
}

function escapeRegexChar(value: string): string {
  return /[|\\{}()[\]^$+.*?]/.test(value)
    ? "\\" + value
    : value;
}

/**
 * pattern 采用有界 glob，而不是任意 RegExp：
 * - * 匹配任意长度
 * - ? 匹配单字符
 *
 * 逐字符编译，避免先 escape 再替换导致 ? 被误当成 literal。
 * Agent 提供的其它正则元字符全部按普通字符处理。
 */
export function safeGlobMatches(
  value: string,
  pattern: string,
): boolean {
  if (pattern.length > 512) {
    return false;
  }

  let source = "^";

  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += escapeRegexChar(char);
    }
  }

  source += "$";
  return new RegExp(source, "u").test(value);
}

function deepEqual(
  left: unknown,
  right: unknown,
): boolean {
  if (Object.is(left, right)) return true;

  if (
    Array.isArray(left) &&
    Array.isArray(right)
  ) {
    return (
      left.length === right.length &&
      left.every((value, index) =>
        deepEqual(value, right[index]),
      )
    );
  }

  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();

    return (
      deepEqual(leftKeys, rightKeys) &&
      leftKeys.every((key) =>
        deepEqual(leftRecord[key], rightRecord[key]),
      )
    );
  }

  return false;
}

function verifyCondition(
  observation: BrowserObservation,
  condition: VerifyCondition,
): VerificationEvidence {
  switch (condition.type) {
    case "url_matches":
      return evidence(condition, {
        pass: safeGlobMatches(
          observation.tab.url,
          condition.pattern,
        ),
        conclusive: true,
        observed: observation.tab.url,
      });

    case "title_matches":
      return evidence(condition, {
        pass: safeGlobMatches(
          observation.tab.title,
          condition.pattern,
        ),
        conclusive: true,
        observed: observation.tab.title,
      });

    case "ref_exists": {
      const found = observation.elements.some(
        (element) => element.ref === condition.ref,
      );

      return evidence(condition, {
        pass: found,
        conclusive: found || actionableComplete(observation),
        observed: found,
        ...(!found && !actionableComplete(observation)
          ? {
              reason:
                "actionable observation is incomplete; absence is not proven",
            }
          : {}),
      });
    }

    case "ref_visible": {
      const found = observation.elements.find(
        (element) => element.ref === condition.ref,
      );

      if (!found) {
        return evidence(condition, {
          pass: false,
          conclusive: actionableComplete(observation),
          observed: false,
          ...(!actionableComplete(observation)
            ? {
                reason:
                  "actionable observation is incomplete; target absence is not proven",
              }
            : {}),
        });
      }

      return evidence(condition, {
        pass: found.state.visible,
        conclusive: true,
        observed: found.state.visible,
      });
    }

    case "ref_absent": {
      const found = observation.elements.some(
        (element) => element.ref === condition.ref,
      );

      if (found) {
        return evidence(condition, {
          pass: false,
          conclusive: true,
          observed: "present",
        });
      }

      return evidence(condition, {
        pass: actionableComplete(observation),
        conclusive: actionableComplete(observation),
        observed: "not-observed",
        ...(!actionableComplete(observation)
          ? {
              reason:
                "actionable observation is incomplete; absence is not proven",
            }
          : {}),
      });
    }

    case "field_value": {
      const found = observation.elements.find(
        (element) => element.ref === condition.ref,
      );

      if (!found) {
        return evidence(condition, {
          pass: false,
          conclusive: actionableComplete(observation),
          ...(!actionableComplete(observation)
            ? {
                reason:
                  "actionable observation is incomplete; field absence is not proven",
              }
            : {}),
        });
      }

      if (!found.value) {
        return evidence(condition, {
          pass: false,
          conclusive: false,
          reason: "field value was not included in this observation",
        });
      }

      return evidence(condition, {
        pass: deepEqual(
          found.value.display,
          condition.equals,
        ),
        conclusive: true,
        observed: found.value.display,
      });
    }

    case "text_present": {
      const candidates = condition.scopeRef
        ? observation.elements.filter(
            (element) => element.ref === condition.scopeRef,
          )
        : observation.elements;

      const found = candidates.some((element) =>
        [
          element.semantic.name,
          element.semantic.description,
          element.semantic.text,
        ].some((value) =>
          typeof value === "string" &&
          value.includes(condition.text),
        ),
      );

      if (found) {
        return evidence(condition, {
          pass: true,
          conclusive: true,
          observed: condition.text,
        });
      }

      return evidence(condition, {
        pass: false,
        conclusive: textComplete(observation),
        ...(!textComplete(observation)
          ? {
              reason:
                "text coverage is incomplete; absence of text is not proven",
            }
          : {}),
      });
    }

    case "dialog_present": {
      if (observation.dialogs === undefined) {
        return evidence(condition, {
          pass: false,
          conclusive: false,
          reason: "dialog coverage is unavailable",
        });
      }

      const found = observation.dialogs.some((dialog) =>
        condition.title === undefined
          ? true
          : dialog.title === condition.title,
      );

      return evidence(condition, {
        pass: found,
        conclusive: true,
        observed: observation.dialogs,
      });
    }

    case "download_started":
      return evidence(condition, {
        pass: false,
        conclusive: false,
        reason:
          "download verification requires a download event source",
      });

    case "network_request_completed":
      return evidence(condition, {
        pass: false,
        conclusive: false,
        reason:
          "network verification requires a network event source",
      });
  }
}

function aggregate(
  mode: VerificationSpec["mode"],
  evidenceList: VerificationEvidence[],
): {
  verified: boolean;
  conclusive: boolean;
} {
  if (evidenceList.length === 0) {
    return {
      verified: false,
      conclusive: false,
    };
  }

  if (mode === "all") {
    if (evidenceList.some(
      (entry) => entry.conclusive && !entry.pass,
    )) {
      return {
        verified: false,
        conclusive: true,
      };
    }

    if (evidenceList.every(
      (entry) => entry.conclusive && entry.pass,
    )) {
      return {
        verified: true,
        conclusive: true,
      };
    }

    return {
      verified: false,
      conclusive: false,
    };
  }

  if (evidenceList.some(
    (entry) => entry.conclusive && entry.pass,
  )) {
    return {
      verified: true,
      conclusive: true,
    };
  }

  if (evidenceList.every(
    (entry) => entry.conclusive && !entry.pass,
  )) {
    return {
      verified: false,
      conclusive: true,
    };
  }

  return {
    verified: false,
    conclusive: false,
  };
}

export function verifyObservation(
  observation: BrowserObservation,
  spec: VerificationSpec,
): VerificationResult {
  const evidenceList = spec.conditions.map((condition) =>
    verifyCondition(observation, condition),
  );
  const summary = aggregate(spec.mode, evidenceList);

  return {
    ...summary,
    evidence: evidenceList,
    revision: observation.revision.id,
  };
}
