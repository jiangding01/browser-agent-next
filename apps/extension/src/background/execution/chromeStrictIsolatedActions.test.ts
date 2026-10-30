import { describe, expect, it } from "vitest";
import type { RuntimeExecutionContext } from "../chrome/chromeDebuggerTransport.js";
import {
  IsolatedWorldStrictActionRunner,
  STRICT_KEY_ARM_FUNCTION,
  STRICT_KEY_READ_FUNCTION,
  STRICT_SELECT_OPTION_FUNCTION,
  STRICT_SET_VALUE_FUNCTION,
  STRICT_SUBMIT_FUNCTION,
  interpretKeyArmResult,
  interpretKeyReadResult,
  interpretSelectResult,
  interpretSubmitResult,
  interpretWriteResult,
} from "./chromeStrictIsolatedActions.js";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const SECRET_VALUE = "value-CANARY-42";

const target = {
  tabId: 7,
  cdpFrameId: "frame-main",
  frameEpoch: "epoch-1",
  stableId: "s9",
};

function context(
  id: number,
  overrides: Partial<RuntimeExecutionContext> = {},
): RuntimeExecutionContext {
  return {
    id,
    origin: EXTENSION_ORIGIN,
    auxData: { frameId: "frame-main", type: "isolated", isDefault: false },
    ...overrides,
  };
}

interface Options {
  contexts?: RuntimeExecutionContext[];
  bridge?: unknown;
  meta?: unknown;
  write?: () => unknown;
}

function harness(options: Options = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const transport = {
    async attach() {},
    contextsForFrame: () => options.contexts ?? [context(11)],
    async send<T>(_tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      if (method === "Runtime.evaluate") {
        return (options.bridge ?? { result: { objectId: "bridge-1" } }) as T;
      }
      if (method === "Runtime.callFunctionOn") {
        if (params?.functionDeclaration === STRICT_SET_VALUE_FUNCTION) {
          return (options.write?.() ??
            { result: { value: { status: "written", accepted: true, valueMatched: true } } }) as T;
        }
        return (options.meta ?? { result: { value: { version: 1, frameEpoch: "epoch-1" } } }) as T;
      }
      return {} as T;
    },
  };
  return {
    calls,
    writer: new IsolatedWorldStrictActionRunner(transport, EXTENSION_ORIGIN),
    writeCalls: () =>
      calls.filter((call) => call.params?.functionDeclaration === STRICT_SET_VALUE_FUNCTION),
  };
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected failure");
}

describe("IsolatedWorldStrictActionRunner（setValue）", () => {
  it("writes through the single extension isolated world, passing value only as an argument", async () => {
    const { writer, writeCalls, calls } = harness();

    await expect(writer.run(target, { kind: "setValue", value: SECRET_VALUE })).resolves.toEqual({ valueMatched: true });
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0]?.params).toMatchObject({
      objectId: "bridge-1",
      arguments: [{ value: "s9" }, { value: SECRET_VALUE }],
      returnByValue: true,
    });
    expect(calls.find((call) => call.method === "Runtime.evaluate")?.params).toMatchObject({
      contextId: 11,
    });
    expect(calls.at(-1)?.method).toBe("Runtime.releaseObjectGroup");
  });

  it("refuses before touching the page unless exactly one matching isolated world exists", async () => {
    const cases: RuntimeExecutionContext[][] = [
      [],
      [context(11), context(12)],
      [context(11, { origin: "chrome-extension://another-extension-id-xxxxxxx" })],
      [context(11, { auxData: { frameId: "frame-main", type: "default", isDefault: true } })],
    ];
    for (const contexts of cases) {
      const { writer, writeCalls } = harness({ contexts });
      const error = await failure(writer.run(target, { kind: "setValue", value: SECRET_VALUE }));
      expect(error.code).toBe("TARGET_IDENTITY_MISMATCH");
      expect(writeCalls()).toHaveLength(0);
    }
  });

  it("refuses before writing when the bridge is missing or belongs to another document", async () => {
    for (const options of [
      { bridge: { result: {} } },
      { bridge: { result: { objectId: "bridge-1" }, exceptionDetails: {} } },
      { meta: { result: { value: { version: 1, frameEpoch: "epoch-OLD" } } } },
      { meta: { result: { value: { version: 2, frameEpoch: "epoch-1" } } } },
    ]) {
      const { writer, writeCalls } = harness(options);
      const error = await failure(writer.run(target, { kind: "setValue", value: SECRET_VALUE }));
      expect(error.code, JSON.stringify(options)).toBe("TARGET_IDENTITY_MISMATCH");
      expect(writeCalls()).toHaveLength(0);
    }
  });

  it("reports an unknown outcome once the write call may have run", async () => {
    for (const write of [
      () => {
        throw new Error("debugger detached");
      },
      () => ({ result: { value: null }, exceptionDetails: { text: "boom" } }),
      () => ({ result: { value: { status: "written" } } }),
    ]) {
      const { writer } = harness({ write });
      const error = await failure(writer.run(target, { kind: "setValue", value: SECRET_VALUE }));
      expect(error.code).toBe("ACTION_OUTCOME_UNKNOWN");
      expect(error.message).not.toContain(SECRET_VALUE);
    }
  });
});

