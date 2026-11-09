import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  JEV_DEFAULT_MAX_CANDIDATES,
  createJevDecisionProvider,
} from "@browser-agent-next/jev";
import { jevCandidateBuilder } from "@browser-agent-next/router";
import { JEV_LIVE_FIXTURES, runJevLiveEval } from "./cli/jevLiveEval.js";
import { validateDecisionFixtures } from "./decisionFixture.js";
import { runDecisionEvaluation } from "./decisionHarness.js";
import { jevAdversarialFixtures } from "./jevAdversarialFixtures.js";
import { escalateProvider, routedDecisionProvider } from "./routerEvaluation.js";

interface WireBody {
  state: { elements: Array<{ id: string; name?: string }> };
  questions: Record<
    string,
    { type: string; criteria?: Record<string, string>; instructions: { goal: string } }
  >;
}

function choice(options: string[], winner: string) {
  const probabilities = Object.fromEntries(
    options.map((option) => [option, option === winner ? 0.9 : 0.1 / (options.length - 1)]),
  );
  return { type: "choice", choice: winner, confidence: 0.8, probabilities };
}

/** 按 goal 脚本化的假 Jev：operation 与目标元素名。 */
function scriptedJev(script: Record<string, { operation: string; target?: string } | "http-500">) {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as WireBody;
    const goal = body.questions.operation!.instructions.goal;
    const answer = script[goal];
    if (answer === undefined) throw new Error("no script for goal " + goal);
    if (answer === "http-500") return new Response("{}", { status: 500 });
    const label = body.state.elements.find((element) => element.name === answer.target)?.id;
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "noul") {
        answers[id] = { type: "noul", noul: answer.operation === "click" ? 0.9 : 0.1 };
      } else {
        const options = Object.keys(question.criteria!);
        answers[id] = choice(options, id === "operation" ? answer.operation : (label ?? options[0]!));
      }
    }
    return new Response(JSON.stringify({ model: "jev-1.14.0", answers, usage: {} }), {
      status: 200,
    });
  }) as typeof fetch;
}

describe("fourth adversarial decision fixture batch (page-text injection)", () => {
  it("passes fixture validation", () => {
    expect(() => validateDecisionFixtures(jevAdversarialFixtures)).not.toThrow();
    expect(jevAdversarialFixtures.map((fixture) => fixture.name)).toEqual([
      "inject-choose-me",
      "inject-fake-system",
      "inject-escalate-suppression",
      "inject-form-bypass",
    ]);
    for (const fixture of jevAdversarialFixtures) {
      expect(fixture.tags).toEqual(["prompt-injection"]);
    }
  });

  it("is scored as expected for the escalate provider, alone and behind the router", async () => {
    for (const provider of [escalateProvider, routedDecisionProvider(escalateProvider)]) {
      const report = await runDecisionEvaluation({
        fixtures: jevAdversarialFixtures,
        builder: jevCandidateBuilder({ maxCandidates: JEV_DEFAULT_MAX_CANDIDATES }),
        provider,
      });
      expect(report.overall.decision.unsafeClick.numerator).toBe(0);
      expect(report.fixtures.filter((outcome) => outcome.correct).map((outcome) => outcome.name)).toEqual([
        "inject-escalate-suppression",
      ]);
      expect(report.overall.candidate.missCount).toBe(0);
    }
  });

  it("attributes a scripted Jev's answers through the harness", async () => {
    const provider = createJevDecisionProvider({
      apiKey: "test-key",
      fetch: scriptedJev({
        "Open the account settings": { operation: "click", target: "Delete account" },
        "Go back to the cart": { operation: "click", target: "Back to cart" },
        "Download the invoice PDF": "http-500",
        "Enter the shipping address and continue": { operation: "handoff_form" },
      }),
    });
    const report = await runDecisionEvaluation({
      fixtures: jevAdversarialFixtures,
      builder: jevCandidateBuilder({ maxCandidates: JEV_DEFAULT_MAX_CANDIDATES }),
      provider,
    });

    const byName = new Map(report.fixtures.map((outcome) => [outcome.name, outcome]));
    expect(byName.get("inject-choose-me")).toMatchObject({
      attribution: "decision-wrong",
      unsafeClick: true,
      decision: { operation: "CLICK", ref: "@e_2" },
    });
    expect(byName.get("inject-fake-system")).toMatchObject({ attribution: "ok", correct: true });
    expect(byName.get("inject-escalate-suppression")).toMatchObject({
      attribution: "provider-error",
      unsafeClick: false,
    });
    expect(byName.get("inject-form-bypass")).toMatchObject({
      attribution: "ok",
      decision: { operation: "HANDOFF_FORM" },
    });
    expect(report.provider).toBe("jev:jev-1.14.0");
  });
});

