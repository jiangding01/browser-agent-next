import { describe, expect, it } from "vitest";
import type { DecisionProviderInput } from "@browser-agent-next/router";
import {
  JEV_MIN_PROBABILITY,
  JEV_PROVIDER_NAME,
  createJevDecisionProvider,
  type JevCallRecord,
} from "./jevDecisionProvider.js";
import {
  button,
  candidates,
  fakeFetch,
  jsonResponse,
  observation,
  scriptedResponse,
  type ScriptedAnswers,
  type SentRequest,
} from "./testing.js";

const API_KEY = "test-key-SECRET";

function setup(
  script: ScriptedAnswers | ((request: SentRequest) => Response),
) {
  const records: JevCallRecord[] = [];
  const fake = fakeFetch((request) =>
    typeof script === "function"
      ? script(request)
      : jsonResponse(scriptedResponse(request.body, script)),
  );
  const provider = createJevDecisionProvider({
    apiKey: API_KEY,
    fetch: fake.fetch,
    onCall: (record) => records.push(record),
  });
  return { provider, records, requests: fake.requests };
}

const settingsPage = observation([
  button("@e_1", "Home"),
  button("@e_2", "Settings"),
  button("@e_3", "Delete account"),
]);

function input(
  obs = settingsPage,
  refs = obs.elements.map((element) => element.ref),
  goal = "Open the account settings",
): DecisionProviderInput {
  return { observation: obs, microGoal: goal, candidates: candidates(refs) };
}

describe("createJevDecisionProvider", () => {
  it("requires a non-empty api key and names itself after the pinned model", () => {
    expect(() => createJevDecisionProvider({ apiKey: "" })).toThrow("apiKey");
    expect(() => createJevDecisionProvider({ apiKey: "   " })).toThrow("apiKey");
    expect(createJevDecisionProvider({ apiKey: "k" }).name).toBe(JEV_PROVIDER_NAME);
    expect(JEV_PROVIDER_NAME).toBe("jev:jev-1.14.0");
  });
});

describe("pre-gates", () => {
  it("escalates without a request when there are no candidates", async () => {
    const { provider, requests, records } = setup({});
    await expect(provider.decide(input(settingsPage, []))).resolves.toEqual({
      operation: "ESCALATE",
    });
    expect(requests).toHaveLength(0);
    expect(records).toEqual([{ rule: "no-candidates", minProbability: JEV_MIN_PROBABILITY }]);
  });

  it.each<[string, Parameters<typeof observation>[1]]>([
    ["blocking overlay", { overlays: [{ kind: "modal", blocking: true }] }],
    ["modal dialog", { dialogs: [{ title: "Sign up", modal: true }] }],
  ])("escalates without a request on a %s", async (_, layer) => {
    const { provider, requests, records } = setup({});
    const obs = observation(settingsPage.elements, layer);
    await expect(provider.decide(input(obs))).resolves.toEqual({ operation: "ESCALATE" });
    expect(requests).toHaveLength(0);
    expect(records[0]!.rule).toBe("blocking-layer");
  });

  it.each<[string, () => DecisionProviderInput]>([
    ["duplicate candidate refs", () => input(settingsPage, ["@e_2", "@e_2"])],
    [
      "a candidate ref repeated in the observation",
      () => input(observation([button("@e_1", "Home"), button("@e_2", "Settings"), button("@e_2", "Settings")]), ["@e_1", "@e_2"]),
    ],
    ["a candidate missing from the observation", () => input(settingsPage, ["@e_1", "@e_9"])],
    [
      "one candidate repeated while another is missing (same count)",
      () => input(observation([button("@e_1", "Home"), button("@e_1", "Home")]), ["@e_1", "@e_2"]),
    ],
    [
      "a disabled candidate",
      () => {
        const disabled = button("@e_2", "Settings");
        disabled.state.enabled = false;
        return input(observation([button("@e_1", "Home"), disabled]), ["@e_1", "@e_2"]);
      },
    ],
  ])("rejects %s without a request", async (_, makeInput) => {
    const { provider, requests } = setup({ forward: { name: "Settings" } });
    await expect(provider.decide(makeInput())).rejects.toMatchObject({ kind: "invalid-request" });
    expect(requests).toHaveLength(0);
  });

  it("throws on more candidates than a Choice can hold", async () => {
    const elements = Array.from({ length: 256 }, (_, index) => button("@e_" + index, "Item " + index));
    const { provider, requests } = setup({});
    await expect(provider.decide(input(observation(elements)))).rejects.toMatchObject({
      kind: "invalid-request",
    });
    expect(requests).toHaveLength(0);
  });
});