describe("interpretWriteResult", () => {
  it("maps every write-function result to the documented outcome", () => {
    const code = (value: unknown) => {
      try {
        interpretWriteResult(value);
        return "ok";
      } catch (error) {
        return (error as { code: string }).code;
      }
    };

    expect(code({ status: "rejected", reason: "sensitive" })).toBe("POLICY_BLOCKED");
    expect(code({ status: "rejected", reason: "unsupported" })).toBe("ACTION_NOT_SUPPORTED");
    expect(code({ status: "rejected", reason: "missing" })).toBe("TARGET_IDENTITY_MISMATCH");
    expect(code({ status: "rejected", reason: "other" })).toBe("ACTION_OUTCOME_UNKNOWN");
    expect(code({ status: "focus-lost" })).toBe("ACTION_OUTCOME_UNKNOWN");
    expect(code({ status: "changed-during-focus" })).toBe("ACTION_OUTCOME_UNKNOWN");
    expect(code({ status: "written", accepted: false, valueMatched: false })).toBe(
      "ACTION_OUTCOME_UNKNOWN",
    );
    expect(code({ status: "written", accepted: "yes", valueMatched: true })).toBe(
      "ACTION_OUTCOME_UNKNOWN",
    );
    expect(code(undefined)).toBe("ACTION_OUTCOME_UNKNOWN");
    expect(interpretWriteResult({ status: "written", accepted: true, valueMatched: false })).toEqual({
      valueMatched: false,
    });
  });

  it("re-checks the field after focus and before inserting, inside one function", () => {
    const focusAt = STRICT_SET_VALUE_FUNCTION.indexOf("element.focus(");
    const activeCheckAt = STRICT_SET_VALUE_FUNCTION.indexOf("activeElement !== element");
    const recheckAt = STRICT_SET_VALUE_FUNCTION.indexOf("if (check() !== undefined)");
    const insertAt = STRICT_SET_VALUE_FUNCTION.indexOf('"insertText"');

    expect(focusAt).toBeGreaterThan(0);
    expect(activeCheckAt).toBeGreaterThan(focusAt);
    expect(recheckAt).toBeGreaterThan(activeCheckAt);
    expect(insertAt).toBeGreaterThan(recheckAt);
    expect(STRICT_SET_VALUE_FUNCTION).not.toMatch(/\bawait\b|setTimeout|Promise/);
  });
});

const SECRET_LABEL = "label-CANARY-77";

interface RunnerOptions {
  /** 按页面函数源码返回 Runtime.callFunctionOn 的结果；未列出的函数视为 bridge 元数据调用。 */
  page?: Partial<Record<string, (args: unknown[]) => unknown>>;
  /** Input.dispatchKeyEvent 的行为；抛错模拟派发失败。 */
  dispatch?: (params: Record<string, unknown>) => void;
}

