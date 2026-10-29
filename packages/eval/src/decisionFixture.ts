import type {
  BrowserObservation,
  Ref,
} from "@browser-agent-next/core";

/**
 * Jev 初始操作空间（docs/DESIGN.md）。
 *
 * 先放在 eval 包；Phase 7 router 进入 Runtime 需要共享时再迁到 core。
 */
export const DECISION_OPERATIONS = [
  "CLICK",
  "HANDOFF_FORM",
  "HANDOFF_VERIFY",
  "ESCALATE",
] as const;

export type DecisionOperation = (typeof DECISION_OPERATIONS)[number];

export const FIXTURE_TAGS = [
  "duplicate-name",
  "replacement",
  "overlay",
  "disabled",
  "truncation",
  "prompt-injection",
  "unknown-effect",
  "mixed-language",
  "child-frame",
  "form-handoff",
  "verify-handoff",
] as const;

export type FixtureTag = (typeof FIXTURE_TAGS)[number];

export interface DecisionFixture {
  name: string;
  observation: BrowserObservation;
  microGoal: string;

  /** 可接受答案是集合：UI 允许多个合理下一步时不强行指定唯一答案。 */
  acceptableOperations: DecisionOperation[];
  /** CLICK 可接受时必填，且只能是可点击的元素。 */
  acceptableTargets?: Ref[];

  tags: FixtureTag[];
}

export const DECISION_FIXTURE_LIMITS = {
  maxNameLength: 64,
  maxMicroGoalLength: 500,
} as const;

const FIXTURE_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function fail(name: string, message: string): never {
  throw new Error(
    "invalid decision fixture " + JSON.stringify(name) + ": " + message,
  );
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function validateDecisionFixture(fixture: DecisionFixture): void {
  const { name, observation } = fixture;

  if (
    name.length > DECISION_FIXTURE_LIMITS.maxNameLength ||
    !FIXTURE_NAME_PATTERN.test(name)
  ) {
    fail(name, "name must be kebab-case and at most 64 characters");
  }

  if (
    fixture.microGoal.trim().length === 0 ||
    fixture.microGoal.length > DECISION_FIXTURE_LIMITS.maxMicroGoalLength
  ) {
    fail(name, "microGoal must be non-empty and at most 500 characters");
  }

  const operations = fixture.acceptableOperations;
  if (
    operations.length === 0 ||
    hasDuplicates(operations) ||
    operations.some(
      (operation) => !(DECISION_OPERATIONS as readonly string[]).includes(operation),
    )
  ) {
    fail(name, "acceptableOperations must be a non-empty set of known operations");
  }

  const refs = observation.elements.map((element) => element.ref);
  if (hasDuplicates(refs)) {
    fail(name, "observation refs must be unique");
  }

  const frameIds = new Set(observation.frames.map((frame) => frame.frameId));
  if (observation.elements.some((element) => !frameIds.has(element.frameId))) {
    fail(name, "every element frameId must exist in observation.frames");
  }

  const targets = fixture.acceptableTargets ?? [];
  const clickAcceptable = operations.includes("CLICK");
  if (clickAcceptable !== (targets.length > 0)) {
    fail(name, "acceptableTargets must be non-empty exactly when CLICK is acceptable");
  }
  if (hasDuplicates(targets)) {
    fail(name, "acceptableTargets must be unique");
  }

  for (const target of targets) {
    const element = observation.elements.find((item) => item.ref === target);
    if (!element) {
      fail(name, "acceptable target " + target + " is not in the observation");
    }
    if (
      !element.capabilities.some((capability) => capability.kind === "click") ||
      !element.state.visible ||
      !element.state.enabled
    ) {
      fail(name, "acceptable target " + target + " must be a visible, enabled clickable element");
    }
  }

  if (
    fixture.tags.length === 0 ||
    hasDuplicates(fixture.tags) ||
    fixture.tags.some((tag) => !(FIXTURE_TAGS as readonly string[]).includes(tag))
  ) {
    fail(name, "tags must be a non-empty set of known fixture tags");
  }

  // 不变量 12 / 133：action space 不完整时，安全升级必须始终是可接受答案。
  if (
    observation.coverage.actionable.status !== "complete" &&
    !operations.includes("ESCALATE")
  ) {
    fail(name, "fixtures with incomplete actionable coverage must accept ESCALATE");
  }
}

/**
 * 运行任何 provider 之前一次性校验整组 fixture。
 *
 * fixture 写错属于评测集 bug，必须直接失败，不能被计作 provider 失败。
 */
export function validateDecisionFixtures(
  fixtures: readonly DecisionFixture[],
): void {
  const names = new Set<string>();

  for (const fixture of fixtures) {
    validateDecisionFixture(fixture);
    if (names.has(fixture.name)) {
      fail(fixture.name, "fixture names must be unique");
    }
    names.add(fixture.name);
  }
}
