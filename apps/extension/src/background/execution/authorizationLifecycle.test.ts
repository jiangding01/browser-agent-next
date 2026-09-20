import { describe, expect, it } from "vitest";
import { InMemoryAuthorizationStore } from "@browser-agent-next/policy";
import { bindAuthorizationLifecycle } from "./authorizationLifecycle.js";

describe("bindAuthorizationLifecycle", () => {
  it("任意 navigation 都撤销 tab grant", () => {
    const store = new InMemoryAuthorizationStore({
      now: () => 0,
    });

    store.issue({
      id: "auth",
      tabId: 7,
      observedRevision: "rev",
      ref: "@e_1",
      actionKind: "click",
      effectClass: "unknown",
      assurance: "control-plane",
      ttlMs: 1000,
      source: "trusted-host",
    });

    let committed:
      | ((details: { tabId: number; frameId: number }) => void)
      | undefined;

    bindAuthorizationLifecycle(
      {
        tabs: {
          onRemoved: {
            addListener() {},
            removeListener() {},
          },
        },
        webNavigation: {
          onCommitted: {
            addListener(listener) {
              committed = listener;
            },
            removeListener() {},
          },
        },
      },
      store,
    );

    committed?.({ tabId: 7, frameId: 2 });
    expect(store.size()).toBe(0);
  });
});