describe("decision rules", () => {
  it.each([
    ["escalate", "ESCALATE"],
    ["handoff_form", "HANDOFF_FORM"],
    ["handoff_verify", "HANDOFF_VERIFY"],
  ] as const)("returns %s answers as non-click operations", async (option, operation) => {
    const { provider, records } = setup({ operation: { [option]: 0.8, click: 0.2 } });
    const decision = await provider.decide(input());
    expect(decision.operation).toBe(operation);
    expect(decision.confidence).toBeGreaterThan(0);
    expect(records[0]!.rule).toBe("non-click");
  });

  it("clicks when every gate passes and maps the label back to the ref", async () => {
    const { provider, records, requests } = setup({ forward: { name: "Settings" } });
    const decision = await provider.decide(input());
    expect(decision).toMatchObject({ operation: "CLICK", ref: "@e_2" });
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(requests).toHaveLength(1);
    expect(records[0]).toMatchObject({
      rule: "click",
      model: "jev-1.14.0",
      usage: { inputTokens: 123, outputTokens: 0 },
      minProbability: JEV_MIN_PROBABILITY,
    });
    expect(records[0]!.answers?.targetForward?.choice).toBe(records[0]!.answers?.targetReverse?.choice);
  });

  it("ignores the score order of the candidate set", async () => {
    const { provider } = setup({ forward: { name: "Settings" } });
    const decision = await provider.decide(input(settingsPage, ["@e_3", "@e_2", "@e_1"]));
    expect(decision).toMatchObject({ operation: "CLICK", ref: "@e_2" });
  });

  it("escalates when the two orders disagree", async () => {
    const { provider, records } = setup({
      forward: { name: "Settings" },
      reverse: { name: "Home" },
    });
    await expect(provider.decide(input())).resolves.toEqual({ operation: "ESCALATE" });
    expect(records[0]!.rule).toBe("order-disagree");
  });

  it.each([
    ["click probability", { operation: { click: 0.69, escalate: 0.31 }, forward: { name: "Settings" } }, "below-threshold"],
    ["has_target", { hasTarget: 0.69, forward: { name: "Settings" } }, "no-target"],
    ["forward target", { forward: { name: "Settings", p: 0.69 }, reverse: { name: "Settings" } }, "below-threshold"],
    ["reverse target", { forward: { name: "Settings" }, reverse: { name: "Settings", p: 0.69 } }, "below-threshold"],
  ] as const)("escalates when %s is below the threshold", async (_, script, rule) => {
    const { provider, records } = setup(script);
    await expect(provider.decide(input())).resolves.toEqual({ operation: "ESCALATE" });
    expect(records[0]!.rule).toBe(rule);
  });

  it("treats probabilities equal to the threshold as passing", async () => {
    const { provider } = setup({
      operation: { click: 0.7, escalate: 0.3 },
      hasTarget: 0.7,
      forward: { name: "Settings", p: 0.7 },
    });
    await expect(provider.decide(input())).resolves.toMatchObject({ operation: "CLICK", ref: "@e_2" });
  });

  it("does not click the only candidate when has_target says no (disabled-submit shape)", async () => {
    const obs = observation([button("@e_1", "Back")]);
    const { provider, requests, records } = setup({ hasTarget: 0.2 });
    await expect(provider.decide(input(obs, ["@e_1"], "Submit the order"))).resolves.toEqual({
      operation: "ESCALATE",
    });
    expect(Object.keys(requests[0]!.body.questions)).toEqual(["operation", "has_target"]);
    expect(records[0]!.rule).toBe("no-target");
  });

  it("clicks the only candidate when operation and has_target agree", async () => {
    const obs = observation([button("@e_1", "Continue")]);
    const { provider } = setup({});
    await expect(provider.decide(input(obs, ["@e_1"], "Continue"))).resolves.toMatchObject({
      operation: "CLICK",
      ref: "@e_1",
    });
  });
});

