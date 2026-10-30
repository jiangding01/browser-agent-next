import type {
  BrowserActionKind,
  ElementState,
  RuntimeErrorCode,
} from "@browser-agent-next/core";

export interface LiveElementInspection {
  semantic: {
    role: string;
    name?: string;
  };

  state: {
    visible: boolean;
    enabled: boolean;
  };

  geometry?: {
    inViewport: boolean;
    hitTestable: boolean;
  };
}

export interface StrictPreflightInput {
  expected: ElementState;
  live: LiveElementInspection;
  actionKind: BrowserActionKind;

  documentCompatible: boolean;
  identityMatches: boolean;
}

export type StrictPreflightResult =
  | { ok: true }
  | {
      ok: false;
      code: RuntimeErrorCode;
      message: string;
    };

function normalizeAccessibleName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function requiredCapability(actionKind: BrowserActionKind): string | undefined {
  switch (actionKind) {
    case "click":
      return "click";
    case "setValue":
      return "setValue";
    case "selectOption":
      return "selectOption";
    case "check":
      return "check";
    case "upload":
      return "upload";
    case "submit":
      return "submit";
    default:
      return undefined;
  }
}

function failure(
  code: RuntimeErrorCode,
  message: string,
): StrictPreflightResult {
  return { ok: false, code, message };
}

/**
 * Browser-independent strict target checks.
 *
 * This function intentionally does not resolve refs or perform input. The
 * browser-specific executor must first:
 *
 * 1. load the expected target from the stored observation;
 * 2. resolve the persistent ref by strong identity;
 * 3. inspect that live object;
 * 4. call this function;
 * 5. run policy authorization;
 * 6. dispatch input only if all checks passed.
 */
export function evaluateStrictPreflight(
  input: StrictPreflightInput,
): StrictPreflightResult {
  const {
    expected,
    live,
    actionKind,
    documentCompatible,
    identityMatches,
  } = input;

  if (!documentCompatible) {
    return failure(
      "DOCUMENT_CHANGED",
      "the target document/frame identity changed after observation",
    );
  }

  if (!identityMatches) {
    return failure(
      "TARGET_IDENTITY_MISMATCH",
      "the live target is not the strong identity stored for the observed ref",
    );
  }

  if (expected.semantic.role !== live.semantic.role) {
    return failure(
      "TARGET_SEMANTIC_CHANGED",
      `target role changed from "${expected.semantic.role}" to "${live.semantic.role}"`,
    );
  }

  const expectedName = normalizeAccessibleName(expected.semantic.name);
  const liveName = normalizeAccessibleName(live.semantic.name);

  if (expectedName !== undefined && expectedName !== liveName) {
    return failure(
      "TARGET_SEMANTIC_CHANGED",
      `target accessible name changed from "${expectedName}" to "${liveName ?? ""}"`,
    );
  }

  const capability = requiredCapability(actionKind);
  if (
    capability !== undefined &&
    !expected.capabilities.some((entry) => entry.kind === capability)
  ) {
    return failure(
      "TARGET_CAPABILITY_MISSING",
      `the observed target did not advertise capability "${capability}"`,
    );
  }

  if (!live.state.visible) {
    return failure("TARGET_NOT_VISIBLE", "the live target is not visible");
  }

  if (!live.state.enabled) {
    return failure("TARGET_DISABLED", "the live target is disabled");
  }

  // 用户看不到、点不到的目标，调用方也不应能点击、写入、选择、提交或按键（不变量 150）。
  if (!live.geometry?.inViewport) {
    return failure(
      "TARGET_OUT_OF_VIEWPORT",
      "strict " + actionKind + " requires the live target to be in the viewport",
    );
  }

  if (!live.geometry.hitTestable) {
    return failure(
      "TARGET_OCCLUDED",
      "strict " + actionKind + " hit testing does not resolve to the live target",
    );
  }

  return { ok: true };
}
