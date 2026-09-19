import { describe, expect, it } from "vitest";
import { connectTrustedNativeIngress } from "./trustedNativeIngress.js";

describe("connectTrustedNativeIngress", () => {
  it("native host 缺失时安全降级为没有执行入口", () => {
    const connection = connectTrustedNativeIngress(
      {
        connectNative() {
          throw new Error("host not found");
        },
      },
      {} as never,
    );

    expect(connection.connected).toBe(false);
  });

  it("只有通过 trusted native port 的请求才能进入 issue/execute service", async () => {
    let listener: ((message: unknown) => void) | undefined;
    const responses: unknown[] = [];

    const service = {
      replaceAutoActOrigins(origins: string[]) {
        return origins;
      },
      issueStrictClickAuthorization() {
        return {
          id: "auth",
          expiresAt: 1_000,
          origin: "https://fixture.test",
        };
      },
      async executeStrictClickAndVerify() {
        return {
          execution: { status: "executed" },
          verification: {
            verified: true,
            conclusive: true,
            evidence: [],
          },
          verificationAttempts: 1,
        };
      },
    };

    connectTrustedNativeIngress(
      {
        connectNative() {
          return {
            postMessage(message: unknown) {
              responses.push(message);
            },
            disconnect() {},
            onMessage: {
              addListener(next: (message: unknown) => void) {
                listener = next;
              },
              removeListener() {},
            },
            onDisconnect: {
              addListener() {},
              removeListener() {},
            },
          };
        },
      },
      service as never,
    );

    listener?.({
      type: "authorization.issue-strict-click",
      requestId: "req-1",
      authorizationId: "auth",
      tabId: 7,
      observedRevision: "rev-1",
      ref: "@e_1",
      ttlMs: 1_000,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(responses).toContainEqual({
      type: "trusted-host.result",
      requestId: "req-1",
      ok: true,
      result: {
        id: "auth",
        expiresAt: 1_000,
        origin: "https://fixture.test",
      },
    });
  });
});