describe("post-gates", () => {
  it("escalates on a candidate indistinguishable from another one", async () => {
    const obs = observation([button("@e_1", "Delete"), button("@e_2", "Delete")]);
    const { provider, records } = setup({ forward: { name: "Delete" } });
    await expect(
      provider.decide(input(obs, ["@e_1", "@e_2"], "Delete the draft named Quarterly report")),
    ).resolves.toEqual({ operation: "ESCALATE" });
    expect(records[0]!.rule).toBe("indistinguishable");
  });

  it.each([
    ["trailing whitespace", "Delete", "Delete "],
    ["letter case", "Delete", "DELETE"],
    ["zero-width character", "Delete", "Del\u200Bete"],
  ])("treats candidates differing only by %s as indistinguishable", async (_, first, second) => {
    const obs = observation([button("@e_1", first), button("@e_2", second)]);
    const { provider, records } = setup({ forward: { name: first } });
    await expect(provider.decide(input(obs))).resolves.toEqual({ operation: "ESCALATE" });
    expect(records[0]!.rule).toBe("indistinguishable");
  });

  it("treats an empty name and a missing name alike", async () => {
    const unnamed = button("@e_2", "x", { description: "Remove" });
    delete (unnamed.semantic as { name?: string }).name;
    const obs = observation([button("@e_1", "", { description: "Remove" }), unnamed]);
    const fake = fakeFetch((request) => {
      const response = scriptedResponse(request.body, {});
      const label = request.body.state.elements[0]!.id as string;
      for (const id of ["target_forward", "target_reverse"]) {
        const answer = (response.answers as Record<string, { choice: string; probabilities: Record<string, number> }>)[id]!;
        answer.probabilities = Object.fromEntries(
          Object.keys(answer.probabilities).map((key) => [key, key === label ? 0.9 : 0.1]),
        );
        answer.choice = label;
      }
      return jsonResponse(response);
    });
    const records: JevCallRecord[] = [];
    const provider = createJevDecisionProvider({
      apiKey: API_KEY,
      fetch: fake.fetch,
      onCall: (record) => records.push(record),
    });
    await expect(provider.decide(input(obs))).resolves.toEqual({ operation: "ESCALATE" });
    expect(records[0]!.rule).toBe("indistinguishable");
  });

  it("compares against look-alike clickables truncated out of the candidate set", async () => {
    // 0 分同档跨过截断线：第二个 Delete 不在候选集里。
    const obs = observation([button("@e_1", "Delete"), button("@e_2", "Other"), button("@e_3", "Delete")]);
    const { provider, records, requests } = setup({ forward: { name: "Delete" } });
    await expect(
      provider.decide({
        observation: obs,
        microGoal: "Remove the quarterly draft",
        candidates: { refs: ["@e_1", "@e_2"], coverage: "truncated", totalKnown: 3 },
      }),
    ).resolves.toEqual({ operation: "ESCALATE" });
    expect(records[0]!.rule).toBe("indistinguishable");
    // 比较只在本地进行，候选集外的元素不出境。
    expect(requests[0]!.body.state.elements).toHaveLength(2);
  });

  it("clicks same-named candidates that differ in description", async () => {
    const obs = observation([
      button("@e_1", "Delete", { description: "Draft A" }),
      button("@e_2", "Delete", { description: "Quarterly report" }),
    ]);
    const fake = fakeFetch((request) => {
      const label = request.body.state.elements.find(
        (element) => element.description === "Quarterly report",
      )!.id as string;
      const response = scriptedResponse(request.body, {});
      for (const id of ["target_forward", "target_reverse"]) {
        const answer = (response.answers as Record<string, { choice: string; probabilities: Record<string, number> }>)[id]!;
        answer.probabilities = Object.fromEntries(
          Object.keys(answer.probabilities).map((key) => [key, key === label ? 0.9 : 0.1]),
        );
        answer.choice = label;
      }
      return jsonResponse(response);
    });
    const provider = createJevDecisionProvider({ apiKey: API_KEY, fetch: fake.fetch });
    await expect(
      provider.decide(input(obs, ["@e_1", "@e_2"], "Delete the draft named Quarterly report")),
    ).resolves.toMatchObject({ operation: "CLICK", ref: "@e_2" });
  });

  it.each([
    ["occluded", { hitTestable: false }],
    ["out-of-viewport", { inViewport: false }],
  ] as const)("escalates on an %s target", async (rule, geometry) => {
    const obs = observation([button("@e_1", "Home"), button("@e_2", "Settings", geometry)]);
    const { provider, records } = setup({ forward: { name: "Settings" } });
    await expect(provider.decide(input(obs))).resolves.toEqual({ operation: "ESCALATE" });
    expect(records[0]!.rule).toBe(rule);
  });

  it("escalates when the target frame origin cannot be determined", async () => {
    const obs = observation(
      [button("@e_1", "Home"), button("@e_2", "Settings", { frameId: "child" })],
      {
        frames: [
          { frameId: "main", documentEpoch: "d", accessible: true },
          { frameId: "child", parentFrameId: "main", documentEpoch: "c", accessible: true },
        ],
      },
    );
    const { provider, records } = setup({ forward: { name: "Settings" } });
    await expect(provider.decide(input(obs))).resolves.toEqual({ operation: "ESCALATE" });
    expect(records[0]!.rule).toBe("origin-unknown");
  });

  it("still clicks a target in a resolvable cross-origin frame (child-frame-target shape)", async () => {
    const obs = observation(
      [button("@e_1", "Home"), button("@e_2", "Pay", { frameId: "child" })],
      {
        frames: [
          { frameId: "main", documentEpoch: "d", accessible: true },
          {
            frameId: "child",
            parentFrameId: "main",
            documentEpoch: "c",
            accessible: true,
            origin: "https://payments.test",
          },
        ],
      },
    );
    const { provider } = setup({ forward: { name: "Pay" } });
    await expect(
      provider.decide(input(obs, ["@e_1", "@e_2"], "Pay with the embedded payment form")),
    ).resolves.toMatchObject({ operation: "CLICK", ref: "@e_2" });
  });
});

