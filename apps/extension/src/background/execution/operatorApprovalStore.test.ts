import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  OperatorApprovalStore,
} from "./operatorApprovalStore.js";

function setup(
  options: {
    idFactory?: () => string;
    maxPending?: number;
  } = {},
) {
  let now = 100;

  const entries =
    new Map<string, any>([[
      "rev-1",
      {
        byRef: new Map([[
          "@e_1",
          {
            semantic: {
              role: "button",
              name: "Save",
            },
          },
        ]]),
        observation: {
          tab: {
            origin:
              "https://fixture.test",
            title: "Fixture",
          },
        },
      },
    ]]);

  const issued: any[] = [];

  const store =
    new OperatorApprovalStore(
      {
        get(
          _tabId: number,
          revision: string,
        ) {
          return entries.get(
            revision,
          );
        },
      } as never,
      {
        isAllowed(
          origin: string,
        ) {
          return origin ===
            "https://fixture.test";
        },
      } as never,
      {
        issueOperatorApproved(
          input: any,
        ) {
          issued.push(input);
          return {
            id:
              input.authorizationId,
            expiresAt:
              now + input.ttlMs,
            origin:
              "https://fixture.test",
            assurance: "operator-approved" as const,
          };
        },
      } as never,
      {
        now: () => now,
        idFactory:
          options.idFactory ??
          (() => "operator-1"),
        requestTtlMs: 200,
        ...(options.maxPending !==
        undefined
          ? {
              maxPending:
                options.maxPending,
            }
          : {}),
      },
    );

  return {
    store,
    issued,
    entries,
    setNow(value: number) {
      now = value;
    },
  };
}

const input = {
  authorizationId: "auth-1",
  tabId: 7,
  observedRevision: "rev-1",
  ref: "@e_1",
  ttlMs: 1_000,
};

