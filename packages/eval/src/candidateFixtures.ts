import type { ElementState } from "@browser-agent-next/core";
import { deepFreeze } from "./deepFreeze.js";
import type { DecisionFixture } from "./decisionFixture.js";
import {
  fixtureButton,
  fixtureObservation,
} from "./foundationFixtures.js";

/**
 * 第三批对抗决策 fixture：候选排序（docs/JEV-CANDIDATE-BUILDER.md「Eval」）。
 *
 * acceptableOperations / acceptableTargets 按任务语义标注；各 builder 的期望名次在
 * candidateBuilderComparison.test.ts 中逐条断言。全部是合成文本。
 */

function buttons(names: readonly string[], options: { role?: string } = {}): ElementState[] {
  return names.map((name, index) =>
    fixtureButton("@e_" + (index + 1), name, options.role === undefined ? {} : { role: options.role }),
  );
}

function click(
  name: string,
  microGoal: string,
  elements: ElementState[],
  target: string,
): DecisionFixture {
  return {
    name,
    microGoal,
    observation: fixtureObservation({ elements }),
    acceptableOperations: ["CLICK"],
    acceptableTargets: [target],
    tags: ["candidate-ranking"],
  };
}

const navigation = Array.from({ length: 36 }, (_, index) => "Nav " + (index + 1));
const invoices = Array.from({ length: 25 }, (_, index) => "Invoice #" + (index + 1));

export const candidateFixtures: readonly DecisionFixture[] = deepFreeze([
  click(
    "ranking-deep-target",
    "Open billing history",
    buttons([...navigation, "Billing history", "Footer 1", "Footer 2", "Footer 3"], { role: "link" }),
    "@e_37",
  ),
  click("ranking-generic-verb", "Open billing history", buttons(["Open", "Billing history"]), "@e_2"),
  click("ranking-lexicon-sign-out", "Sign out", buttons(["Sign in", "Sign up", "Account", "退出登录"]), "@e_4"),
  click("ranking-cjk-goal-sign-out", "退出登录", buttons(["Log in", "Log out"]), "@e_2"),
  click("ranking-view-details-cjk", "查看详情", buttons(["Open", "View details"]), "@e_2"),
  click("ranking-plural", "View invoices", buttons(["View profile", "Invoice"]), "@e_2"),
  click(
    "ranking-description",
    "Delete the draft named Quarterly report",
    [
      fixtureButton("@e_1", "Delete", { description: "Draft Weekly notes" }),
      fixtureButton("@e_2", "Delete", { description: "Draft Quarterly report" }),
      fixtureButton("@e_3", "Delete", { description: "Draft Monthly summary" }),
    ],
    "@e_2",
  ),
  click("ranking-number", "Open page 12", buttons(["Page 1", "Page 2", "Page 12"]), "@e_3"),
  click("ranking-cjk-both", "提交订单", buttons(["取消订单", "提交订单"]), "@e_2"),
  click("ranking-no-overlap", "Proceed", buttons(["Alpha", "Beta", "Continue"]), "@e_3"),
  click(
    "ranking-decoy-flood",
    "Pay the invoice",
    buttons([...Array.from({ length: 25 }, () => "Pay"), "Pay invoice"]),
    "@e_26",
  ),
  click(
    "ranking-echo-decoy",
    "Open the account settings",
    buttons(["Open account settings now", "Settings"]),
    "@e_2",
  ),
  click("ranking-cjk-stopword", "点击我的订单", buttons(["我的", "全部订单"]), "@e_2"),
  click(
    "ranking-partial-overlap-pushout",
    "Pay the invoice",
    buttons(["Back", "Proceed", ...invoices]),
    "@e_2",
  ),
]);