function runnerHarness(options: RunnerOptions = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const transport = {
    async attach() {},
    contextsForFrame: () => [context(11)],
    async send<T>(_tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "bridge-1" } } as T;
      }
      if (method === "Input.dispatchKeyEvent") {
        options.dispatch?.(params ?? {});
        return {} as T;
      }
      if (method === "Runtime.callFunctionOn") {
        const declaration = String(params?.functionDeclaration);
        const handler = options.page?.[declaration];
        if (handler) {
          const values = (params?.arguments as Array<{ value: unknown }>).map((arg) => arg.value);
          return { result: { value: handler(values) } } as T;
        }
        return { result: { value: { version: 1, frameEpoch: "epoch-1" } } } as T;
      }
      return {} as T;
    },
  };
  const pageFunctions = new Set([
    STRICT_SET_VALUE_FUNCTION,
    STRICT_SELECT_OPTION_FUNCTION,
    STRICT_SUBMIT_FUNCTION,
    STRICT_KEY_ARM_FUNCTION,
    STRICT_KEY_READ_FUNCTION,
  ]);
  return {
    calls,
    runner: new IsolatedWorldStrictActionRunner(transport, EXTENSION_ORIGIN),
    /** 页面函数调用与按键派发，按发生顺序；bridge 与 releaseObjectGroup 不计。 */
    steps: () =>
      calls.flatMap((call) => {
        if (call.method === "Input.dispatchKeyEvent") {
          return ["dispatch:" + String(call.params?.type)];
        }
        const declaration = call.params?.functionDeclaration;
        if (call.method === "Runtime.callFunctionOn" && pageFunctions.has(declaration as string)) {
          return [nameOf(declaration as string)];
        }
        return [];
      }),
  };
}

function nameOf(declaration: string): string {
  switch (declaration) {
    case STRICT_SET_VALUE_FUNCTION:
      return "setValue";
    case STRICT_SELECT_OPTION_FUNCTION:
      return "select";
    case STRICT_SUBMIT_FUNCTION:
      return "submit";
    case STRICT_KEY_ARM_FUNCTION:
      return "arm";
    case STRICT_KEY_READ_FUNCTION:
      return "read";
  }
  return "other";
}

function outcome(interpret: (value: unknown) => unknown, value: unknown) {
  try {
    interpret(value);
    return { code: "ok" };
  } catch (error) {
    const { code, message, details } = error as {
      code: string;
      message: string;
      details?: unknown;
    };
    return { code, message, details };
  }
}

