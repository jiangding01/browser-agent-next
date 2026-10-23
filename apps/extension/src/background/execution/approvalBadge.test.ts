import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  APPROVAL_BADGE_COLOR,
  APPROVAL_BADGE_TITLE,
  bindOperatorApprovalBadge,
  type ApprovalBadgeActionApi,
  type ApprovalBadgeSource,
} from "./approvalBadge.js";
import {
  OperatorApprovalStore,
} from "./operatorApprovalStore.js";

function fakeTimers() {
  let nextHandle = 1;
  const timers = new Map<
    number,
    { callback: () => void; ms: number }
  >();
  const setTimer = vi.fn(
    (callback: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, ms });
      return handle;
    },
  );
  const clearTimer = vi.fn((handle: unknown) => {
    timers.delete(handle as number);
  });

  return {
    timers,
    setTimer,
    clearTimer,
    /** 触发当前所有活跃的定时器（先摘除再回调）。 */
    fire() {
      const due = [...timers.entries()];
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.callback();
      }
    },
  };
}

function fakeAction() {
  return {
    setBadgeText: vi.fn(
      (_details: { text: string }) =>
        Promise.resolve(),
    ),
    setBadgeBackgroundColor: vi.fn(
      (_details: { color: string }) =>
        Promise.resolve(),
    ),
    setTitle: vi.fn(
      (_details: { title: string }) =>
        Promise.resolve(),
    ),
  } satisfies ApprovalBadgeActionApi;
}

function fakeApprovals(initial = 0) {
  let pendingCount = initial;
  let expiry: number | undefined;
  const listeners = new Set<(count: number) => void>();
  const unsubscribe = vi.fn();

  const approvals = {
    subscribe: vi.fn((listener: (count: number) => void) => {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    }),
    listPending: vi.fn(() =>
      Array.from({ length: pendingCount }, () => ({})),
    ),
    nextExpiryAt: vi.fn(() => expiry),
  };

  return {
    approvals: approvals as unknown as ApprovalBadgeSource,
    mocks: approvals,
    unsubscribe,
    listeners,
    setCount(count: number) {
      pendingCount = count;
    },
    setExpiry(value: number | undefined) {
      expiry = value;
    },
    emit(count: number) {
      for (const listener of [...listeners]) {
        listener(count);
      }
    },
  };
}

function lastCall<T>(mock: { mock: { calls: T[][] } }) {
  return mock.mock.calls[mock.mock.calls.length - 1]![0];
}

