import {
  describe,
  expect,
  it,
} from "vitest";
import {
  OperatorApprovalStore,
} from "./operatorApprovalStore.js";

function setup() {
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
          () => "operator-1",
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
  },
);
