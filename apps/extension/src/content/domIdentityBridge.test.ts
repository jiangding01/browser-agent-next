import { describe, expect, it } from "vitest";
import { DomFramePerceptionSource } from "./domFrameSource.js";
import {
  DOM_IDENTITY_BRIDGE_KEY,
  installDomIdentityBridge,
} from "./domIdentityBridge.js";

describe("DOM identity bridge", () => {
  it("只返回已经由 DOM perception 分配过的 stableId", () => {
    const source = new DomFramePerceptionSource("frame-a");
    const connected = {
      isConnected: true,
    } as Element;
    const unknown = {
      isConnected: true,
    } as Element;

    const knownId = (
      source as unknown as {
        stableIds: { idFor(element: Element): string };
      }
    ).stableIds.idFor(connected);

    const target = {} as typeof globalThis;
    const bridge = installDomIdentityBridge(target, source);

    expect(bridge.frameEpoch).toBe("frame-a");
    expect(bridge.stableIdOf(connected)).toBe(knownId);
    expect(bridge.stableIdOf(unknown)).toBeNull();
    expect(
      (target as unknown as Record<string, unknown>)[DOM_IDENTITY_BRIDGE_KEY],
    ).toBe(bridge);
  });
});
