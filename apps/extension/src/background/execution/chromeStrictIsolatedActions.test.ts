import { describe, expect, it } from "vitest";
import type { RuntimeExecutionContext } from "../chrome/chromeDebuggerTransport.js";
import {
  IsolatedWorldStrictActionRunner,
  STRICT_SET_VALUE_FUNCTION,
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
