import { describe, expect, it } from "vitest";
import {
  JEV_FIELD_MAX_CODE_POINTS,
  JEV_GOAL_MAX_CODE_POINTS,
  JEV_MODEL,
  JEV_TITLE_MAX_CODE_POINTS,
  OPERATION_OPTIONS,
  assignLabels,
  buildJevRequest,
  truncateCodePoints,
} from "./jevRequest.js";
import { button, candidates, observation } from "./testing.js";

const GOAL = "Open the account settings";

describe("buildJevRequest", () => {
  it("pins the model and presents candidates in observation order, not score order", async () => {
    const obs = observation([
      button("@e_1", "Home"),
      button("@e_2", "Settings"),
      button("@e_3", "Help"),
    ]);
    // CandidateBuilder 的分数顺序与 observation 顺序不同。
    const request = await buildJevRequest({
      observation: obs,
      microGoal: GOAL,
      candidates: candidates(["@e_2", "@e_3", "@e_1"]),
    });

    expect(request.body.model).toBe(JEV_MODEL);
    expect(request.entries.map((entry) => entry.ref)).toEqual(["@e_1", "@e_2", "@e_3"]);
    expect(request.body.state.elements.map((element) => element.name)).toEqual([
      "Home",
      "Settings",
      "Help",
    ]);
    const labels = request.entries.map((entry) => entry.label);
    const questions = request.body.questions as Record<string, { criteria: Record<string, string> }>;
    expect(Object.keys(questions.target_forward!.criteria)).toEqual(labels);
    expect(Object.keys(questions.target_reverse!.criteria)).toEqual([...labels].reverse());
    expect(request.sentOptions).toEqual({
      operation: OPERATION_OPTIONS,
      has_target: null,
      target_forward: labels,
      target_reverse: [...labels].reverse(),
    });
  });

  it("lists escalate first among operation options", async () => {
    const request = await buildJevRequest({
      observation: observation([button("@e_1", "A"), button("@e_2", "B")]),
      microGoal: GOAL,
      candidates: candidates(["@e_1", "@e_2"]),
    });
    const operation = request.body.questions.operation as { criteria: Record<string, string> };
    expect(Object.keys(operation.criteria)).toEqual([
      "escalate",
      "handoff_form",
      "handoff_verify",
      "click",
    ]);
  });

  it("uses opaque, salted, unique labels that do not encode position", async () => {
    const elements = Array.from({ length: 12 }, (_, index) =>
      button("@e_" + (index + 1).toString(36).toUpperCase(), "Item " + index),
    );
    const refs = elements.map((element) => element.ref);
    const first = await buildJevRequest({
      observation: observation(elements, { revision: "rev-1" }),
      microGoal: GOAL,
      candidates: candidates(refs),
    });
    const again = await buildJevRequest({
      observation: observation(elements, { revision: "rev-1" }),
      microGoal: GOAL,
      candidates: candidates(refs),
    });
    const other = await buildJevRequest({
      observation: observation(elements, { revision: "rev-2" }),
      microGoal: GOAL,
      candidates: candidates(refs),
    });

    const labels = first.entries.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) {
      expect(label).toMatch(/^e[0-9a-f]{6,}$/);
      expect(label).not.toMatch(/^e0*(1[0-2]|[1-9])$/);
    }
    expect(again.entries.map((entry) => entry.label)).toEqual(labels);
    // 加 revision 盐：同一 ref 在不同 revision 下得到不同标签。
    expect(other.entries[0]!.label).not.toBe(first.entries[0]!.label);
    expect(JSON.stringify(first.body)).not.toContain("@e_");
  });

  it("takes page coverage from the candidate set, not the observation", async () => {
    const request = await buildJevRequest({
      observation: observation([button("@e_1", "A"), button("@e_2", "B")]),
      microGoal: GOAL,
      candidates: candidates(["@e_1"], "truncated"),
    });
    expect(request.body.state.page.coverage).toBe("truncated");
  });

  it("sends only whitelisted fields", async () => {
    const obs = observation(
      [
        button("@e_1", "Pay", { value: "SECRET-VALUE", frameId: "main" }),
        button("@e_2", "Back"),
        {
          ...button("@f_1", "Card number", { value: "SECRET-FIELD" }),
          kind: "field",
          capabilities: [{ kind: "setValue", valueType: "text" }],
        },
        { ...button("@c_1", "SECRET-NONCANDIDATE"), capabilities: [] },
      ],
      {
        forms: [{ ref: "@r_1", title: "Checkout", fieldRefs: ["@f_1"], actionRefs: ["@e_1"] }],
        dialogs: [
          { title: "Cookie notice", modal: false },
          { title: "SECRET-MODAL", modal: true },
        ],
      },
    );
    const request = await buildJevRequest({
      observation: obs,
      microGoal: GOAL,
      candidates: candidates(["@e_1", "@e_2"]),
    });
    const wire = JSON.stringify(request.body);

    for (const secret of [
      "SECRET-VALUE",
      "SECRET-FIELD",
      "SECRET-NONCANDIDATE",
      "SECRET-URL",
      "SECRET-TITLE",
      "SECRET-MODAL",
      "shop.test",
      "@e_",
      "@r_",
      "geometry",
      "frameId",
      "rect",
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(request.body.state.page).toEqual({
      coverage: "complete",
      forms: [{ title: "Checkout", fieldCount: 1 }],
      dialogs: [{ title: "Cookie notice" }],
    });
    expect(request.body.state.elements[0]).toEqual({
      id: request.entries[0]!.label,
      role: "button",
      name: "Pay",
      submitsForm: "Checkout",
    });
    expect(Object.keys(request.body)).toEqual(["model", "state", "questions"]);
  });

  it("truncates goal, element fields and titles by code points", async () => {
    const long = "😀".repeat(600);
    const request = await buildJevRequest({
      observation: observation(
        [
          button("@e_1", long, { description: long, text: long }),
          button("@e_2", "B"),
        ],
        { forms: [{ ref: "@r_1", title: long, fieldRefs: [], actionRefs: ["@e_1"] }] },
      ),
      microGoal: long,
      candidates: candidates(["@e_1", "@e_2"]),
    });
    const element = request.body.state.elements[0]!;
    for (const field of [element.name, element.description, element.text]) {
      expect(Array.from(field!)).toHaveLength(JEV_FIELD_MAX_CODE_POINTS);
    }
    expect(Array.from(element.submitsForm!)).toHaveLength(JEV_TITLE_MAX_CODE_POINTS);
    expect(Array.from(request.body.state.page.forms[0]!.title!)).toHaveLength(
      JEV_TITLE_MAX_CODE_POINTS,
    );
    const operation = request.body.questions.operation as { instructions: { goal: string } };
    expect(Array.from(operation.instructions.goal)).toHaveLength(JEV_GOAL_MAX_CODE_POINTS);
  });

  it("marks untitled forms with an empty submitsForm", async () => {
    const request = await buildJevRequest({
      observation: observation([button("@e_1", "Go"), button("@e_2", "Back")], {
        forms: [{ ref: "@r_1", fieldRefs: [], actionRefs: ["@e_1"] }],
      }),
      microGoal: GOAL,
      candidates: candidates(["@e_1", "@e_2"]),
    });
    expect(request.body.state.elements[0]!.submitsForm).toBe("");
    expect(request.body.state.elements[1]).not.toHaveProperty("submitsForm");
  });

  it("puts the goal and page-data rules into every question", async () => {
    const request = await buildJevRequest({
      observation: observation([button("@e_1", "A"), button("@e_2", "B")]),
      microGoal: GOAL,
      candidates: candidates(["@e_1", "@e_2"]),
    });
    const questions = Object.values(request.body.questions) as Array<{
      instructions: { goal: string; rules: string[] };
    }>;
    expect(questions).toHaveLength(4);
    for (const question of questions) {
      expect(question.instructions.goal).toBe(GOAL);
      expect(question.instructions.rules.join(" ")).toContain("untrusted web page");
    }
  });

  it("does not ask which target to click when there is only one candidate", async () => {
    const request = await buildJevRequest({
      observation: observation([button("@e_1", "Back")]),
      microGoal: "Submit the order",
      candidates: candidates(["@e_1"]),
    });
    expect(Object.keys(request.body.questions)).toEqual(["operation", "has_target"]);
    expect(Object.keys(request.sentOptions)).toEqual(["operation", "has_target"]);
  });

  it("keys identical outgoing tuples equally and different tuples differently", async () => {
    const request = await buildJevRequest({
      observation: observation([
        button("@e_1", "Delete"),
        button("@e_2", "Delete"),
        button("@e_3", "Delete", { description: "Draft B" }),
      ]),
      microGoal: GOAL,
      candidates: candidates(["@e_1", "@e_2", "@e_3"]),
    });
    const [a, b, c] = request.entries;
    expect(a!.identityKey).toBe(b!.identityKey);
    expect(a!.identityKey).not.toBe(c!.identityKey);
  });

  it("rejects candidate refs that are not in the observation", async () => {
    await expect(
      buildJevRequest({
        observation: observation([button("@e_1", "A")]),
        microGoal: GOAL,
        candidates: candidates(["@e_1", "@e_9"]),
      }),
    ).rejects.toThrow("every candidate ref");
  });
});

describe("assignLabels", () => {
  it("lengthens only colliding prefixes until they are unique", () => {
    const labels = assignLabels(
      new Map([
        ["@a", "abcdef01" + "0".repeat(56)],
        ["@b", "abcdef02" + "0".repeat(56)],
        ["@c", "123456ff" + "0".repeat(56)],
      ]),
    );
    expect(labels.get("@a")).toBe("eabcdef01");
    expect(labels.get("@b")).toBe("eabcdef02");
    expect(labels.get("@c")).toBe("e123456");
  });
});

describe("truncateCodePoints", () => {
  it("keeps short values and cuts by code point", () => {
    expect(truncateCodePoints(undefined, 3)).toBeUndefined();
    expect(truncateCodePoints("abc", 3)).toBe("abc");
    expect(truncateCodePoints("😀😀😀😀", 3)).toBe("😀😀😀");
  });
});