describe("interpretSelectResult / interpretSubmitResult / interpretKeyArmResult / interpretKeyReadResult", () => {
  it("maps selectOption results, distinguishing missing and ambiguous options by reason", () => {
    expect(outcome(interpretSelectResult, { status: "rejected", reason: "option-not-found" })).toMatchObject({
      code: "TARGET_CAPABILITY_MISSING",
      details: { reason: "option-not-found" },
    });
    expect(outcome(interpretSelectResult, { status: "rejected", reason: "option-ambiguous" })).toMatchObject({
      code: "TARGET_CAPABILITY_MISSING",
      details: { reason: "option-ambiguous" },
    });
    expect(outcome(interpretSelectResult, { status: "rejected", reason: "sensitive" }).code).toBe("POLICY_BLOCKED");
    expect(outcome(interpretSelectResult, { status: "rejected", reason: "unsupported" }).code).toBe(
      "ACTION_NOT_SUPPORTED",
    );
    expect(outcome(interpretSelectResult, { status: "rejected", reason: "missing" }).code).toBe(
      "TARGET_IDENTITY_MISMATCH",
    );
    // 别的动作的拒绝原因不被 selectOption 接受。
    expect(outcome(interpretSelectResult, { status: "rejected", reason: "form-invalid" }).code).toBe(
      "ACTION_OUTCOME_UNKNOWN",
    );
    for (const value of [
      undefined,
      null,
      "written",
      { status: "written" },
      { status: "written", valueMatched: "yes" },
      { status: "submitted" },
    ]) {
      expect(outcome(interpretSelectResult, value).code, JSON.stringify(value)).toBe("ACTION_OUTCOME_UNKNOWN");
    }
    expect(interpretSelectResult({ status: "written", valueMatched: false })).toEqual({ valueMatched: false });
    expect(interpretSelectResult({ status: "written", valueMatched: true })).toEqual({ valueMatched: true });
  });

  it("maps submit results: invalid forms are a safe NO_EFFECT, unobserved submits are unknown", () => {
    expect(outcome(interpretSubmitResult, { status: "rejected", reason: "form-invalid" })).toMatchObject({
      code: "NO_EFFECT",
      details: { reason: "form-invalid" },
    });
    for (const reason of ["has-submit-button", "not-own-form", "custom-control"]) {
      expect(outcome(interpretSubmitResult, { status: "rejected", reason })).toMatchObject({
        code: "ACTION_NOT_SUPPORTED",
        details: { reason },
      });
    }
    expect(outcome(interpretSubmitResult, { status: "rejected", reason: "unsupported" }).code).toBe(
      "ACTION_NOT_SUPPORTED",
    );
    expect(outcome(interpretSubmitResult, { status: "rejected", reason: "missing" }).code).toBe(
      "TARGET_IDENTITY_MISMATCH",
    );
    for (const value of [
      { status: "not-observed" },
      { status: "rejected", reason: "sensitive" },
      { status: "rejected", reason: "option-not-found" },
      { status: "written", valueMatched: true },
      undefined,
    ]) {
      expect(outcome(interpretSubmitResult, value).code, JSON.stringify(value)).toBe("ACTION_OUTCOME_UNKNOWN");
    }
    expect(interpretSubmitResult({ status: "submitted" })).toEqual({});
  });

  it("maps pressKey arm and read results; only one trusted keydown on the target is success", () => {
    expect(outcome(interpretKeyArmResult, { status: "armed" }).code).toBe("ok");
    expect(outcome(interpretKeyArmResult, { status: "rejected", reason: "sensitive" }).code).toBe("POLICY_BLOCKED");
    expect(outcome(interpretKeyArmResult, { status: "rejected", reason: "unsupported" }).code).toBe(
      "ACTION_NOT_SUPPORTED",
    );
    expect(outcome(interpretKeyArmResult, { status: "rejected", reason: "missing" }).code).toBe(
      "TARGET_IDENTITY_MISMATCH",
    );
    for (const value of [
      { status: "focus-lost" },
      { status: "changed-during-focus" },
      { status: "rejected", reason: "has-submit-button" },
      { status: "pressed" },
      undefined,
    ]) {
      expect(outcome(interpretKeyArmResult, value).code, JSON.stringify(value)).toBe("ACTION_OUTCOME_UNKNOWN");
    }

    expect(interpretKeyReadResult({ status: "pressed" })).toEqual({});
    for (const value of [
      { status: "misrouted", count: 0 },
      { status: "misrouted", count: 2 },
      { status: "expired" },
      { status: "armed" },
      null,
    ]) {
      expect(outcome(interpretKeyReadResult, value).code, JSON.stringify(value)).toBe("ACTION_OUTCOME_UNKNOWN");
    }
  });

  it("uses fixed messages that never echo caller arguments or page-provided reasons", () => {
    const pageReason = "reason-CANARY-13";
    const results = [
      outcome(interpretSelectResult, { status: "rejected", reason: "option-not-found", label: SECRET_LABEL }),
      outcome(interpretSelectResult, { status: "rejected", reason: pageReason }),
      outcome(interpretSubmitResult, { status: "rejected", reason: pageReason }),
      outcome(interpretKeyArmResult, { status: "rejected", reason: pageReason }),
      outcome(interpretKeyReadResult, { status: pageReason }),
    ];
    for (const result of results) {
      expect(result.message).not.toContain(SECRET_LABEL);
      expect(result.message).not.toContain(pageReason);
      expect(JSON.stringify(result.details ?? null)).not.toContain(pageReason);
    }
  });
});