describe("response validation", () => {
  async function expectInvalid(mutate: (response: Record<string, any>) => void) {
    const { provider } = setup((request) => {
      const response = scriptedResponse(request.body, { forward: { name: "Settings" } }) as Record<string, any>;
      mutate(response);
      return jsonResponse(response);
    });
    await expect(provider.decide(input())).rejects.toMatchObject({
      name: "JevProviderError",
      kind: "invalid-response",
    });
  }

  it.each([
    ["missing model", (r: Record<string, any>) => delete r.model],
    ["missing answers", (r: Record<string, any>) => delete r.answers],
    ["missing question", (r: Record<string, any>) => delete r.answers.target_reverse],
    ["extra question", (r: Record<string, any>) => (r.answers.extra = { type: "noul", noul: 0.5 })],
    ["wrong type", (r: Record<string, any>) => (r.answers.operation.type = "noul")],
    ["unknown option", (r: Record<string, any>) => (r.answers.operation.choice = "submit")],
    ["unknown target label", (r: Record<string, any>) => (r.answers.target_forward.choice = "e000000")],
    ["choice is not the maximum", (r: Record<string, any>) => (r.answers.operation.choice = "escalate")],
    ["missing probability key", (r: Record<string, any>) => delete r.answers.operation.probabilities.escalate],
    ["extra probability key", (r: Record<string, any>) => (r.answers.operation.probabilities.other = 0)],
    ["NaN probability", (r: Record<string, any>) => (r.answers.operation.probabilities.escalate = Number.NaN)],
    ["probability above one", (r: Record<string, any>) => (r.answers.operation.probabilities.escalate = 1.5)],
    ["confidence out of range", (r: Record<string, any>) => (r.answers.operation.confidence = -0.1)],
    ["noul out of range", (r: Record<string, any>) => (r.answers.has_target.noul = 2)],
    ["probabilities as an array", (r: Record<string, any>) => (r.answers.operation.probabilities = [0.1, 0.1, 0.1, 0.7])],
    ["a different model version", (r: Record<string, any>) => (r.model = "jev-1.15.0")],
    [
      "unnormalized probabilities that tie above the threshold",
      (r: Record<string, any>) => {
        for (const id of ["operation", "target_forward", "target_reverse"]) {
          const answer = r.answers[id];
          for (const key of Object.keys(answer.probabilities)) answer.probabilities[key] = 0.9;
        }
      },
    ],
  ])("rejects %s", async (_, mutate) => {
    await expectInvalid(mutate);
  });

  it("rejects two options that both reach the threshold (sum 1.4)", async () => {
    await expectInvalid((r) => {
      r.answers.operation.probabilities = { escalate: 0, handoff_form: 0, handoff_verify: 0.7, click: 0.7 };
      r.answers.operation.choice = "click";
    });
  });

  it("tolerates probabilities that sum to one within rounding", async () => {
    const { provider } = setup((request) => {
      const response = scriptedResponse(request.body, { forward: { name: "Settings" } }) as Record<string, any>;
      response.answers.operation.probabilities.escalate += 0.05;
      return jsonResponse(response);
    });
    await expect(provider.decide(input())).resolves.toMatchObject({ operation: "CLICK", ref: "@e_2" });
  });

  it("keeps only numeric usage counters in call records", async () => {
    const { provider, records } = setup((request) => {
      const response = scriptedResponse(request.body, { forward: { name: "Settings" } }) as Record<string, any>;
      response.usage = { input_tokens: 10, output_tokens: "SENTINEL", echo: "SENTINEL" };
      return jsonResponse(response);
    });
    await provider.decide(input());
    expect(records[0]!.usage).toEqual({ inputTokens: 10 });
    expect(JSON.stringify(records)).not.toContain("SENTINEL");
  });

  it("accepts a tied maximum (and escalates because ties stay below the threshold)", async () => {
    const { provider } = setup((request) => {
      const response = scriptedResponse(request.body, {
        operation: { click: 0.5, escalate: 0.5 },
      });
      (response.answers as Record<string, { choice: string }>).operation!.choice = "click";
      return jsonResponse(response);
    });
    await expect(provider.decide(input())).resolves.toEqual({ operation: "ESCALATE" });
  });
});

