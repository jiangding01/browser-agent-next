export interface TabOwnershipRecord {
  tabId: number;
  createdAt: number;
}

/**
 * 只记录由当前 Browser Runtime 真实创建的 Tab。
 *
 * 不提供 claim(tabId) 之类的 API，避免调用方把用户已有 Tab 自报成 Agent-owned。
 * MV3 service worker 重启后内存状态丢失，因此默认安全降级为 user-existing。
 */
export class TabOwnershipRegistry {
  private readonly owned = new Map<number, TabOwnershipRecord>();

  constructor(
    private readonly now: () => number = Date.now,
  ) {}

  markCreated(tabId: number): TabOwnershipRecord {
    if (!Number.isInteger(tabId) || tabId < 0) {
      throw new Error("tabId must be a non-negative integer");
    }

    const record = {
      tabId,
      createdAt: this.now(),
    };
    this.owned.set(tabId, record);
    return record;
  }

  isOwned(tabId: number): boolean {
    return this.owned.has(tabId);
  }

  tabRemoved(tabId: number): void {
    this.owned.delete(tabId);
  }

  size(): number {
    return this.owned.size;
  }
}