describe("IsolatedWorldStrictActionRunner（S2）", () => {
  it("passes the label only as an argument and never echoes it", async () => {
    const { runner, calls } = runnerHarness({
      page: { [STRICT_SELECT_OPTION_FUNCTION]: () => ({ status: "rejected", reason: "option-not-found" }) },
    });
    const error = await failure(runner.run(target, { kind: "selectOption", label: SECRET_LABEL }));
    expect(error.code).toBe("TARGET_CAPABILITY_MISSING");
    expect(error.message).not.toContain(SECRET_LABEL);
    const selectCall = calls.find((call) => call.params?.functionDeclaration === STRICT_SELECT_OPTION_FUNCTION);
    expect(selectCall?.params?.arguments).toEqual([{ value: "s9" }, { value: SECRET_LABEL }]);
    expect(STRICT_SELECT_OPTION_FUNCTION).not.toContain(SECRET_LABEL);
  });

  it("submits through one page function call with only the stable id", async () => {
    const { runner, calls, steps } = runnerHarness({
      page: { [STRICT_SUBMIT_FUNCTION]: () => ({ status: "submitted" }) },
    });
    await expect(runner.run(target, { kind: "submit" })).resolves.toEqual({});
    expect(steps()).toEqual(["submit"]);
    expect(
      calls.find((call) => call.params?.functionDeclaration === STRICT_SUBMIT_FUNCTION)?.params?.arguments,
    ).toEqual([{ value: "s9" }]);
  });

  it("presses a key as arm → keyDown → keyUp → read, with one token shared by both calls", async () => {
    const tokens: unknown[] = [];
    const { runner, calls, steps } = runnerHarness({
      page: {
        [STRICT_KEY_ARM_FUNCTION]: (args) => {
          tokens.push(args[2]);
          return { status: "armed" };
        },
        [STRICT_KEY_READ_FUNCTION]: (args) => {
          tokens.push(args[0]);
          return { status: "pressed" };
        },
      },
    });

    await expect(runner.run(target, { kind: "pressKey", key: "Tab" })).resolves.toEqual({});
    expect(steps()).toEqual(["arm", "dispatch:keyDown", "dispatch:keyUp", "read"]);
    expect(
      calls.find((call) => call.params?.functionDeclaration === STRICT_KEY_ARM_FUNCTION)?.params?.arguments,
    ).toEqual([{ value: "s9" }, { value: "Tab" }, { value: tokens[0] }]);
    expect(typeof tokens[0]).toBe("string");
    expect(tokens[1]).toBe(tokens[0]);
    for (const call of calls.filter((entry) => entry.method === "Input.dispatchKeyEvent")) {
      expect(call.params).toMatchObject({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      expect(call.params).not.toHaveProperty("text");
    }
    expect(calls.at(-1)?.method).toBe("Runtime.releaseObjectGroup");
  });

  it("uses the documented key codes and a fresh token for every press", async () => {
    const expected = {
      Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
      Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
      ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
      ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
    } as const;
    const tokens = new Set<unknown>();
    const { runner, calls } = runnerHarness({
      page: {
        [STRICT_KEY_ARM_FUNCTION]: (args) => {
          tokens.add(args[2]);
          return { status: "armed" };
        },
        [STRICT_KEY_READ_FUNCTION]: () => ({ status: "pressed" }),
      },
    });
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      await runner.run(target, { kind: "pressKey", key });
      const dispatches = calls.filter(
        (call) => call.method === "Input.dispatchKeyEvent" && call.params?.key === key,
      );
      expect(dispatches.map((call) => call.params?.type)).toEqual(["keyDown", "keyUp"]);
      for (const call of dispatches) {
        expect(call.params).toMatchObject(expected[key]);
      }
    }
    expect(tokens.size).toBe(4);
  });

  it("does not dispatch a key when arming is refused or fails after focus", async () => {
    for (const armed of [
      { status: "rejected", reason: "sensitive" },
      { status: "rejected", reason: "unsupported" },
      { status: "focus-lost" },
      { status: "changed-during-focus" },
    ]) {
      const { runner, steps } = runnerHarness({ page: { [STRICT_KEY_ARM_FUNCTION]: () => armed } });
      await failure(runner.run(target, { kind: "pressKey", key: "Escape" }));
      expect(steps(), JSON.stringify(armed)).toEqual(["arm"]);
    }
  });

  it("reports an unknown outcome when the dispatch fails or the read cannot prove delivery", async () => {
    const dispatchFails = runnerHarness({
      page: {
        [STRICT_KEY_ARM_FUNCTION]: () => ({ status: "armed" }),
        [STRICT_KEY_READ_FUNCTION]: () => ({ status: "pressed" }),
      },
      dispatch: (params) => {
        if (params.type === "keyUp") throw new Error("detached");
      },
    });
    expect((await failure(dispatchFails.runner.run(target, { kind: "pressKey", key: "Tab" }))).code).toBe(
      "ACTION_OUTCOME_UNKNOWN",
    );
    expect(dispatchFails.steps()).toEqual(["arm", "dispatch:keyDown", "dispatch:keyUp"]);

    for (const read of [{ status: "misrouted", count: 0 }, { status: "misrouted", count: 2 }, { status: "expired" }]) {
      const { runner } = runnerHarness({
        page: {
          [STRICT_KEY_ARM_FUNCTION]: () => ({ status: "armed" }),
          [STRICT_KEY_READ_FUNCTION]: () => read,
        },
      });
      expect((await failure(runner.run(target, { kind: "pressKey", key: "ArrowDown" }))).code).toBe(
        "ACTION_OUTCOME_UNKNOWN",
      );
    }
  });
});

describe("IsolatedWorldStrictActionRunner 按 tab 串行", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function gatedRunner() {
    const log: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const failures = new Set<string>();
    const transport = {
      async attach(tabId: number) {
        log.push("attach:" + tabId);
      },
      contextsForFrame: () => [context(11)],
      async send<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
        if (method === "Runtime.evaluate") return { result: { objectId: "bridge-" + tabId } } as T;
        if (method === "Runtime.callFunctionOn" && params?.functionDeclaration === STRICT_SUBMIT_FUNCTION) {
          const id = String((params.arguments as Array<{ value: unknown }>)[0]?.value);
          log.push("submit:" + id + ":start");
          await gates.get(id)?.promise;
          log.push("submit:" + id + ":end");
          if (failures.has(id)) throw new Error("detached");
          return { result: { value: { status: "submitted" } } } as T;
        }
        if (method === "Runtime.callFunctionOn") {
          return { result: { value: { version: 1, frameEpoch: "epoch-1" } } } as T;
        }
        return {} as T;
      },
    };
    const gate = (id: string) => {
      const entry = deferred();
      gates.set(id, entry);
      return entry;
    };
    return {
      log,
      gate,
      fail: (id: string) => failures.add(id),
      runner: new IsolatedWorldStrictActionRunner(transport, EXTENSION_ORIGIN),
    };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const on = (tabId: number, stableId: string) => ({ ...target, tabId, stableId });

  it("starts the second action on a tab only after the first has finished", async () => {
    const { log, gate, runner } = gatedRunner();
    const first = gate("a");
    const one = runner.run(on(7, "a"), { kind: "submit" });
    const two = runner.run(on(7, "b"), { kind: "submit" });
    await flush();
    expect(log).toEqual(["attach:7", "submit:a:start"]);

    first.resolve();
    await Promise.all([one, two]);
    expect(log).toEqual(["attach:7", "submit:a:start", "submit:a:end", "attach:7", "submit:b:start", "submit:b:end"]);
  });

  it("does not block another tab", async () => {
    const { log, gate, runner } = gatedRunner();
    const blocked = gate("a");
    const one = runner.run(on(7, "a"), { kind: "submit" });
    await flush();
    await expect(runner.run(on(8, "b"), { kind: "submit" })).resolves.toEqual({});
    expect(log).not.toContain("submit:a:end");

    blocked.resolve();
    await one;
  });

  it("runs the next action after the previous one failed", async () => {
    const { log, fail, runner } = gatedRunner();
    fail("a");
    const one = runner.run(on(7, "a"), { kind: "submit" });
    const two = runner.run(on(7, "b"), { kind: "submit" });
    expect((await failure(one)).code).toBe("ACTION_OUTCOME_UNKNOWN");
    await expect(two).resolves.toEqual({});
    expect(log.indexOf("submit:b:start")).toBeGreaterThan(log.indexOf("submit:a:end"));
  });
});