describe(
  "OperatorApprovalStore",
  () => {
    it(
      "request 只创建 pending，不直接签发 grant",
      () => {
        const {
          store,
          issued,
        } = setup();

        expect(
          store.request(input),
        ).toMatchObject({
          approvalRequestId:
            "operator-1",
          authorizationId:
            "auth-1",
          origin:
            "https://fixture.test",
          targetRole: "button",
          targetName: "Save",
        });

        expect(issued)
          .toEqual([]);

        expect(
          store.status(
            "operator-1",
          ),
        ).toMatchObject({
          state: "pending",
        });
      },
    );

    it(
      "approve 单次消费 pending，并由 operator issuer 签发",
      () => {
        const {
          store,
          issued,
        } = setup();

        store.request(input);

        const result =
          store.approve(
            "operator-1",
          );

        expect(
          result.grant.assurance,
        ).toBe(
          "operator-approved",
        );

        expect(issued)
          .toEqual([{ ...input, action: { kind: "click" } }]);

        expect(
          store.status(
            "operator-1",
          ),
        ).toMatchObject({
          state: "approved",
          authorizationId:
            "auth-1",
          grantExpiresAt:
            1_100,
        });

        expect(
          () =>
            store.approve(
              "operator-1",
            ),
        ).toThrow(
          /no longer pending/,
        );

        expect(issued)
          .toHaveLength(1);
      },
    );

    it(
      "reject、过期、navigation invalidation 都不能产生 grant",
      () => {
        const rejected =
          setup();
        rejected.store
          .request(input);
        rejected.store
          .reject("operator-1");

        expect(
          rejected.store.status(
            "operator-1",
          ).state,
        ).toBe("rejected");

        expect(
          rejected.issued,
        ).toEqual([]);

        const expired = setup();
        expired.store
          .request(input);
        expired.setNow(300);

        expect(
          expired.store.status(
            "operator-1",
          ).state,
        ).toBe("expired");

        expect(
          () =>
            expired.store
              .approve(
                "operator-1",
              ),
        ).toThrow(
          /no longer pending/,
        );

        const invalidated =
          setup();
        invalidated.store
          .request(input);
        invalidated.store
          .clearTab(7);

        expect(
          invalidated.store
            .status(
              "operator-1",
            ).state,
        ).toBe("invalidated");

        expect(
          invalidated.issued,
        ).toEqual([]);
      },
    );

    it(
      "pending 阶段拒绝无效 TTL 与重复 authorizationId",
      () => {
        const { store } = setup();

        expect(
          () =>
            store.request({
              ...input,
              ttlMs: 60_001,
            }),
        ).toThrow(
          /ttl is outside the allowed range/,
        );

        store.request(input);

        expect(
          () =>
            store.request({
              ...input,
              ref: "@e_1",
            }),
        ).toThrow(
          /already has a pending operator approval/,
        );
      },
    );

    it(
      "approve 时 issuer 失败会把 pending 标成 invalidated",
      () => {
        const {
          store,
          issued,
        } = setup();

        store.request(input);

        (
          store as any
        ).issuance
          .issueOperatorApproved =
          () => {
            throw new Error(
              "observation expired",
            );
          };

        expect(
          () =>
            store.approve(
              "operator-1",
            ),
        ).toThrow(
          /observation expired/,
        );

        expect(
          store.status(
            "operator-1",
          ).state,
        ).toBe(
          "invalidated",
        );

        expect(issued)
          .toEqual([]);
      },
    );
    describe(
      "cancelByAuthorizationId",
      () => {
        function sequentialIds() {
          let n = 0;
          return () => {
            n += 1;
            return `operator-${n}`;
          };
        }

        it(
          "cancel pending 记为 cancelled，之后 approve 失败且不签发 grant",
          () => {
            const {
              store,
              issued,
              setNow,
            } = setup();

            store.request(input);
            setNow(150);
            store.cancelByAuthorizationId(
              "auth-1",
              false,
            );

            expect(
              store.status(
                "operator-1",
              ),
            ).toMatchObject({
              state: "cancelled",
              authorizationId:
                "auth-1",
              resolvedAt: 150,
            });

            expect(
              store.listPending(),
            ).toEqual([]);

            expect(
              () =>
                store.approve(
                  "operator-1",
                ),
            ).toThrow(
              /missing or no longer pending/,
            );

            expect(issued)
              .toEqual([]);
          },
        );

        it(
          "cancel approved 且 grantRevoked=true 记为 cancelled，resolvedAt 为取消时间且无 grantExpiresAt",
          () => {
            const {
              store,
              setNow,
            } = setup();

            store.request(input);
            store.approve(
              "operator-1",
            );

            expect(
              store.status(
                "operator-1",
              ),
            ).toMatchObject({
              state: "approved",
              grantExpiresAt:
                1_100,
            });

            setNow(500);
            store.cancelByAuthorizationId(
              "auth-1",
              true,
            );

            const status =
              store.status(
                "operator-1",
              );

            expect(status)
              .toMatchObject({
                approvalRequestId:
                  "operator-1",
                state: "cancelled",
                authorizationId:
                  "auth-1",
                resolvedAt: 500,
              });

            expect(status)
              .not.toHaveProperty(
                "grantExpiresAt",
              );
          },
        );

        it(
          "cancel approved 但 grantRevoked=false 保持 approved",
          () => {
            const {
              store,
              setNow,
            } = setup();

            store.request(input);
            store.approve(
              "operator-1",
            );

            setNow(500);
            store.cancelByAuthorizationId(
              "auth-1",
              false,
            );

            expect(
              store.status(
                "operator-1",
              ),
            ).toMatchObject({
              state: "approved",
              grantExpiresAt:
                1_100,
            });
          },
        );

        it(
          "rejected 不被翻转（即使 grantRevoked=true）",
          () => {
            const {
              store,
            } = setup();

            store.request(input);
            store.reject(
              "operator-1",
            );

            store.cancelByAuthorizationId(
              "auth-1",
              true,
            );

            expect(
              store.status(
                "operator-1",
              ).state,
            ).toBe("rejected");
          },
        );

        it(
          "expired 与 invalidated 不被翻转",
          () => {
            const expired =
              setup();
            expired.store
              .request(input);
            expired.setNow(300);
            expired.store
              .cancelByAuthorizationId(
                "auth-1",
                true,
              );

            expect(
              expired.store.status(
                "operator-1",
              ).state,
            ).toBe("expired");

            const invalidated =
              setup();
            invalidated.store
              .request(input);
            invalidated.store
              .clearTab(7);
            invalidated.store
              .cancelByAuthorizationId(
                "auth-1",
                true,
              );

            expect(
              invalidated.store
                .status(
                  "operator-1",
                ).state,
            ).toBe("invalidated");
          },
        );

        it(
          "不影响其他 authorizationId",
          () => {
            const {
              store,
            } = setup({
              idFactory:
                sequentialIds(),
            });

            store.request(input);
            store.request({
              ...input,
              authorizationId:
                "auth-2",
            });

            store.cancelByAuthorizationId(
              "auth-1",
              true,
            );

            expect(
              store.status(
                "operator-1",
              ).state,
            ).toBe("cancelled");
            expect(
              store.status(
                "operator-2",
              ).state,
            ).toBe("pending");
          },
        );

        it(
          "同一 authorizationId 的多条记录全量处理",
          () => {
            const {
              store,
            } = setup({
              idFactory:
                sequentialIds(),
            });

            // operator-1: approved
            store.request(input);
            store.approve(
              "operator-1",
            );
            // operator-2: rejected
            store.request(input);
            store.reject(
              "operator-2",
            );
            // operator-3: approved
            store.request(input);
            store.approve(
              "operator-3",
            );
            // operator-4: pending
            store.request(input);

            store.cancelByAuthorizationId(
              "auth-1",
              true,
            );

            expect(
              [
                "operator-1",
                "operator-2",
                "operator-3",
                "operator-4",
              ].map(
                (id) =>
                  store.status(id)
                    .state,
              ),
            ).toEqual([
              "cancelled",
              "rejected",
              "cancelled",
              "cancelled",
            ]);
          },
        );

        it(
          "grant 已过期的历史 approved 不翻转，只翻转仍有效的那一条",
          () => {
            const {
              store,
              setNow,
            } = setup({
              idFactory:
                sequentialIds(),
            });

            // operator-1：t=100 批准，grant 到期 1100。
            store.request(input);
            store.approve(
              "operator-1",
            );

            // operator-2：t=1200 批准（operator-1 的 grant 已过期），到期 2200。
            setNow(1_200);
            store.request(input);
            store.approve(
              "operator-2",
            );

            store.cancelByAuthorizationId(
              "auth-1",
              true,
            );

            expect(
              store.status("operator-1")
                .state,
            ).toBe("approved");
            expect(
              store.status("operator-2")
                .state,
            ).toBe("cancelled");
          },
        );
      },
    );

    describe(
      "approvalTtlMs",
      () => {
        it(
          "较小的 approvalTtlMs 生效：expiresAt 提前并按时过期",
          () => {
            const {
              store,
              issued,
              setNow,
            } = setup();

            const summary =
              store.request({
                ...input,
                approvalTtlMs: 50,
              });

            // now=100, requestTtlMs=200
            expect(
              summary.expiresAt,
            ).toBe(150);

            setNow(149);
            expect(
              store.status(
                "operator-1",
              ).state,
            ).toBe("pending");

            setNow(150);
            expect(
              store.status(
                "operator-1",
              ).state,
            ).toBe("expired");

            expect(
              () =>
                store.approve(
                  "operator-1",
                ),
            ).toThrow(
              /no longer pending/,
            );

            expect(issued)
              .toEqual([]);
          },
        );

        it(
          "较大的 approvalTtlMs 被截断到 requestTtlMs",
          () => {
            const {
              store,
              setNow,
            } = setup();

            const summary =
              store.request({
                ...input,
                approvalTtlMs:
                  10_000,
              });

            expect(
              summary.expiresAt,
            ).toBe(300);

            setNow(299);
            expect(
              store.status(
                "operator-1",
              ).state,
            ).toBe("pending");

            setNow(300);
            expect(
              store.status(
                "operator-1",
              ).state,
            ).toBe("expired");
          },
        );

        it(
          "未提供 approvalTtlMs 时使用 requestTtlMs",
          () => {
            const { store } =
              setup();

            expect(
              store.request(input)
                .expiresAt,
            ).toBe(300);
          },
        );

        it.each([
          0,
          -1,
          1.5,
          Number.NaN,
        ])(
          "approvalTtlMs=%s 抛 AUTHORIZATION_REQUIRED",
          (approvalTtlMs) => {
            const { store } =
              setup();

            expect(
              () =>
                store.request({
                  ...input,
                  approvalTtlMs,
                }),
            ).toThrow(
              /approval ttl must be a positive integer/,
            );

            expect(
              store.listPending(),
            ).toEqual([]);
          },
        );

        it(
          "approvalTtlMs 不出现在传给 issueOperatorApproved 的输入里",
          () => {
            const {
              store,
              issued,
            } = setup();

            store.request({
              ...input,
              approvalTtlMs: 50,
            });
            store.approve(
              "operator-1",
            );

            expect(issued)
              .toEqual([{ ...input, action: { kind: "click" } }]);
            expect(issued[0])
              .not.toHaveProperty(
                "approvalTtlMs",
              );
          },
        );
      },
    );
  },
);

