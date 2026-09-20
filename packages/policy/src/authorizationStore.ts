import type {
  AuthorizationAssurance,
  BrowserActionKind,
  EffectClass,
  RevisionId,
} from "@browser-agent-next/core";

export interface AuthorizationGrant {
  id: string;
  tabId: number;
  observedRevision: RevisionId;
  ref: string;
  actionKind: BrowserActionKind;
  effectClass: EffectClass;
  assurance: AuthorizationAssurance;
  issuedAt: number;
  expiresAt: number;
  singleUse: boolean;
  source: "trusted-ui" | "trusted-host";
}

export interface IssueAuthorizationInput {
  id: string;
  tabId: number;
  observedRevision: RevisionId;
  ref: string;
  actionKind: BrowserActionKind;
  effectClass: EffectClass;
  assurance: AuthorizationAssurance;
  ttlMs: number;
  singleUse?: boolean;
  source: AuthorizationGrant["source"];
}

export interface ConsumeAuthorizationInput {
  id: string;
  tabId: number;
  observedRevision: RevisionId;
  ref: string;
  actionKind: BrowserActionKind;
  effectClass: EffectClass;
  minimumAssurance?: AuthorizationAssurance;
}

export type AuthorizationConsumeResult =
  | {
      ok: true;
      grant: AuthorizationGrant;
    }
  | {
      ok: false;
      reason:
        | "missing"
        | "expired"
        | "binding-mismatch"
        | "assurance-insufficient";
    };

export interface AuthorizationStoreOptions {
  now?: () => number;
  maxGrants?: number;
}

const ASSURANCE_RANK: Record<AuthorizationAssurance, number> = {
  "control-plane": 1,
  "operator-approved": 2,
  "enterprise-policy": 3,
};

export function authorizationAssuranceSatisfies(
  actual: AuthorizationAssurance,
  minimum: AuthorizationAssurance,
): boolean {
  return ASSURANCE_RANK[actual] >= ASSURANCE_RANK[minimum];
}

/**
 * 只保存由可信控制面签发的短期授权。
 *
 * assurance 是 grant 的可信属性，必须由签发入口决定，不能由模型或页面声明。
 * Grant 与 tab/revision/ref/action/effect 精确绑定，默认一次性消费。
 */
export class InMemoryAuthorizationStore {
  private readonly now: () => number;
  private readonly maxGrants: number;
  private readonly grants = new Map<string, AuthorizationGrant>();

  constructor(options: AuthorizationStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxGrants = options.maxGrants ?? 256;

    if (!Number.isInteger(this.maxGrants) || this.maxGrants < 1) {
      throw new Error("maxGrants must be a positive integer");
    }
  }

  issue(input: IssueAuthorizationInput): AuthorizationGrant {
    if (!input.id.trim()) {
      throw new Error("authorization id must be non-empty");
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("authorization ttlMs must be > 0");
    }

    const issuedAt = this.now();
    const existing = this.grants.get(input.id);

    if (existing) {
      if (existing.expiresAt > issuedAt) {
        throw new Error(
          "authorization id already exists and is still active",
        );
      }
      this.grants.delete(input.id);
    }

    const grant: AuthorizationGrant = {
      id: input.id,
      tabId: input.tabId,
      observedRevision: input.observedRevision,
      ref: input.ref,
      actionKind: input.actionKind,
      effectClass: input.effectClass,
      assurance: input.assurance,
      issuedAt,
      expiresAt: issuedAt + input.ttlMs,
      singleUse: input.singleUse ?? true,
      source: input.source,
    };

    this.grants.set(grant.id, grant);
    this.trim();
    return grant;
  }

  consume(
    input: ConsumeAuthorizationInput,
  ): AuthorizationConsumeResult {
    const grant = this.grants.get(input.id);
    if (!grant) {
      return { ok: false, reason: "missing" };
    }

    if (grant.expiresAt <= this.now()) {
      this.grants.delete(input.id);
      return { ok: false, reason: "expired" };
    }

    if (
      grant.tabId !== input.tabId ||
      grant.observedRevision !== input.observedRevision ||
      grant.ref !== input.ref ||
      grant.actionKind !== input.actionKind ||
      grant.effectClass !== input.effectClass
    ) {
      return { ok: false, reason: "binding-mismatch" };
    }

    if (
      input.minimumAssurance !== undefined &&
      !authorizationAssuranceSatisfies(
        grant.assurance,
        input.minimumAssurance,
      )
    ) {
      return {
        ok: false,
        reason: "assurance-insufficient",
      };
    }

    if (grant.singleUse) {
      this.grants.delete(input.id);
    }

    return { ok: true, grant };
  }

  revoke(id: string): void {
    this.grants.delete(id);
  }

  clearTab(tabId: number): void {
    for (const [id, grant] of this.grants) {
      if (grant.tabId === tabId) {
        this.grants.delete(id);
      }
    }
  }

  size(): number {
    return this.grants.size;
  }

  private trim(): void {
    while (this.grants.size > this.maxGrants) {
      const oldest = this.grants.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.grants.delete(oldest);
    }
  }
}