describe("bindOperatorApprovalBadge", () => {
  it("启动时设置背景色并按 listPending 渲染（0 个）", () => {
    const action = fakeAction();
    const { approvals } = fakeApprovals(0);
    const timers = fakeTimers();

    bindOperatorApprovalBadge(action, approvals, {
      now: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: APPROVAL_BADGE_COLOR,
    });
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(action.setTitle).toHaveBeenCalledWith({
      title: "Browser Agent 审批",
    });
    expect(APPROVAL_BADGE_TITLE).toBe("Browser Agent 审批");
  });

  it("启动时已有 N 个待处理则渲染数字与带计数的 title", () => {
    const action = fakeAction();
    const { approvals } = fakeApprovals(3);
    const timers = fakeTimers();

    bindOperatorApprovalBadge(action, approvals, {
      now: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "3" });
    expect(action.setTitle).toHaveBeenCalledWith({
      title: "Browser Agent 审批（3 个待处理）",
    });
  });

  it("change 回调更新角标与 title", () => {
    const action = fakeAction();
    const fake = fakeApprovals(0);
    const timers = fakeTimers();

    bindOperatorApprovalBadge(action, fake.approvals, {
      now: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    fake.emit(2);
    expect(lastCall(action.setBadgeText)).toEqual({ text: "2" });
    expect(lastCall(action.setTitle)).toEqual({
      title: "Browser Agent 审批（2 个待处理）",
    });

    fake.emit(0);
    expect(lastCall(action.setBadgeText)).toEqual({ text: "" });
    expect(lastCall(action.setTitle)).toEqual({
      title: "Browser Agent 审批",
    });
  });

  it("定时器按 nextExpiryAt - now + 50 调度", () => {
    const action = fakeAction();
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    fake.setExpiry(10_000);

    bindOperatorApprovalBadge(action, fake.approvals, {
      now: () => 4_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    expect(timers.setTimer).toHaveBeenCalledTimes(1);
    expect(timers.setTimer.mock.calls[0]![1]).toBe(6_050);
  });

  it("定时器间隔最小 250ms（已过期或临近过期）", () => {
    const action = fakeAction();
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    fake.setExpiry(1_000);

    bindOperatorApprovalBadge(action, fake.approvals, {
      now: () => 5_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(timers.setTimer.mock.calls[0]![1]).toBe(250);

    // 4_900 - 4_700 + 50 = 250 的边界，以及更小的 210
    fake.emit(1);
    fake.setExpiry(5_160);
    fake.emit(1);
    expect(timers.setTimer.mock.calls.at(-1)![1]).toBe(250);
  });

  it("定时器到点无条件调用 listPending 并重新调度（即使没有 change）", () => {
    const action = fakeAction();
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    let now = 0;
    fake.setExpiry(1_000);

    bindOperatorApprovalBadge(action, fake.approvals, {
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    expect(fake.mocks.listPending).toHaveBeenCalledTimes(1);
    expect(timers.setTimer).toHaveBeenCalledTimes(1);

    now = 1_050;
    fake.setExpiry(3_000);
    timers.fire();

    expect(fake.mocks.listPending).toHaveBeenCalledTimes(2);
    expect(timers.setTimer).toHaveBeenCalledTimes(2);
    expect(timers.setTimer.mock.calls[1]![1]).toBe(
      3_000 - 1_050 + 50,
    );

    now = 3_050;
    fake.setExpiry(undefined);
    timers.fire();

    expect(fake.mocks.listPending).toHaveBeenCalledTimes(3);
    // 没有更多到期时间，不再调度。
    expect(timers.setTimer).toHaveBeenCalledTimes(2);
    expect(timers.timers.size).toBe(0);
  });

  it("nextExpiryAt 为 undefined 时不调度，并清除旧定时器", () => {
    const action = fakeAction();
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    fake.setExpiry(2_000);

    bindOperatorApprovalBadge(action, fake.approvals, {
      now: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(timers.timers.size).toBe(1);

    fake.setExpiry(undefined);
    fake.emit(0);

    expect(timers.clearTimer).toHaveBeenCalledTimes(1);
    expect(timers.setTimer).toHaveBeenCalledTimes(1);
    expect(timers.timers.size).toBe(0);
  });

  it("nextExpiryAt 初始为 undefined 时一开始就不调度", () => {
    const action = fakeAction();
    const fake = fakeApprovals(0);
    const timers = fakeTimers();

    bindOperatorApprovalBadge(action, fake.approvals, {
      now: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    expect(timers.setTimer).not.toHaveBeenCalled();
    expect(timers.clearTimer).not.toHaveBeenCalled();
  });

  it("每次重新调度前先清除旧定时器", () => {
    const action = fakeAction();
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    fake.setExpiry(2_000);

    bindOperatorApprovalBadge(action, fake.approvals, {
      now: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    fake.emit(1);
    fake.emit(1);

    expect(timers.setTimer).toHaveBeenCalledTimes(3);
    expect(timers.clearTimer).toHaveBeenCalledTimes(2);
    expect(timers.timers.size).toBe(1);
  });

  it("action 方法 reject（异步失败）不抛错也不影响后续渲染", async () => {
    const action = fakeAction();
    action.setBadgeText.mockRejectedValue(new Error("no"));
    action.setBadgeBackgroundColor.mockRejectedValue(
      new Error("no"),
    );
    action.setTitle.mockRejectedValue(new Error("no"));
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    fake.setExpiry(500);

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      expect(() =>
        bindOperatorApprovalBadge(action, fake.approvals, {
          now: () => 0,
          setTimer: timers.setTimer,
          clearTimer: timers.clearTimer,
        }),
      ).not.toThrow();
      expect(() => fake.emit(2)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
      expect(timers.timers.size).toBe(1);
      expect(lastCall(action.setBadgeText)).toEqual({ text: "2" });
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("action 方法同步抛错不影响绑定、渲染其余字段与调度", () => {
    const action = fakeAction();
    action.setBadgeText.mockImplementation(() => {
      throw new Error("sync");
    });
    action.setBadgeBackgroundColor.mockImplementation(() => {
      throw new Error("sync");
    });
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    fake.setExpiry(500);

    expect(() =>
      bindOperatorApprovalBadge(action, fake.approvals, {
        now: () => 0,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      }),
    ).not.toThrow();

    expect(action.setTitle).toHaveBeenCalledWith({
      title: "Browser Agent 审批（1 个待处理）",
    });
    expect(timers.timers.size).toBe(1);
    expect(() => fake.emit(0)).not.toThrow();
    expect(lastCall(action.setTitle)).toEqual({
      title: "Browser Agent 审批",
    });
  });

  it("dispose 后取消订阅、清除定时器，后续 change 不再渲染", () => {
    const action = fakeAction();
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    fake.setExpiry(2_000);

    const dispose = bindOperatorApprovalBadge(
      action,
      fake.approvals,
      {
        now: () => 0,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    );
    const textCalls = action.setBadgeText.mock.calls.length;

    dispose();

    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(timers.timers.size).toBe(0);
    expect(timers.clearTimer).toHaveBeenCalledTimes(1);
    expect(fake.listeners.size).toBe(0);

    fake.emit(5);
    expect(action.setBadgeText.mock.calls.length).toBe(textCalls);
    expect(timers.setTimer).toHaveBeenCalledTimes(1);
  });

  it("dispose 后（即使 listener 仍被调用）也不渲染不调度", () => {
    const action = fakeAction();
    const fake = fakeApprovals(0);
    const timers = fakeTimers();
    fake.setExpiry(2_000);
    let captured: ((count: number) => void) | undefined;
    fake.mocks.subscribe.mockImplementation(
      (listener: (count: number) => void) => {
        captured = listener;
        return () => undefined;
      },
    );

    const dispose = bindOperatorApprovalBadge(
      action,
      fake.approvals,
      {
        now: () => 0,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    );
    dispose();
    const textCalls = action.setBadgeText.mock.calls.length;
    const setCalls = timers.setTimer.mock.calls.length;

    captured!(4);

    expect(action.setBadgeText.mock.calls.length).toBe(textCalls);
    expect(timers.setTimer.mock.calls.length).toBe(setCalls);
  });

  it("dispose 后已摘除的定时器回调（竞态）不再调用 listPending", () => {
    const action = fakeAction();
    const fake = fakeApprovals(1);
    const timers = fakeTimers();
    fake.setExpiry(2_000);

    const dispose = bindOperatorApprovalBadge(
      action,
      fake.approvals,
      {
        now: () => 0,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    );
    const staleCallback = timers.setTimer.mock.calls[0]![0];
    const before = fake.mocks.listPending.mock.calls.length;

    dispose();
    staleCallback();

    expect(fake.mocks.listPending.mock.calls.length).toBe(before);
    expect(timers.setTimer).toHaveBeenCalledTimes(1);
  });

  it("集成：真实 OperatorApprovalStore，request→角标 1，过期并触发定时器→角标空", async () => {
    let now = 100;
    const store = new OperatorApprovalStore(
      {
        get: () => ({
          byRef: new Map([[
            "@e_1",
            { semantic: { role: "button", name: "Save" } },
          ]]),
          observation: {
            tab: {
              origin: "https://fixture.test",
              title: "Fixture",
            },
          },
        }),
      } as never,
      { isAllowed: () => true } as never,
      {
        issueOperatorApproved: (i: any) => ({
          id: i.authorizationId,
          expiresAt: now + i.ttlMs,
          origin: "https://fixture.test",
          assurance: "operator-approved" as const,
        }),
      } as never,
      {
        now: () => now,
        idFactory: () => "operator-1",
        requestTtlMs: 200,
      },
    );
    const action = fakeAction();
    const timers = fakeTimers();

    bindOperatorApprovalBadge(action, store, {
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(lastCall(action.setBadgeText)).toEqual({ text: "" });
    expect(timers.timers.size).toBe(0);

    store.request({
      authorizationId: "auth-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1_000,
    });
    await Promise.resolve();

    expect(lastCall(action.setBadgeText)).toEqual({ text: "1" });
    expect(lastCall(action.setTitle)).toEqual({
      title: "Browser Agent 审批（1 个待处理）",
    });
    expect(timers.timers.size).toBe(1);
    // expiresAt = 300，now = 100：200 + 50
    expect([...timers.timers.values()][0]!.ms).toBe(250);

    now = 301;
    timers.fire();
    await Promise.resolve();

    expect(lastCall(action.setBadgeText)).toEqual({ text: "" });
    expect(lastCall(action.setTitle)).toEqual({
      title: "Browser Agent 审批",
    });
    expect(store.status("operator-1").state).toBe("expired");
    expect(timers.timers.size).toBe(0);
  });
});
