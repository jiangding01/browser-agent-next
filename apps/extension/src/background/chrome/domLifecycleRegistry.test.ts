import { describe, expect, it, vi } from "vitest";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
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

  it("child commit 会失效精确绑定的 AX-only ref，但保留其它 frame", () => {
    const refs = new InMemoryPersistentRefStore();
    const lifecycle = new DomLifecycleRegistry(
      refs,
      { clearTab: vi.fn() } as never,
    );
    const childRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-child",
      documentEpoch: "chrome-document:child-old",
      backendNodeId: 101,
    }, "element", "rev-1");
    const childNewDocumentRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-child",
      documentEpoch: "chrome-document:child-new",
      backendNodeId: 102,
    }, "element", "rev-2");
    const mainRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-main",
      documentEpoch: "chrome-document:main",
      backendNodeId: 202,
    }, "element", "rev-1");
    const otherChildRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-other-child",
      documentEpoch: "chrome-document:other",
      backendNodeId: 303,
    }, "element", "rev-1");

    lifecycle.recordObserved(7, {
      "web:0": "epoch-main",
      "web:2": "epoch-child-old",
    }, {
      "web:0": {
        frameEpoch: "epoch-main",
        cdpFrameId: "cdp-main",
        documentEpoch: "chrome-document:main",
      },
      "web:2": {
        frameEpoch: "epoch-child-old",
        cdpFrameId: "cdp-child",
        documentEpoch: "chrome-document:child-old",
      },
    });

    lifecycle.committed({
      tabId: 7,
      frameId: 2,
      documentId: "child-next",
    });

    expect(refs.byRef(childRef)?.tombstonedAtRevision).toBe(
      "navigation:child-next",
    );
    expect(refs.byRef(childNewDocumentRef)?.tombstonedAtRevision).toBeUndefined();
    expect(refs.byRef(mainRef)?.tombstonedAtRevision).toBeUndefined();
    expect(refs.byRef(otherChildRef)?.tombstonedAtRevision).toBeUndefined();
  });

  it("没有精确 CDP mapping 时不猜测 AX frame，不误杀其它 AX ref", () => {
    const refs = new InMemoryPersistentRefStore();
    const lifecycle = new DomLifecycleRegistry(
      refs,
      { clearTab: vi.fn() } as never,
    );
    const oldChildRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-child-unknown",
      documentEpoch: "chrome-document:child-old",
      backendNodeId: 404,
    }, "element", "rev-1");

    lifecycle.recordObserved(7, { "web:2": "epoch-child-old" });
    lifecycle.committed({
      tabId: 7,
      frameId: 2,
      documentId: "child-next",
    });

    expect(refs.byRef(oldChildRef)?.tombstonedAtRevision).toBeUndefined();
  });

  it("同一 frameEpoch 的 DOM-only 重观察不会丢失既有 AX binding", () => {
    const refs = new InMemoryPersistentRefStore();
    const lifecycle = new DomLifecycleRegistry(
      refs,
      { clearTab: vi.fn() } as never,
    );
    const childRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-child",
      documentEpoch: "chrome-document:child-old",
      backendNodeId: 505,
    }, "element", "rev-1");

    lifecycle.recordObserved(7, {
      "web:2": "epoch-child-old",
    }, {
      "web:2": {
        frameEpoch: "epoch-child-old",
        cdpFrameId: "cdp-child",
        documentEpoch: "chrome-document:child-old",
      },
    });
    lifecycle.recordObserved(7, {
      "web:2": "epoch-child-old",
    });

    lifecycle.committed({
      tabId: 7,
      frameId: 2,
      documentId: "child-next",
    });

    expect(refs.byRef(childRef)?.tombstonedAtRevision).toBe(
      "navigation:child-next",
    );
  });

  it("同一 frameEpoch 的 unknown 到 known documentEpoch 会补充 binding", () => {
    const refs = new InMemoryPersistentRefStore();
    const lifecycle = new DomLifecycleRegistry(
      refs,
      { clearTab: vi.fn() } as never,
    );
    const childRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-child",
      documentEpoch: "chrome-document:child-old",
      backendNodeId: 555,
    }, "element", "rev-1");

    lifecycle.recordObserved(7, { "web:2": "epoch-child" });
    lifecycle.recordObserved(7, { "web:2": "epoch-child" }, undefined, {
      "web:2": "chrome-document:child-old",
    });
    lifecycle.committed({
      tabId: 7,
      frameId: 2,
      documentId: "child-next",
    });

    expect(refs.byRef(childRef)?.tombstonedAtRevision).toBeUndefined();
  });

  it("未知 documentEpoch 但 frameEpoch 变化时失效旧 DOM ref", () => {
    const refs = new InMemoryPersistentRefStore();
    const lifecycle = new DomLifecycleRegistry(
      refs,
      { clearTab: vi.fn() } as never,
    );
    const oldRef = refs.getOrCreate({
      source: "dom",
      tabId: 7,
      frameEpoch: "epoch-child-old",
      stableId: "old",
    }, "element", "rev-old");
    lifecycle.recordObserved(7, { "web:2": "epoch-child-old" });

    const newRef = refs.getOrCreate({
      source: "dom",
      tabId: 7,
      frameEpoch: "epoch-child-new",
      stableId: "new",
    }, "element", "rev-new");
    lifecycle.recordObserved(7, { "web:2": "epoch-child-new" });

    expect(refs.byRef(oldRef)?.tombstonedAtRevision).toBe(
      "observation:frame-epoch-child-new",
    );
    expect(refs.byRef(newRef)?.tombstonedAtRevision).toBeUndefined();
  });

  it("延迟到达的同文档 child commit 不会失效新 observation", () => {
    const refs = new InMemoryPersistentRefStore();
    const states = { clearTab: vi.fn() };
    const authorizations = { clearTab: vi.fn() };
    const lifecycle = new DomLifecycleRegistry(
      refs,
      states as never,
      authorizations,
    );
    const childRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-child",
      documentEpoch: "chrome-document:child-new",
      backendNodeId: 606,
    }, "element", "rev-new");

    lifecycle.recordObserved(7, {
      "web:2": "epoch-child-new",
    }, {
      "web:2": {
        frameEpoch: "epoch-child-new",
        cdpFrameId: "cdp-child",
        documentEpoch: "chrome-document:child-new",
      },
    });
    lifecycle.committed({
      tabId: 7,
      frameId: 2,
      documentId: "child-new",
    });

    expect(refs.byRef(childRef)?.tombstonedAtRevision).toBeUndefined();
    expect(states.clearTab).not.toHaveBeenCalled();
    expect(authorizations.clearTab).toHaveBeenCalledWith(7);
  });

  it("延迟到达的同文档 main commit 保留 retained state/ref，但撤销授权", () => {
    const { refs, states, authorizations, lifecycle } = registry();
    lifecycle.recordObserved(7, {
      "web:0": "epoch-main-new",
    }, undefined, {
      "web:0": "chrome-document:main-new",
    });

    lifecycle.committed({
      tabId: 7,
      frameId: 0,
      documentId: "main-new",
    });

    expect(refs.invalidateTab).not.toHaveBeenCalled();
    expect(states.clearTab).not.toHaveBeenCalled();
    expect(authorizations.clearTab).toHaveBeenCalledWith(7);
  });

  it("新 child observation 先于 commit 时只失效旧 document 的 AX ref", () => {
    const refs = new InMemoryPersistentRefStore();
    const lifecycle = new DomLifecycleRegistry(
      refs,
      { clearTab: vi.fn() } as never,
      { clearTab: vi.fn() },
    );
    const oldRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-child",
      documentEpoch: "chrome-document:child-old",
      backendNodeId: 707,
    }, "element", "rev-old");
    lifecycle.recordObserved(7, { "web:2": "epoch-child-old" }, {
      "web:2": {
        frameEpoch: "epoch-child-old",
        cdpFrameId: "cdp-child",
        documentEpoch: "chrome-document:child-old",
      },
    });

    const newRef = refs.getOrCreate({
      source: "ax",
      tabId: 7,
      cdpFrameId: "cdp-child",
      documentEpoch: "chrome-document:child-new",
      backendNodeId: 708,
    }, "element", "rev-new");
    lifecycle.recordObserved(7, { "web:2": "epoch-child-new" }, {
      "web:2": {
        frameEpoch: "epoch-child-new",
        cdpFrameId: "cdp-child",
        documentEpoch: "chrome-document:child-new",
      },
    });

    expect(refs.byRef(oldRef)?.tombstonedAtRevision).toBe(
      "observation:chrome-document:child-new",
    );
    expect(refs.byRef(newRef)?.tombstonedAtRevision).toBeUndefined();
  });

  it("新 main observation 先于 commit 时清理旧 state/ref，但保留新 ref", () => {
    const refs = new InMemoryPersistentRefStore();
    const states = { clearTab: vi.fn() };
    const lifecycle = new DomLifecycleRegistry(
      refs,
      states as never,
      { clearTab: vi.fn() },
    );
    const oldRef = refs.getOrCreate({
      source: "dom",
      tabId: 7,
      frameEpoch: "epoch-main-old",
      stableId: "old",
    }, "element", "rev-old");
    lifecycle.recordObserved(7, { "web:0": "epoch-main-old" }, undefined, {
      "web:0": "chrome-document:main-old",
    });

    const newRef = refs.getOrCreate({
      source: "dom",
      tabId: 7,
      frameEpoch: "epoch-main-new",
      stableId: "new",
    }, "element", "rev-new");
    lifecycle.recordObserved(7, { "web:0": "epoch-main-new" }, undefined, {
      "web:0": "chrome-document:main-new",
    });

    expect(refs.byRef(oldRef)?.tombstonedAtRevision).toBe(
      "observation:chrome-document:main-new",
    );
    expect(refs.byRef(newRef)?.tombstonedAtRevision).toBeUndefined();
    expect(states.clearTab).toHaveBeenCalledWith(7);
  });

  it("后续不同文档的 commit 仍失效旧 main state/ref", () => {
    const { refs, states, authorizations, lifecycle } = registry();
    lifecycle.recordObserved(7, {
      "web:0": "epoch-main-old",
    }, undefined, {
      "web:0": "chrome-document:main-old",
    });

    lifecycle.committed({
      tabId: 7,
      frameId: 0,
      documentId: "main-next",
    });

    expect(refs.invalidateTab).toHaveBeenCalledWith(
      7,
      "navigation:main-next",
      "main-document-committed",
    );
    expect(states.clearTab).toHaveBeenCalledWith(7);
    expect(authorizations.clearTab).toHaveBeenCalledWith(7);
  });

  it("只读查询会返回 observation 记录的 exact frame/session binding 副本", () => {
    const { lifecycle } = registry();

    lifecycle.recordObserved(
      7,
      { "web:2": "epoch-child" },
      {
        "web:2": {
          frameEpoch: "epoch-child",
          cdpFrameId: "cdp-child",
          cdpSessionId: "session-child",
          documentEpoch: "chrome-document:child",
        },
      },
    );

    const first = lifecycle.bindingForFrame(7, "web:2");
    expect(first).toEqual({
      frameEpoch: "epoch-child",
      cdpFrameId: "cdp-child",
      cdpSessionId: "session-child",
      documentEpoch: "chrome-document:child",
    });

    if (first) first.frameEpoch = "mutated";

    expect(
      lifecycle.bindingForFrame(7, "web:2")?.frameEpoch,
    ).toBe("epoch-child");
  });
});
