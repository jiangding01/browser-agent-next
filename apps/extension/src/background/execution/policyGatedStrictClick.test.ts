import { describe, expect, it, vi } from "vitest";
import { BrowserRuntimeError } from "@browser-agent-next/core";
import { InMemoryAuthorizationStore } from "@browser-agent-next/policy";
import { StrictClickDispatchError } from "./chromeStrictClickDispatcher.js";
import { PolicyGatedStrictClickExecutor } from "./policyGatedStrictClick.js";
import type { StrictClickPresentationFence } from "./rootPresentationFence.js";

function prepared(
  ownedBySession = true,
) {
  return {
    action: {
      actionId: "a1",
      kind: "click" as const,
      observedRevision: "rev-1",
      target: { ref: "@e_1" },
    },
    observation: {
      tab: {
        tabId: 7,
        title: "Fixture",
        url: "https://fixture.test/",
        origin: "https://fixture.test",
        ownedBySession,
      },
    },
    expected: {},
    prepared: {
      tabId: 7,
      ref: "@e_1",
      stableId: "s1",
      backendNodeId: 42,
      cdpFrameId: "cdp-main",
      frameEpoch: "frame-a",
      point: { x: 10, y: 20 },
    },
  };
}

function noPresentationFence(): StrictClickPresentationFence {
  return {
    required: () => false,
    async waitForPresentedFrames() {
      throw new Error("presentation fence must not run");
    },
  };
}

function authorizedStore(): InMemoryAuthorizationStore {
  const authorizations = new InMemoryAuthorizationStore();

  authorizations.issue({
    id: "grant-1",
    tabId: 7,
    observedRevision: "rev-1",
    ref: "@e_1",
    actionKind: "click",
    effectClass: "unknown",
    assurance: "control-plane",
    ttlMs: 5000,
    source: "trusted-host",
  });

  return authorizations;
}

