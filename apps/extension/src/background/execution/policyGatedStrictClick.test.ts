import { describe, expect, it, vi } from "vitest";
import { BrowserRuntimeError } from "@browser-agent-next/core";
import { InMemoryAuthorizationStore } from "@browser-agent-next/policy";
import { PolicyGatedStrictClickExecutor } from "./policyGatedStrictClick.js";

function prepared() {
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
        ownedBySession: true,
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
    const authorizations = new InMemoryAuthorizationStore({
      now: () => 1000,
    });

    authorizations.issue({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      ttlMs: 5000,
      source: "trusted-ui",
    });

    const executor = new PolicyGatedStrictClickExecutor(
      { prepare } as never,
      { dispatch } as never,
      authorizations,
      { isAllowed: () => true },
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

  it("origin 不在 allowlist 时即使有授权也拒绝", async () => {
    const dispatch = vi.fn(async () => undefined);
    const authorizations = new InMemoryAuthorizationStore({
      now: () => 1000,
    });

    authorizations.issue({
      id: "grant-1",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      ttlMs: 5000,
      source: "trusted-host",
    });

    const executor = new PolicyGatedStrictClickExecutor(
      {
        async prepare() {
          return prepared() as never;
        },
      } as never,
      { dispatch } as never,
      authorizations,
      { isAllowed: () => false },
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
});
