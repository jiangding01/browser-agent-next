import {
  BrowserRuntimeError,
} from "@browser-agent-next/core";

export const ENTERPRISE_POLICY_STORAGE_KEYS = {
  keyId:
    "EnterpriseAuthorizationKeyId",
  publicKeySpkiBase64:
    "EnterpriseAuthorizationPublicKeySpkiBase64",
  maxAssertionLifetimeMs:
    "EnterpriseAuthorizationMaxAssertionLifetimeMs",
} as const;

export interface EnterpriseAuthorizationPolicy {
  keyId: string;
  publicKeySpkiBase64: string;
  maxAssertionLifetimeMs: number;
}

export interface EnterpriseAuthorizationPolicyProvider {
  load():
    Promise<
      EnterpriseAuthorizationPolicy |
      undefined
    >;
}

export interface ManagedStorageArea {
  get(
    keys: readonly string[],
  ): Promise<
    Record<string, unknown>
  >;
  setAccessLevel(
    options: {
      accessLevel:
        "TRUSTED_CONTEXTS";
    },
  ): Promise<void>;
}

function policyError(
  message: string,
): BrowserRuntimeError {
  return new BrowserRuntimeError(
    "POLICY_BLOCKED",
    message,
  );
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function validBase64(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= 64 &&
    value.length <= 2_048 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(
      value,
    )
  );
}

/**
 * 只从 chrome.storage.managed 读取管理员配置。
 *
 * managed storage 在首次读取前被限制到 TRUSTED_CONTEXTS。
 * 不缓存 policy，管理员更新后下一次 assertion 会读取新值。
 */
export class
ChromeManagedEnterpriseAuthorizationPolicyProvider
implements EnterpriseAuthorizationPolicyProvider {
  private accessReady:
    Promise<void> | undefined;

  constructor(
    private readonly managed:
      ManagedStorageArea,
  ) {}

  async load():
    Promise<
      EnterpriseAuthorizationPolicy |
      undefined
    > {
    await this.ensureTrustedAccess();

    let raw:
      Record<string, unknown>;

    try {
      raw = await this.managed.get([
        ENTERPRISE_POLICY_STORAGE_KEYS.keyId,
        ENTERPRISE_POLICY_STORAGE_KEYS
          .publicKeySpkiBase64,
        ENTERPRISE_POLICY_STORAGE_KEYS
          .maxAssertionLifetimeMs,
      ]);
    } catch {
      throw policyError(
        "enterprise managed policy could not be read",
      );
    }

    const keyId =
      raw[
        ENTERPRISE_POLICY_STORAGE_KEYS
          .keyId
      ];
    const publicKey =
      raw[
        ENTERPRISE_POLICY_STORAGE_KEYS
          .publicKeySpkiBase64
      ];
    const maxLifetime =
      raw[
        ENTERPRISE_POLICY_STORAGE_KEYS
          .maxAssertionLifetimeMs
      ];

    if (
      keyId === undefined &&
      publicKey === undefined &&
      maxLifetime === undefined
    ) {
      return undefined;
    }

    if (
      typeof keyId !== "string" ||
      keyId.length < 1 ||
      keyId.length > 128 ||
      !validBase64(publicKey) ||
      (
        maxLifetime !== undefined &&
        !boundedInteger(
          maxLifetime,
          1_000,
          300_000,
        )
      )
    ) {
      throw policyError(
        "enterprise managed authorization policy is incomplete or malformed",
      );
    }

    return {
      keyId,
      publicKeySpkiBase64:
        publicKey,
      maxAssertionLifetimeMs:
        maxLifetime === undefined
          ? 120_000
          : maxLifetime,
    };
  }

  private ensureTrustedAccess():
    Promise<void> {
    if (!this.accessReady) {
      this.accessReady =
        this.managed
          .setAccessLevel({
            accessLevel:
              "TRUSTED_CONTEXTS",
          })
          .catch(() => {
            this.accessReady =
              undefined;
            throw policyError(
              "enterprise managed policy could not be restricted to trusted contexts",
            );
          });
    }

    return this.accessReady;
  }
}