describe("PolicyGatedStrictClickExecutor", () => {
  it("未知副作用且没有 hard authorization 时绝不 dispatch", async () => {
    const dispatch = vi.fn(async () => undefined);

    const executor = new PolicyGatedStrictClickExecutor(
      {
        async prepare() {
          return prepared() as never;
        },
      } as never,
      { dispatch } as never,
      new InMemoryAuthorizationStore(),
      { isAllowed: () => true },
      noPresentationFence(),
    );

    await expect(
      executor.execute({
        tabId: 7,
        actionId: "a1",
        observedRevision: "rev-1",
        ref: "@e_1",
      }),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_REQUIRED",
    } satisfies Partial<BrowserRuntimeError>);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("精确绑定的 trusted grant 才允许执行，并在 commit 前再次 prepare", async () => {
    const prepare = vi.fn(async () => prepared() as never);
    const dispatch = vi.fn(async () => undefined);

    const executor = new PolicyGatedStrictClickExecutor(
      { prepare } as never,
      { dispatch } as never,
      authorizedStore(),
      { isAllowed: () => true },
      noPresentationFence(),
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).resolves.toMatchObject({
      status: "executed",
      ref: "@e_1",
    });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("第二次 prepare 期间授权过期时不 dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    try {
      const authorizations = new InMemoryAuthorizationStore();
      authorizations.issue({
        id: "grant-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        actionKind: "click",
        effectClass: "unknown",
        assurance: "control-plane",
        ttlMs: 10,
        source: "trusted-host",
      });
      const prepare = vi.fn(async () => {
        if (prepare.mock.calls.length === 2) {
          vi.setSystemTime(1010);
        }
        return prepared() as never;
      });
      const dispatch = vi.fn(async () => undefined);
      const executor = new PolicyGatedStrictClickExecutor(
        { prepare } as never,
        { dispatch } as never,
        authorizations,
        { isAllowed: () => true },
        noPresentationFence(),
      );

      await expect(executor.execute({
        tabId: 7,
        actionId: "a1",
        observedRevision: "rev-1",
        ref: "@e_1",
        authorizationId: "grant-1",
      })).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      } satisfies Partial<BrowserRuntimeError>);

      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("用户已有 Tab 的 unknown click 不接受 control-plane grant", async () => {
    const dispatch = vi.fn(async () => undefined);

    const executor = new PolicyGatedStrictClickExecutor(
      {
        async prepare() {
          return prepared(false) as never;
        },
      } as never,
      { dispatch } as never,
      authorizedStore(),
      { isAllowed: () => true },
      noPresentationFence(),
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).rejects.toMatchObject({
      code: "AUTHORIZATION_REQUIRED",
    } satisfies Partial<BrowserRuntimeError>);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("origin 不在 allowlist 时即使有授权也拒绝", async () => {
    const dispatch = vi.fn(async () => undefined);

    const executor = new PolicyGatedStrictClickExecutor(
      {
        async prepare() {
          return prepared() as never;
        },
      } as never,
      { dispatch } as never,
      authorizedStore(),
      { isAllowed: () => false },
      noPresentationFence(),
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
    } satisfies Partial<BrowserRuntimeError>);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("输入已可能影响页面时转换为 ACTION_OUTCOME_UNKNOWN，禁止自动 retry", async () => {
    const executor = new PolicyGatedStrictClickExecutor(
      {
        async prepare() {
          return prepared() as never;
        },
      } as never,
      {
        async dispatch() {
          throw new StrictClickDispatchError(
            "release failed",
            {
              phase: "mouse-pressed",
              outcomeMayHaveChanged: true,
              cause: new Error("target closed"),
            },
          );
        },
      } as never,
      authorizedStore(),
      { isAllowed: () => true },
      noPresentationFence(),
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).rejects.toMatchObject({
      code: "ACTION_OUTCOME_UNKNOWN",
    } satisfies Partial<BrowserRuntimeError>);
  });

  it("mousePressed transport failure 转换为 ACTION_OUTCOME_UNKNOWN，且不重放 click", async () => {
    const dispatch = vi.fn(async () => {
      throw new StrictClickDispatchError(
        "debugger response lost after mouse press dispatch",
        {
          phase: "mouse-pressed",
          outcomeMayHaveChanged: true,
          cause: new Error("debugger detached"),
        },
      );
    });

    const executor = new PolicyGatedStrictClickExecutor(
      {
        async prepare() {
          return prepared() as never;
        },
      } as never,
      { dispatch } as never,
      authorizedStore(),
      { isAllowed: () => true },
      noPresentationFence(),
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).rejects.toMatchObject({
      code: "ACTION_OUTCOME_UNKNOWN",
      details: {
        phase: "mouse-pressed",
      },
    } satisfies Partial<BrowserRuntimeError>);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("PolicyGatedStrictClickExecutor presentation fence", () => {
  function childPrepared(
    point: { x: number; y: number },
  ) {
    const base = prepared();

    return {
      ...base,
      prepared: {
        ...base.prepared,
        cdpFrameId: "cdp-child",
        cdpSessionId: "child-session",
        coordinateSpace: "top-level-viewport" as const,
        point,
      },
    };
  }

  function fence(
    result:
      | { ok: true; frames: number }
      | { ok: false; reason: string },
    onWait?: () => void,
  ) {
    const waitForPresentedFrames = vi.fn(async () => {
      onWait?.();
      return result;
    });

    return {
      required: vi.fn(
        (target: { cdpSessionId?: string }) =>
          target.cdpSessionId !== undefined,
      ),
      waitForPresentedFrames,
    };
  }

  it("跨 process 路由时先 fence，再重新 prepare，并只 dispatch fence 之后确认的点", async () => {
    const events: string[] = [];
    const prepare = vi.fn(async () => {
      events.push("prepare");
      return childPrepared({ x: 346.5, y: 360.25 }) as never;
    });
    const dispatch = vi.fn(async () => {
      events.push("dispatch");
    });
    const presentation = fence(
      { ok: true, frames: 3 },
      () => events.push("fence"),
    );

    const executor = new PolicyGatedStrictClickExecutor(
      { prepare } as never,
      { dispatch } as never,
      authorizedStore(),
      { isAllowed: () => true },
      presentation,
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).resolves.toMatchObject({
      status: "executed",
    });

    expect(events).toEqual([
      "prepare",
      "prepare",
      "fence",
      "prepare",
      "dispatch",
    ]);
    expect(presentation.waitForPresentedFrames)
      .toHaveBeenCalledWith(7);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpSessionId: "child-session",
        point: { x: 346.5, y: 360.25 },
      }),
    );
  });

  it("root renderer 未 present 时在任何 input 前 fail closed", async () => {
    const prepare = vi.fn(async () =>
      childPrepared({ x: 10, y: 20 }) as never
    );
    const dispatch = vi.fn(async () => undefined);

    const executor = new PolicyGatedStrictClickExecutor(
      { prepare } as never,
      { dispatch } as never,
      authorizedStore(),
      { isAllowed: () => true },
      fence({
        ok: false,
        reason: "root renderer did not present 3 animation frames within 5000ms",
      }),
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).rejects.toMatchObject({
      code: "TARGET_NOT_VISIBLE",
    } satisfies Partial<BrowserRuntimeError>);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fence 期间 top-level 点发生变化时拒绝 dispatch，且不自动重试", async () => {
    const points = [
      { x: 10, y: 20 },
      { x: 10, y: 20 },
      { x: 10, y: 260 },
    ];
    const prepare = vi.fn(async () =>
      childPrepared(points.shift()!) as never
    );
    const dispatch = vi.fn(async () => undefined);

    const executor = new PolicyGatedStrictClickExecutor(
      { prepare } as never,
      { dispatch } as never,
      authorizedStore(),
      { isAllowed: () => true },
      fence({ ok: true, frames: 3 }),
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).rejects.toMatchObject({
      code: "TARGET_IDENTITY_MISMATCH",
    } satisfies Partial<BrowserRuntimeError>);

    expect(prepare).toHaveBeenCalledTimes(3);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["cdpSessionId", { cdpSessionId: "replacement-session" }],
    ["frameEpoch", { frameEpoch: "frame-b" }],
    ["backendNodeId", { backendNodeId: 43 }],
    ["stableId", { stableId: "s2" }],
  ])(
    "fence 前后 %s 变化时拒绝 dispatch",
    async (_field, change) => {
      let calls = 0;
      const prepare = vi.fn(async () => {
        calls += 1;
        const base = childPrepared({ x: 10, y: 20 });
        return (
          calls === 3
            ? {
                ...base,
                prepared: {
                  ...base.prepared,
                  ...change,
                },
              }
            : base
        ) as never;
      });
      const dispatch = vi.fn(async () => undefined);

      const executor = new PolicyGatedStrictClickExecutor(
        { prepare } as never,
        { dispatch } as never,
        authorizedStore(),
        { isAllowed: () => true },
        fence({ ok: true, frames: 3 }),
      );

      await expect(executor.execute({
        tabId: 7,
        actionId: "a1",
        observedRevision: "rev-1",
        ref: "@e_1",
        authorizationId: "grant-1",
      })).rejects.toMatchObject({
        code: "TARGET_IDENTITY_MISMATCH",
      } satisfies Partial<BrowserRuntimeError>);

      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("fence 之后的第三次 prepare 期间授权过期时不 dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    try {
      const authorizations = new InMemoryAuthorizationStore();
      authorizations.issue({
        id: "grant-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        actionKind: "click",
        effectClass: "unknown",
        assurance: "control-plane",
        ttlMs: 10,
        source: "trusted-host",
      });
      const prepare = vi.fn(async () => {
        if (prepare.mock.calls.length === 3) {
          vi.setSystemTime(1010);
        }
        return childPrepared({ x: 10, y: 20 }) as never;
      });
      const dispatch = vi.fn(async () => undefined);

      const executor = new PolicyGatedStrictClickExecutor(
        { prepare } as never,
        { dispatch } as never,
        authorizations,
        { isAllowed: () => true },
        fence({ ok: true, frames: 3 }),
      );

      await expect(executor.execute({
        tabId: 7,
        actionId: "a1",
        observedRevision: "rev-1",
        ref: "@e_1",
        authorizationId: "grant-1",
      })).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      } satisfies Partial<BrowserRuntimeError>);

      expect(prepare).toHaveBeenCalledTimes(3);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fence 等待期间授权过期时不 dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    try {
      const authorizations = new InMemoryAuthorizationStore();
      authorizations.issue({
        id: "grant-1",
        tabId: 7,
        observedRevision: "rev-1",
        ref: "@e_1",
        actionKind: "click",
        effectClass: "unknown",
        assurance: "control-plane",
        ttlMs: 10,
        source: "trusted-host",
      });
      const dispatch = vi.fn(async () => undefined);

      const executor = new PolicyGatedStrictClickExecutor(
        {
          async prepare() {
            return childPrepared({ x: 10, y: 20 }) as never;
          },
        } as never,
        { dispatch } as never,
        authorizations,
        { isAllowed: () => true },
        fence(
          { ok: true, frames: 3 },
          () => vi.setSystemTime(1010),
        ),
      );

      await expect(executor.execute({
        tabId: 7,
        actionId: "a1",
        observedRevision: "rev-1",
        ref: "@e_1",
        authorizationId: "grant-1",
      })).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      } satisfies Partial<BrowserRuntimeError>);

      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("不需要跨 process 路由时不等待 fence", async () => {
    const prepare = vi.fn(async () => prepared() as never);
    const dispatch = vi.fn(async () => undefined);
    const presentation = fence({ ok: true, frames: 3 });

    const executor = new PolicyGatedStrictClickExecutor(
      { prepare } as never,
      { dispatch } as never,
      authorizedStore(),
      { isAllowed: () => true },
      presentation,
    );

    await expect(executor.execute({
      tabId: 7,
      actionId: "a1",
      observedRevision: "rev-1",
      ref: "@e_1",
      authorizationId: "grant-1",
    })).resolves.toMatchObject({
      status: "executed",
    });

    expect(presentation.waitForPresentedFrames)
      .not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
