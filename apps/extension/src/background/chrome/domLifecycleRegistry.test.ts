import { describe, expect, it, vi } from "vitest";
import { DomLifecycleRegistry } from "./domLifecycleRegistry.js";

function registry() {
  const refs = {
    invalidateTab: vi.fn(),
    invalidateFrame: vi.fn(),
  };
  const states = {
    clearTab: vi.fn(),
  };
  const authorizations = {
    clearTab: vi.fn(),
  };

  return {
    refs,
    states,
    authorizations,
    lifecycle: new DomLifecycleRegistry(
      refs as never,
      states as never,
      authorizations,
    ),
  };
}

describe("DomLifecycleRegistry authorization lifecycle", () => {
  it("main navigation 同时失效 refs、state 和未消费授权", () => {
    const {
      refs,
      states,
      authorizations,
      lifecycle,
    } = registry();

    lifecycle.committed({
      tabId: 7,
      frameId: 0,
      documentId: "doc-next",
    });

    expect(refs.invalidateTab).toHaveBeenCalledWith(
      7,
      "navigation:doc-next",
      "main-document-committed",
    );
    expect(states.clearTab).toHaveBeenCalledWith(7);
    expect(authorizations.clearTab).toHaveBeenCalledWith(7);
  });

  it("child navigation 也保守撤销 tab-scoped grant", () => {
    const { authorizations, lifecycle } = registry();

    lifecycle.recordObserved(7, {
      "web:2": "frame-epoch-child",
    });

    lifecycle.committed({
      tabId: 7,
      frameId: 2,
      documentId: "child-next",
    });

    expect(authorizations.clearTab).toHaveBeenCalledWith(7);
  });

  it("tab removal 撤销对应授权", () => {
    const { authorizations, lifecycle } = registry();
    lifecycle.tabRemoved(7);
    expect(authorizations.clearTab).toHaveBeenCalledWith(7);
  });
});
