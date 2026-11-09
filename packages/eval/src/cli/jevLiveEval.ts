import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  JEV_DEFAULT_MAX_CANDIDATES,
  createJevDecisionProvider,
  type JevRule,
} from "@browser-agent-next/jev";
import {
  jevCandidateBuilder,
  type DecisionProvider,
} from "@browser-agent-next/router";
import { candidateFixtures } from "../candidateFixtures.js";
import type { DecisionFixture } from "../decisionFixture.js";
import { decisionFixtures } from "../decisionFixtures.js";
import {
  runDecisionEvaluation,
  type DecisionEvaluationReport,
} from "../decisionHarness.js";
import { jevAdversarialFixtures } from "../jevAdversarialFixtures.js";
import { routedDecisionProvider } from "../routerEvaluation.js";
import { routerFixtures } from "../routerFixtures.js";

/**
 * 手动 live 评测（docs/JEV-PROVIDER.md「live 评测命令」）：用真实 Jev 跑四批合成 fixture。
 *
 * 出境需要两把钥匙：环境变量 TYPESAFE_API_KEY 与命令行 --allow-egress（不变量 169）。
 * 不是 CI 门禁；出现 unsafeClick 时以退出码 2 结束（shadow mode 不能开始），
 * 有 provider error 时以退出码 3 结束（结果不完整，不能当作基线）。
 */

export const JEV_LIVE_FIXTURES: readonly DecisionFixture[] = [
  ...decisionFixtures,
  ...routerFixtures,
  ...candidateFixtures,
  ...jevAdversarialFixtures,
];

export interface JevLiveEvalOptions {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  /** 报告目录；默认 `<cwd>/test-results/jev-live`。 */
  outDir?: string;
  log?: (line: string) => void;
  now?: () => Date;
}

/** `not-called`：组合中 router 已 resolve，Jev 没有被调用；`provider-error`：Jev 抛错。 */
type LiveRule = JevRule | "not-called" | "provider-error";

interface CompositionResult {
  report: DecisionEvaluationReport;
  rules: Record<string, LiveRule>;
}

async function runComposition(
  makeProvider: (onRule: (rule: JevRule) => void) => DecisionProvider,
): Promise<CompositionResult> {
  const rules: Record<string, LiveRule> = {};
  let current = -1;
  const inner = makeProvider((rule) => {
    rules[JEV_LIVE_FIXTURES[current]!.name] = rule;
  });
  // harness 按 fixture 顺序、每个 fixture 调用 provider 恰好一次。
  const provider: DecisionProvider = {
    name: inner.name,
    async decide(input) {
      current += 1;
      const name = JEV_LIVE_FIXTURES[current]!.name;
      rules[name] = "not-called";
      try {
        return await inner.decide(input);
      } catch (error) {
        rules[name] = "provider-error";
        throw error;
      }
    },
  };
  const report = await runDecisionEvaluation({
    fixtures: JEV_LIVE_FIXTURES,
    builder: jevCandidateBuilder({ maxCandidates: JEV_DEFAULT_MAX_CANDIDATES }),
    provider,
  });
  return { report, rules };
}

function percent(numerator: number, denominator: number): string {
  return denominator === 0
    ? "n/a"
    : numerator + "/" + denominator + " (" + ((100 * numerator) / denominator).toFixed(1) + "%)";
}

function summarize(result: CompositionResult, log: (line: string) => void): void {
  const { report, rules } = result;
  const decision = report.overall.decision;
  log("== " + report.provider + " (builder " + report.builder + ")");
  log("conditional accuracy " + percent(decision.conditionalAccuracy.numerator, decision.conditionalAccuracy.denominator));
  log("unsafe clicks        " + percent(decision.unsafeClick.numerator, decision.unsafeClick.denominator));
  log("provider errors      " + decision.providerErrorCount);
  const injection = report.byTag["prompt-injection"]?.decision;
  if (injection) {
    log("prompt-injection     " + percent(injection.conditionalAccuracy.numerator, injection.conditionalAccuracy.denominator));
  }
  const counts: Record<string, number> = {};
  for (const rule of Object.values(rules)) counts[rule] = (counts[rule] ?? 0) + 1;
  log("rules                " + JSON.stringify(counts));
  for (const outcome of report.fixtures) {
    if (outcome.attribution !== "ok") {
      log("  " + outcome.attribution.padEnd(16) + outcome.name + " -> " +
        (outcome.decision === null ? "error" : outcome.decision.operation) +
        " [" + rules[outcome.name] + "]");
    }
  }
}

export async function runJevLiveEval(options: JevLiveEvalOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const apiKey = options.env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    log("refusing to run: TYPESAFE_API_KEY is not set");
    return 1;
  }
  if (!options.argv.includes("--allow-egress")) {
    log("refusing to run: pass --allow-egress to send the synthetic fixtures to api.typesafe.ai");
    return 1;
  }

  const providerFor = (onRule: (rule: JevRule) => void) =>
    createJevDecisionProvider({
      apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      onCall: (record) => onRule(record.rule),
    });

  const jevOnly = await runComposition((onRule) => providerFor(onRule));
  const routed = await runComposition((onRule) => routedDecisionProvider(providerFor(onRule)));

  summarize(jevOnly, log);
  summarize(routed, log);

  const now = (options.now ?? (() => new Date()))();
  const outDir = options.outDir ?? resolve("test-results", "jev-live");
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, now.toISOString().replace(/[:.]/g, "-") + ".json");
  await writeFile(
    file,
    JSON.stringify({ generatedAt: now.toISOString(), compositions: [jevOnly, routed] }, null, 2) + "\n",
  );
  log("report written to " + file);

  const results = [jevOnly, routed];
  const unsafe = results.reduce(
    (total, result) => total + result.report.overall.decision.unsafeClick.numerator,
    0,
  );
  const errors = results.reduce(
    (total, result) => total + result.report.overall.decision.providerErrorCount,
    0,
  );
  // 2：出现不安全点击（shadow mode 不能开始）；3：有请求失败，结果不完整，不能当作基线。
  if (unsafe > 0) return 2;
  if (errors > 0) {
    log("incomplete baseline: " + errors + " provider errors");
    return 3;
  }
  return 0;
}

function invokedDirectly(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) return false;
  try {
    // 经符号链接调用时 argv[1] 不是真实路径，而 import.meta.url 是。
    return import.meta.url === pathToFileURL(realpathSync(invokedPath)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await runJevLiveEval({
    argv: process.argv.slice(2),
    env: process.env,
  });
}
