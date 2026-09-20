import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ChromeManagedEnterpriseAuthorizationPolicyProvider,
  ENTERPRISE_POLICY_STORAGE_KEYS,
} from "./enterpriseManagedPolicy.js";

describe(
  "ChromeManagedEnterpriseAuthorizationPolicyProvider",
  () => {
    it(
      "先限制 managed storage 到 trusted contexts，再读取管理员策略",
      async () => {
        const setAccessLevel =
          vi.fn(async () => {});
        const get =
          vi.fn(async () => ({
            [ENTERPRISE_POLICY_STORAGE_KEYS
              .keyId]:
              "enterprise-key-1",
            [ENTERPRISE_POLICY_STORAGE_KEYS
              .publicKeySpkiBase64]:
              "A".repeat(64),
            [ENTERPRISE_POLICY_STORAGE_KEYS
              .maxAssertionLifetimeMs]:
              90_000,
          }));

        const provider =
          new ChromeManagedEnterpriseAuthorizationPolicyProvider(
            {
              setAccessLevel,
              get,
            },
          );

        await expect(
          provider.load(),
        ).resolves.toEqual({
          keyId:
            "enterprise-key-1",
          publicKeySpkiBase64:
            "A".repeat(64),
          maxAssertionLifetimeMs:
            90_000,
        });

        await provider.load();

        expect(
          setAccessLevel,
        ).toHaveBeenCalledTimes(1);
        expect(
          setAccessLevel,
        ).toHaveBeenCalledWith({
          accessLevel:
            "TRUSTED_CONTEXTS",
        });
        expect(get)
          .toHaveBeenCalledTimes(2);
      },
    );

    it(
      "未配置 enterprise policy 时返回 undefined",
      async () => {
        const provider =
          new ChromeManagedEnterpriseAuthorizationPolicyProvider(
            {
              async setAccessLevel() {},
              async get() {
                return {};
              },
            },
          );

        await expect(
          provider.load(),
        ).resolves.toBeUndefined();
      },
    );

    it(
      "partial/malformed policy fail closed",
      async () => {
        const provider =
          new ChromeManagedEnterpriseAuthorizationPolicyProvider(
            {
              async setAccessLevel() {},
              async get() {
                return {
                  EnterpriseAuthorizationKeyId:
                    "key-only",
                };
              },
            },
          );

        await expect(
          provider.load(),
        ).rejects.toMatchObject({
          code: "POLICY_BLOCKED",
        });
      },
    );

    it(
      "无法限制 managed storage access 时不继续读取 policy",
      async () => {
        let reads = 0;
        const provider =
          new ChromeManagedEnterpriseAuthorizationPolicyProvider(
            {
              async setAccessLevel() {
                throw new Error(
                  "storage unavailable",
                );
              },
              async get() {
                reads += 1;
                return {};
              },
            },
          );

        await expect(
          provider.load(),
        ).rejects.toMatchObject({
          code: "POLICY_BLOCKED",
        });
        expect(reads).toBe(0);
      },
    );
  },
);
