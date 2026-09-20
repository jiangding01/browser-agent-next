import {
  BrowserRuntimeError,
} from "@browser-agent-next/core";

export interface EnterpriseAssertionReplayStore {
  consumeOnce(
    assertionId: string,
    expiresAt: number,
  ): Promise<boolean>;
}

export interface WritableStorageArea {
  get(
    keys: readonly string[],
  ): Promise<
    Record<string, unknown>
  >;
  set(
    items:
      Record<string, unknown>,
  ): Promise<void>;
  setAccessLevel(
    options: {
      accessLevel:
        "TRUSTED_CONTEXTS";
    },
  ): Promise<void>;
}

export interface ChromeStorageEnterpriseAssertionReplayStoreOptions {
  now?: () => number;
  maxEntries?: number;
  storageKey?: string;
}

function policyError(
  message: string,
): BrowserRuntimeError {
  return new BrowserRuntimeError(
    "POLICY_BLOCKED",
    message,
  );
}

function parseEntries(
  value: unknown,
): Map<string, number> {
  if (value === undefined) {
    return new Map();
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw policyError(
      "enterprise replay state is malformed",
    );
  }

  const entries =
    Object.entries(
      value as Record<
        string,
        unknown
      >,
    );

  if (entries.length > 4_096) {
    throw policyError(
      "enterprise replay state exceeds its bound",
    );
  }

  const result =
    new Map<string, number>();

  for (
    const [id, expiresAt]
    of entries
  ) {
    if (
      id.length < 1 ||
      id.length > 256 ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(
        expiresAt,
      ) ||
      expiresAt < 0
    ) {
      throw policyError(
        "enterprise replay state contains an invalid entry",
      );
    }

    result.set(
      id,
      expiresAt,
    );
  }

  return result;
}

/**
 * 跨 MV3 service-worker restart 的 assertion replay ledger。
 *
 * storage.local 在首次使用前被限制到 TRUSTED_CONTEXTS；
 * consume 操作在当前 worker 内串行，避免并发重复 assertion 同时通过。
 */
export class
ChromeStorageEnterpriseAssertionReplayStore
implements EnterpriseAssertionReplayStore {
  private readonly now:
    () => number;
  private readonly maxEntries:
    number;
  private readonly storageKey:
    string;
  private accessReady:
    Promise<void> | undefined;
  private queue:
    Promise<void> =
      Promise.resolve();

  constructor(
    private readonly storage:
      WritableStorageArea,
    options:
      ChromeStorageEnterpriseAssertionReplayStoreOptions = {},
  ) {
    this.now =
      options.now ?? Date.now;
    this.maxEntries =
      options.maxEntries ?? 512;
    this.storageKey =
      options.storageKey ??
      "enterpriseAuthorizationConsumedAssertions";

    if (
      !Number.isInteger(
        this.maxEntries,
      ) ||
      this.maxEntries < 1 ||
      this.maxEntries > 4_096
    ) {
      throw new Error(
        "maxEntries must be an integer between 1 and 4096",
      );
    }

    if (
      this.storageKey.length < 1 ||
      this.storageKey.length > 128
    ) {
      throw new Error(
        "storageKey must be a bounded non-empty string",
      );
    }
  }

  consumeOnce(
    assertionId: string,
    expiresAt: number,
  ): Promise<boolean> {
    const execute = async () => {
      await this.ensureTrustedAccess();

      let raw:
        Record<string, unknown>;

      try {
        raw =
          await this.storage.get([
            this.storageKey,
          ]);
      } catch {
        throw policyError(
          "enterprise replay state could not be read",
        );
      }

      const entries =
        parseEntries(
          raw[this.storageKey],
        );
      const now = this.now();

      for (
        const [id, expiry]
        of entries
      ) {
        if (expiry < now) {
          entries.delete(id);
        }
      }

      if (
        entries.has(assertionId)
      ) {
        return false;
      }

      if (
        entries.size >=
        this.maxEntries
      ) {
        throw policyError(
          "enterprise replay ledger is full of unexpired assertions",
        );
      }

      entries.set(
        assertionId,
        expiresAt,
      );

      try {
        await this.storage.set({
          [this.storageKey]:
            Object.fromEntries(
              entries,
            ),
        });
      } catch {
        throw policyError(
          "enterprise replay state could not be persisted",
        );
      }

      return true;
    };

    const result =
      this.queue.then(
        execute,
        execute,
      );

    this.queue =
      result.then(
        () => undefined,
        () => undefined,
      );

    return result;
  }

  private ensureTrustedAccess():
    Promise<void> {
    if (!this.accessReady) {
      this.accessReady =
        this.storage
          .setAccessLevel({
            accessLevel:
              "TRUSTED_CONTEXTS",
          })
          .catch(() => {
            this.accessReady =
              undefined;
            throw policyError(
              "enterprise replay storage could not be restricted to trusted contexts",
            );
          });
    }

    return this.accessReady;
  }
}