describe("S2 页面函数源码", () => {
  it("reaches form properties, methods and listeners only through prototypes", () => {
    expect(STRICT_SUBMIT_FUNCTION).toContain("const formProto = view.HTMLFormElement.prototype");
    expect(STRICT_SUBMIT_FUNCTION).toContain('formGetter("elements").call(form)');
    expect(STRICT_SUBMIT_FUNCTION).toContain('formGetter("noValidate").call(form)');
    expect(STRICT_SUBMIT_FUNCTION).toContain("formProto.requestSubmit.call(form)");
    expect(STRICT_SUBMIT_FUNCTION).toContain("const eventTarget = view.EventTarget.prototype");
    expect(STRICT_SUBMIT_FUNCTION).toContain('eventTarget.addEventListener.call(form, "submit"');
    expect(STRICT_SUBMIT_FUNCTION).toContain('eventTarget.removeEventListener.call(form, "submit"');
    expect(STRICT_SUBMIT_FUNCTION).toContain("view.Node.prototype.getRootNode.call(form)");
    expect(STRICT_SUBMIT_FUNCTION).toContain('query.call(root, "input")');
    // 表单实例上不得直接读写任何属性（同名控件会覆盖它们）。
    expect(STRICT_SUBMIT_FUNCTION).not.toMatch(/\bform\.\w/);
    expect(STRICT_SUBMIT_FUNCTION).not.toMatch(/\bdoc\.\w/);
  });

  it("calls execCommand through the Document prototype", () => {
    expect(STRICT_SET_VALUE_FUNCTION).toContain("view.Document.prototype.execCommand");
    expect(STRICT_SET_VALUE_FUNCTION).not.toMatch(/\b(?:doc|document)\.execCommand/);
  });

  it("registers the key probe before focusing and never awaits inside the arm call", () => {
    const listenAt = STRICT_KEY_ARM_FUNCTION.indexOf('eventTarget.addEventListener.call(view, "keydown"');
    const focusAt = STRICT_KEY_ARM_FUNCTION.indexOf("element.focus(");
    const firstCheckAt = STRICT_KEY_ARM_FUNCTION.indexOf("const before = check()");
    expect(firstCheckAt).toBeGreaterThan(0);
    expect(listenAt).toBeGreaterThan(firstCheckAt);
    expect(focusAt).toBeGreaterThan(listenAt);
    expect(STRICT_KEY_ARM_FUNCTION).toContain("event.isTrusted && event.key === key");
    expect(STRICT_KEY_ARM_FUNCTION).toContain("event.composedPath()[0] === element");
    expect(STRICT_KEY_ARM_FUNCTION).not.toMatch(/\bawait\b|Promise/);
    expect(STRICT_KEY_READ_FUNCTION).toContain("records.length === 1 && records[0] === true");
  });

  it("selects an option without focusing and without yielding", () => {
    expect(STRICT_SELECT_OPTION_FUNCTION).not.toContain("focus(");
    expect(STRICT_SELECT_OPTION_FUNCTION).not.toMatch(/\bawait\b|setTimeout|Promise/);
    expect(STRICT_SUBMIT_FUNCTION).not.toContain("focus(");
    expect(STRICT_SUBMIT_FUNCTION).not.toMatch(/\bawait\b|setTimeout|Promise/);
  });
});