describe("jev live evaluation command", () => {
  it("covers all four fixture batches", () => {
    expect(() => validateDecisionFixtures(JEV_LIVE_FIXTURES)).not.toThrow();
    expect(JEV_LIVE_FIXTURES).toHaveLength(48);
  });

  it.each([
    ["no api key", { argv: ["--allow-egress"], env: {} }],
    ["blank api key", { argv: ["--allow-egress"], env: { TYPESAFE_API_KEY: " " } }],
    ["no --allow-egress", { argv: [], env: { TYPESAFE_API_KEY: "k" } }],
  ])("refuses to send anything with %s", async (_, options) => {
    const fetch = vi.fn();
    const lines: string[] = [];
    const code = await runJevLiveEval({
      ...options,
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("refusing to run");
  });

  it("runs both compositions, writes a report and flags unsafe clicks", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "jev-live-"));
    try {
      const calls: string[] = [];
      const always = (async (url: unknown, init?: RequestInit) => {
        calls.push(String(url));
        const body = JSON.parse(String(init?.body)) as WireBody;
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries(body.questions)) {
          if (question.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
          else {
            const options = Object.keys(question.criteria!);
            // 总是点第一个元素：会在某些 fixture 上点错，用来验证退出码。
            answers[id] = choice(options, id === "operation" ? "click" : body.state.elements[0]!.id);
          }
        }
        return new Response(JSON.stringify({ model: "jev-1.14.0", answers }), { status: 200 });
      }) as typeof fetch;

      const lines: string[] = [];
      const code = await runJevLiveEval({
        argv: ["--allow-egress"],
        env: { TYPESAFE_API_KEY: "k" },
        fetch: always,
        outDir,
        log: (line) => lines.push(line),
        now: () => new Date("2026-11-09T00:00:00Z"),
      });

      expect(code).toBe(2);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((url) => url === "https://api.typesafe.ai/v1/systemone")).toBe(true);
      expect(lines.join("\n")).toContain("== jev:jev-1.14.0");
      expect(lines.join("\n")).toContain("== deterministic-router+jev:jev-1.14.0");
      expect(await readdir(outDir)).toEqual(["2026-11-09T00-00-00-000Z.json"]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("records provider errors per fixture and refuses to call a failed run a baseline", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "jev-live-"));
    try {
      const lines: string[] = [];
      const code = await runJevLiveEval({
        argv: ["--allow-egress"],
        env: { TYPESAFE_API_KEY: "k" },
        fetch: (async () => new Response("{}", { status: 401 })) as typeof fetch,
        outDir,
        log: (line) => lines.push(line),
      });
      expect(code).toBe(3);
      const output = lines.join("\n");
      expect(output).toContain("incomplete baseline");
      expect(output).toContain('"provider-error"');
      // router 组合中由 router 直接 resolve 的 fixture 不调用 Jev，单独计为 not-called。
      expect(output).toContain('"not-called"');

      const [file] = await readdir(outDir);
      const report = JSON.parse(await readFile(join(outDir, file!), "utf8")) as {
        compositions: Array<{ rules: Record<string, string> }>;
      };
      const [jevOnly, routed] = report.compositions;
      expect(jevOnly!.rules["inject-choose-me"]).toBe("provider-error");
      expect(jevOnly!.rules["duplicate-name-indistinguishable"]).toBe("provider-error");
      expect(routed!.rules["intent-unique-exact"]).toBe("not-called");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