describe("transport", () => {
  it("posts once to the pinned endpoint with the bearer key", async () => {
    const { provider, requests } = setup({ forward: { name: "Settings" } });
    await provider.decide(input());
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(requests[0]!.init.method).toBe("POST");
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer " + API_KEY,
    );
    expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]!.init.redirect).toBe("error");
  });

  it.each([400, 401, 422, 429, 500, 529])("fails HTTP %i once without retrying", async (status) => {
    const { provider, requests } = setup(() => jsonResponse({ detail: "nope" }, status));
    await expect(provider.decide(input())).rejects.toMatchObject({ kind: "http", status });
    expect(requests).toHaveLength(1);
  });

  it("reports timeouts and network failures", async () => {
    const timeout = createJevDecisionProvider({
      apiKey: API_KEY,
      fetch: (async () => {
        throw new DOMException("timed out", "TimeoutError");
      }) as typeof fetch,
    });
    await expect(timeout.decide(input())).rejects.toMatchObject({ kind: "timeout" });

    const network = createJevDecisionProvider({
      apiKey: API_KEY,
      fetch: (async () => {
        throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.typesafe.ai");
      }) as typeof fetch,
    });
    await expect(network.decide(input())).rejects.toMatchObject({ kind: "network" });
  });

  it("rejects a body that is not JSON", async () => {
    const { provider } = setup(() => new Response("<html>", { status: 200 }));
    await expect(provider.decide(input())).rejects.toMatchObject({ kind: "invalid-response" });
  });

  it("keeps page text and the api key out of errors", async () => {
    const sentinel = "SENTINEL-PAGE-TEXT";
    const obs = observation([button("@e_1", sentinel), button("@e_2", "Settings")]);
    const { provider } = setup((request) =>
      jsonResponse({ detail: JSON.stringify(request.body) + " key=" + API_KEY }, 400),
    );
    const error = await Promise.resolve(provider.decide(input(obs))).then(
      () => {
        throw new Error("expected a failure");
      },
      (caught: unknown) => caught as Error,
    );
    const rendered = [
      error.message,
      JSON.stringify(error),
      String(error.stack),
      String((error as { cause?: unknown }).cause),
    ].join("\n");
    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toContain(API_KEY);
    expect(error).not.toHaveProperty("cause");
  });

  it("keeps the api key and payload out of call records", async () => {
    const { provider, records } = setup({ forward: { name: "Settings" } });
    await provider.decide(input());
    const rendered = JSON.stringify(records);
    expect(rendered).not.toContain(API_KEY);
    expect(rendered).not.toContain("Settings");
  });
});
