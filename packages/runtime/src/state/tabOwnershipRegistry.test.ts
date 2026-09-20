import { describe, expect, it } from "vitest";
import { TabOwnershipRegistry } from "./tabOwnershipRegistry.js";

describe("TabOwnershipRegistry", () => {
  it("只有真实 markCreated 的 tab 才被视为 agent-owned", () => {
    const registry = new TabOwnershipRegistry(() => 123);

    expect(registry.isOwned(7)).toBe(false);
    expect(registry.markCreated(7)).toEqual({
      tabId: 7,
      createdAt: 123,
    });
    expect(registry.isOwned(7)).toBe(true);

    registry.tabRemoved(7);
    expect(registry.isOwned(7)).toBe(false);
  });

  it("拒绝非法 tabId", () => {
    const registry = new TabOwnershipRegistry();

    expect(() => registry.markCreated(-1)).toThrow(/tabId/);
    expect(() => registry.markCreated(1.5)).toThrow(/tabId/);
  });
});
