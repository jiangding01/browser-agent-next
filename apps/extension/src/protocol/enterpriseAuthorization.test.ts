import {
  describe,
  expect,
  it,
} from "vitest";
import {
  canonicalEnterpriseAuthorizationAssertion,
  isEnterpriseAuthorizationEnvelope,
  type EnterpriseAuthorizationAssertion,
} from "./enterpriseAuthorization.js";

const assertion:
  EnterpriseAuthorizationAssertion = {
    version: 1,
    assertionId: "assertion-1",
    keyId: "enterprise-key-1",
    authorizationId: "auth-1",
    tabId: 7,
    observedRevision: "rev-1",
    ref: "@e_1",
    origin: "https://fixture.test",
    actionKind: "click",
    effectClass: "unknown",
    issuedAt: 1_000,
    expiresAt: 61_000,
    grantTtlMs: 30_000,
  };

describe(
  "enterprise authorization protocol",
  () => {
    it(
      "只接受 exact-key bounded assertion envelope",
      () => {
        expect(
          isEnterpriseAuthorizationEnvelope({
            assertion,
            signature:
              "Abcd_1234-xyz",
          }),
        ).toBe(true);

        expect(
          isEnterpriseAuthorizationEnvelope({
            assertion: {
              ...assertion,
              assurance:
                "enterprise-policy",
            },
            signature:
              "Abcd_1234-xyz",
          }),
        ).toBe(false);

        expect(
          isEnterpriseAuthorizationEnvelope({
            assertion: {
              ...assertion,
              origin:
                "https://fixture.test/path",
            },
            signature:
              "Abcd_1234-xyz",
          }),
        ).toBe(false);

        expect(
          isEnterpriseAuthorizationEnvelope({
            assertion,
            signature:
              "not+base64url",
          }),
        ).toBe(false);
      },
    );

    it(
      "canonical payload 字段顺序固定且忽略对象构造顺序",
      () => {
        const rebuilt = {
          effectClass: "unknown",
          actionKind: "click",
          ref: "@e_1",
          version: 1,
          assertionId:
            "assertion-1",
          keyId:
            "enterprise-key-1",
          authorizationId:
            "auth-1",
          tabId: 7,
          observedRevision:
            "rev-1",
          origin:
            "https://fixture.test",
          issuedAt: 1_000,
          expiresAt: 61_000,
          grantTtlMs: 30_000,
        } as EnterpriseAuthorizationAssertion;

        expect(
          canonicalEnterpriseAuthorizationAssertion(
            rebuilt,
          ),
        ).toBe(
          canonicalEnterpriseAuthorizationAssertion(
            assertion,
          ),
        );
      },
    );
  },
);
