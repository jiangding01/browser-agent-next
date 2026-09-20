import {
  describe,
  expect,
  it,
} from "vitest";
import {
  canonicalEnterpriseAuthorizationAssertion,
  type EnterpriseAuthorizationAssertion,
} from "../../protocol/enterpriseAuthorization.js";
import {
  EnterprisePolicyAuthorizationService,
} from "./enterprisePolicyAuthorizationService.js";

function bytesToBase64(
  bytes: Uint8Array,
): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(
      byte,
    );
  }

  return btoa(binary);
}

function bytesToBase64Url(
  bytes: Uint8Array,
): string {
  return bytesToBase64(bytes)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function keys() {
  const pair =
    await crypto.subtle.generateKey(
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;

  const spki =
    new Uint8Array(
      await crypto.subtle.exportKey(
        "spki",
        pair.publicKey,
      ),
    );

  return {
    pair,
    spkiBase64:
      bytesToBase64(spki),
  };
}

async function sign(
  assertion:
    EnterpriseAuthorizationAssertion,
  privateKey: CryptoKey,
): Promise<string> {
  const signature =
    new Uint8Array(
      await crypto.subtle.sign(
        {
          name: "ECDSA",
          hash: "SHA-256",
        },
        privateKey,
        new TextEncoder().encode(
          canonicalEnterpriseAuthorizationAssertion(
            assertion,
          ),
        ),
      ),
    );

  return bytesToBase64Url(
    signature,
  );
}

async function setup() {
  const now = 10_000;
  const key = await keys();
  const issued: any[] = [];

  const states = {
    get(
      tabId: number,
      revision: string,
    ) {
      if (
        tabId !== 7 ||
        revision !== "rev-1"
      ) {
        return undefined;
      }

      return {
        observation: {
          tab: {
            origin:
              "https://fixture.test",
          },
        },
        byRef: new Map([
          ["@e_1", {}],
        ]),
      };
    },
  };

  const consumed =
    new Set<string>();

  const service =
    new EnterprisePolicyAuthorizationService(
      states as never,
      {
        async load() {
          return {
            keyId:
              "enterprise-key-1",
            publicKeySpkiBase64:
              key.spkiBase64,
            maxAssertionLifetimeMs:
              120_000,
          };
        },
      },
      {
        async consumeOnce(
          assertionId: string,
        ) {
          if (
            consumed.has(
              assertionId,
            )
          ) {
            return false;
          }

          consumed.add(
            assertionId,
          );
          return true;
        },
      },
      {
        issueEnterprisePolicy(
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
            assurance: "enterprise-policy" as const,
          };
        },
      } as never,
      {
        now: () => now,
      },
    );

  const assertion:
    EnterpriseAuthorizationAssertion = {
      version: 1,
      assertionId:
        "assertion-1",
      keyId:
        "enterprise-key-1",
      authorizationId:
        "auth-enterprise",
      tabId: 7,
      observedRevision:
        "rev-1",
      ref: "@e_1",
      origin:
        "https://fixture.test",
      actionKind: "click",
      effectClass: "unknown",
      issuedAt: now - 1_000,
      expiresAt:
        now + 30_000,
      grantTtlMs: 10_000,
    };

  return {
    assertion,
    issued,
    key,
    service,
  };
}

describe(
  "EnterprisePolicyAuthorizationService",
  () => {
    it(
      "有效 managed key 签名 assertion 才能签发 enterprise-policy grant",
      async () => {
        const {
          assertion,
          issued,
          key,
          service,
        } = await setup();

        const signature =
          await sign(
            assertion,
            key.pair.privateKey,
          );

        await expect(
          service.issue({
            assertion,
            signature,
          }),
        ).resolves.toMatchObject({
          id: "auth-enterprise",
          assurance:
            "enterprise-policy",
        });

        expect(issued)
          .toEqual([{
            authorizationId:
              "auth-enterprise",
            tabId: 7,
            observedRevision:
              "rev-1",
            ref: "@e_1",
            ttlMs: 10_000,
          }]);
      },
    );

    it(
      "签名 assertion 单次消费，不能 replay",
      async () => {
        const {
          assertion,
          key,
          service,
        } = await setup();

        const signature =
          await sign(
            assertion,
            key.pair.privateKey,
          );

        await service.issue({
          assertion,
          signature,
        });

        await expect(
          service.issue({
            assertion,
            signature,
          }),
        ).rejects.toMatchObject({
          code:
            "AUTHORIZATION_REQUIRED",
        });
      },
    );

    it(
      "tamper、wrong keyId 与 origin mismatch 均 fail closed",
      async () => {
        const first =
          await setup();
        const signature =
          await sign(
            first.assertion,
            first.key.pair.privateKey,
          );

        await expect(
          first.service.issue({
            assertion: {
              ...first.assertion,
              ref: "@tampered",
            },
            signature,
          }),
        ).rejects.toMatchObject({
          code:
            "AUTHORIZATION_REQUIRED",
        });

        const second =
          await setup();
        await expect(
          second.service.issue({
            assertion: {
              ...second.assertion,
              keyId:
                "wrong-key",
            },
            signature:
              await sign(
                {
                  ...second.assertion,
                  keyId:
                    "wrong-key",
                },
                second.key.pair.privateKey,
              ),
          }),
        ).rejects.toMatchObject({
          code:
            "AUTHORIZATION_REQUIRED",
        });

        const third =
          await setup();
        const changedOrigin = {
          ...third.assertion,
          origin:
            "https://other.test",
        };

        await expect(
          third.service.issue({
            assertion:
              changedOrigin,
            signature:
              await sign(
                changedOrigin,
                third.key.pair.privateKey,
              ),
          }),
        ).rejects.toMatchObject({
          code:
            "AUTHORIZATION_REQUIRED",
        });
      },
    );

    it(
      "过期、超 managed lifetime 或 grant 超过 assertion window 时拒绝",
      async () => {
        const expired =
          await setup();
        const expiredAssertion = {
          ...expired.assertion,
          issuedAt: 1_000,
          expiresAt: 2_000,
        };

        await expect(
          expired.service.issue({
            assertion:
              expiredAssertion,
            signature:
              await sign(
                expiredAssertion,
                expired.key.pair.privateKey,
              ),
          }),
        ).rejects.toMatchObject({
          code:
            "AUTHORIZATION_REQUIRED",
        });

        const tooLong =
          await setup();
        const longAssertion = {
          ...tooLong.assertion,
          issuedAt: 1_000,
          expiresAt: 200_000,
        };

        await expect(
          tooLong.service.issue({
            assertion:
              longAssertion,
            signature:
              await sign(
                longAssertion,
                tooLong.key.pair.privateKey,
              ),
          }),
        ).rejects.toMatchObject({
          code:
            "AUTHORIZATION_REQUIRED",
        });

        const outlives =
          await setup();
        const shortAssertion = {
          ...outlives.assertion,
          expiresAt: 15_000,
          grantTtlMs: 10_000,
        };

        await expect(
          outlives.service.issue({
            assertion:
              shortAssertion,
            signature:
              await sign(
                shortAssertion,
                outlives.key.pair.privateKey,
              ),
          }),
        ).rejects.toMatchObject({
          code:
            "AUTHORIZATION_REQUIRED",
        });
      },
    );
  },
);
