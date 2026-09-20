import {
  describe,
  expect,
  it,
} from "vitest";
import {
  ChromeStorageEnterpriseAssertionReplayStore,
} from "./enterpriseAssertionReplayStore.js";

function setup() {
  let value: unknown;
  let accessCalls = 0;
  let now = 100;

  const store =
    new ChromeStorageEnterpriseAssertionReplayStore(
      {
        async get() {
          return {
            enterpriseAuthorizationConsumedAssertions:
              value,
          };
        },
        async set(items) {
          value =
            items.enterpriseAuthorizationConsumedAssertions;
        },
        async setAccessLevel() {
          accessCalls += 1;
        },
      },
      {
        now: () => now,
        maxEntries: 2,
      },
    );

  return {
    store,
    getValue() {
      return value;
    },
    getAccessCalls() {
      return accessCalls;
    },
    setNow(next: number) {
      now = next;
    },
  };
}

describe(
  "ChromeStorageEnterpriseAssertionReplayStore",
  () => {
    it(
      "跨调用持久化 consumed assertion 并拒绝 replay",
      async () => {
        const context = setup();

        await expect(
          context.store
            .consumeOnce(
              "assertion-1",
              200,
            ),
        ).resolves.toBe(true);

        await expect(
          context.store
            .consumeOnce(
              "assertion-1",
              200,
            ),
        ).resolves.toBe(false);

        expect(
          context.getValue(),
        ).toEqual({
          "assertion-1": 200,
        });
        expect(
          context.getAccessCalls(),
        ).toBe(1);
      },
    );

    it(
      "过期 entry 可回收，容量保持 bounded",
      async () => {
        const context = setup();

        await context.store
          .consumeOnce(
            "old",
            100,
          );
        context.setNow(101);

        await context.store
          .consumeOnce(
            "a",
            300,
          );
        await context.store
          .consumeOnce(
            "b",
            400,
          );
        await context.store
          .consumeOnce(
            "c",
            500,
          );

        expect(
          context.getValue(),
        ).toEqual({
          b: 400,
          c: 500,
        });
      },
    );

    it(
      "malformed persisted state fail closed",
      async () => {
        let reads = 0;
        const store =
          new ChromeStorageEnterpriseAssertionReplayStore(
            {
              async get() {
                reads += 1;
                return {
                  enterpriseAuthorizationConsumedAssertions:
                    "corrupt",
                };
              },
              async set() {},
              async setAccessLevel() {},
            },
          );

        await expect(
          store.consumeOnce(
            "assertion",
            200,
          ),
        ).rejects.toMatchObject({
          code: "POLICY_BLOCKED",
        });
        expect(reads).toBe(1);
      },
    );
  },
);