const flush = () =>
  new Promise<void>((resolve) =>
    queueMicrotask(resolve),
  );

function sequentialIds() {
  let n = 0;
  return () => {
    n += 1;
    return `operator-${n}`;
  };
}

describe("OperatorApprovalStore.subscribe", () => {
  function subscribed(
    options: Parameters<typeof setup>[0] = {},
  ) {
    const ctx = setup({
      idFactory: sequentialIds(),
      ...options,
    });
    const counts: number[] = [];
    const unsubscribe = ctx.store.subscribe(
      (count) => counts.push(count),
    );

    return { ...ctx, counts, unsubscribe };
  }

  it("request 后通知 1，且在 microtask 之前不通知", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    expect(counts).toEqual([]);

    await flush();
    expect(counts).toEqual([1]);
  });

  it("approve 后通知 0", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    await flush();
    store.approve("operator-1");
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("reject 后通知 0", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    await flush();
    store.reject("operator-1");
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("同一同步操作内多次增删只通知一次（最终计数）", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    store.request({
      ...input,
      authorizationId: "auth-2",
    });
    store.request({
      ...input,
      authorizationId: "auth-3",
    });
    store.reject("operator-2");
    await flush();

    expect(counts).toEqual([2]);
  });

  it("增删后回到原数量时不通知", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    store.reject("operator-1");
    await flush();

    expect(counts).toEqual([]);
  });

  it("数量不变不通知（request 时过期 1 个再新增 1 个）", async () => {
    const { store, counts, setNow } = subscribed();

    store.request(input);
    await flush();
    expect(counts).toEqual([1]);

    setNow(300);
    store.request({
      ...input,
      authorizationId: "auth-2",
    });
    await flush();

    expect(counts).toEqual([1]);
    expect(store.listPending()).toHaveLength(1);
    expect(store.status("operator-1").state).toBe(
      "expired",
    );
  });

  it("request 因 ttl 非法抛错但触发了过期清理时仍通知新计数", async () => {
    const { store, counts, setNow } = subscribed();

    store.request(input);
    await flush();

    setNow(300);
    expect(() =>
      store.request({ ...input, ttlMs: 60_001 }),
    ).toThrow(/ttl is outside the allowed range/);
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("request 因 ORIGIN_NOT_ALLOWED 抛错但触发了过期清理时仍通知新计数", async () => {
    const { store, counts, setNow, entries } =
      subscribed();

    entries.set("rev-evil", {
      byRef: new Map([[
        "@e_1",
        { semantic: { role: "button", name: "X" } },
      ]]),
      observation: {
        tab: {
          origin: "https://evil.test",
          title: "Evil",
        },
      },
    });

    store.request(input);
    await flush();

    setNow(300);
    expect(() =>
      store.request({
        ...input,
        authorizationId: "auth-2",
        observedRevision: "rev-evil",
      }),
    ).toThrow(/outside the auto-act allowlist/);
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("request 因重复 authorizationId 抛错但触发了过期清理时仍通知新计数", async () => {
    const { store, counts, setNow } = subscribed();

    store.request(input);
    store.request({
      ...input,
      authorizationId: "auth-2",
      approvalTtlMs: 100,
    });
    await flush();
    expect(counts).toEqual([2]);

    // operator-2 过期于 200，operator-1 过期于 300：推进到 250 只清掉 operator-2。
    setNow(250);
    expect(() => store.request(input)).toThrow(
      /already has a pending operator approval/,
    );
    await flush();

    expect(counts).toEqual([2, 1]);
  });

  it("approve 签发失败（issuance 抛错）仍通知 0", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    await flush();

    (store as any).issuance.issueOperatorApproved =
      () => {
        throw new Error("observation expired");
      };

    expect(() => store.approve("operator-1")).toThrow(
      /observation expired/,
    );
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("status 触发过期时通知", async () => {
    const { store, counts, setNow } = subscribed();

    store.request(input);
    await flush();

    setNow(300);
    store.status("operator-1");
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("listPending 触发过期时通知", async () => {
    const { store, counts, setNow } = subscribed();

    store.request(input);
    await flush();

    setNow(300);
    expect(store.listPending()).toEqual([]);
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("cancelByAuthorizationId 取消 pending 时通知", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    await flush();
    store.cancelByAuthorizationId("auth-1", false);
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("clearTab 通知", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    await flush();
    store.clearTab(7);
    await flush();

    expect(counts).toEqual([1, 0]);
  });

  it("clearTab 对其他 tab 不通知", async () => {
    const { store, counts } = subscribed();

    store.request(input);
    await flush();
    store.clearTab(8);
    await flush();

    expect(counts).toEqual([1]);
  });

  it("trimPending（maxPending 溢出）后通知裁剪后的计数", async () => {
    const { store, counts, setNow } = subscribed({
      maxPending: 2,
    });

    for (const id of ["auth-1", "auth-2", "auth-3"]) {
      store.request({ ...input, authorizationId: id });
    }
    await flush();

    expect(counts).toEqual([2]);
    expect(store.status("operator-1").state).toBe(
      "invalidated",
    );
    expect(store.listPending()).toHaveLength(2);

    // 已在上限：再新增一个，裁掉最旧的，数量不变不通知。
    setNow(100);
    store.request({
      ...input,
      authorizationId: "auth-4",
    });
    await flush();

    expect(counts).toEqual([2]);
  });

  it("listener 抛错不影响 store，其他 listener 仍收到", async () => {
    const { store, counts } = subscribed();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const later: number[] = [];

    store.subscribe(bad);
    store.subscribe((count) => later.push(count));

    expect(() => store.request(input)).not.toThrow();
    await flush();

    expect(bad).toHaveBeenCalledWith(1);
    expect(counts).toEqual([1]);
    expect(later).toEqual([1]);
    expect(store.listPending()).toHaveLength(1);

    store.approve("operator-1");
    await flush();
    expect(later).toEqual([1, 0]);
  });

  it("取消订阅后不再收到，其他订阅不受影响", async () => {
    const { store, counts, unsubscribe } =
      subscribed();
    const other: number[] = [];
    store.subscribe((count) => other.push(count));

    store.request(input);
    await flush();
    unsubscribe();
    store.reject("operator-1");
    await flush();

    expect(counts).toEqual([1]);
    expect(other).toEqual([1, 0]);
  });

  it("listener 内同步触发的二次变化会重新调度而不是重入", async () => {
    const { store } = subscribed();
    const seen: number[] = [];
    let first = true;

    store.subscribe((count) => {
      seen.push(count);
      if (first) {
        first = false;
        store.reject("operator-1");
      }
    });

    store.request(input);
    await flush();
    await flush();

    expect(seen).toEqual([1, 0]);
  });
});

describe("OperatorApprovalStore.nextExpiryAt", () => {
  it("空时返回 undefined", () => {
    const { store } = setup();
    expect(store.nextExpiryAt()).toBeUndefined();
  });

  it("返回最早的 expiresAt", () => {
    const { store, setNow } = setup({
      idFactory: sequentialIds(),
    });

    store.request(input);
    setNow(150);
    store.request({
      ...input,
      authorizationId: "auth-2",
    });
    expect(store.nextExpiryAt()).toBe(300);

    store.request({
      ...input,
      authorizationId: "auth-3",
      approvalTtlMs: 20,
    });
    expect(store.nextExpiryAt()).toBe(170);
  });

  it("受 approvalTtlMs 影响，并被 requestTtlMs 截断", () => {
    const { store } = setup({
      idFactory: sequentialIds(),
    });

    store.request({ ...input, approvalTtlMs: 50 });
    expect(store.nextExpiryAt()).toBe(150);

    store.reject("operator-1");
    store.request({
      ...input,
      authorizationId: "auth-2",
      approvalTtlMs: 10_000,
    });
    expect(store.nextExpiryAt()).toBe(300);
  });

  it("处理完成后恢复为 undefined", () => {
    const { store } = setup();

    store.request(input);
    store.approve("operator-1");
    expect(store.nextExpiryAt()).toBeUndefined();
  });
});

describe("OperatorApprovalStore 写入类动作", () => {
  function field(state: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    return {
      kind: "field",
      semantic: { role: "textbox", name: "Name" },
      state: { visible: true, enabled: true, focused: false, ...state },
      capabilities: [{ kind: "setValue", valueType: "text" }],
      provenance: { dom: true, ax: true },
      ...extra,
    };
  }

  it("summary 带 action，批准时用同一 action 签发", () => {
    const { store, issued, entries } = setup();
    entries.get("rev-1").byRef.set("@e_1", field());
    const action = { kind: "setValue" as const, value: "张三" };

    const summary = store.request({ ...input, action });
    expect(summary.action).toEqual(action);
    expect(store.listPending()[0]?.action).toEqual(action);

    store.approve(summary.approvalRequestId);
    expect(issued).toEqual([{ ...input, action }]);
  });

  it("敏感、只读或无 setValue capability 的目标在入队前被拒绝，审批页看不到值", () => {
    const action = { kind: "setValue" as const, value: "hunter2" };
    for (const [target, code] of [
      [field({ sensitive: true }), "POLICY_BLOCKED"],
      [field({ readonly: true }), "ACTION_NOT_SUPPORTED"],
      [field({ enabled: false }), "ACTION_NOT_SUPPORTED"],
      [field({}, { semantic: { role: "spinbutton", name: "Age" } }), "ACTION_NOT_SUPPORTED"],
      [field({}, { provenance: { ax: true } }), "ACTION_NOT_SUPPORTED"],
      [field({}, { capabilities: [{ kind: "click" }] }), "TARGET_CAPABILITY_MISSING"],
    ] as const) {
      const { store, entries } = setup();
      entries.get("rev-1").byRef.set("@e_1", target);

      expect(() => store.request({ ...input, action }), code).toThrow(
        expect.objectContaining({ code }),
      );
      expect(store.listPending()).toEqual([]);
    }
  });
});
