import {
  describe,
  expect,
  it,
} from "vitest";
import {
  OperatorApprovalStore,
} from "./operatorApprovalStore.js";

function setup(
  options: {
    idFactory?: () => string;
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
          .toEqual([input]);

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
              .toEqual([input]);
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
