# Child-frame Exact Mapping

最后更新：2026-09-20

## 目标

把 PR #2 的 main-frame Hybrid Perception 扩展到 child frame，同时保持同一条身份原则：

> **语义相似不能证明对象身份。**

webNavigation 和 CDP 的 frame id 不属于同一个命名空间，因此不能直接互换。

## 最终映射链路

```text
webNavigation frame
        │
        │ content script
        ▼
random frameEpoch
        │ exact equality
        ▼
CDP Runtime execution context
        │
        ▼
CDP Page.FrameId
        │
        ▼
Accessibility.getFullAXTree(frameId)
        │
        ▼
backendDOMNodeId
        │ exact live-object resolution
        ▼
DOM stableId
        │
        ▼
linked Persistent Ref
```

这里存在两次独立的 exact proof：

1. `web frame ↔ CDP frame` 由 `frameEpoch` 证明；
2. `AX node ↔ DOM element` 由 `backendDOMNodeId → live Element → stableId` 证明。

## 明确禁止的映射依据

下列信息只能用于展示或诊断，不能作为 frame identity：

- URL 相同；
- URL 唯一；
- child frame 顺序；
- parent/child index；
- DOM/AX role；
- accessible name；
- geometry；
- 页面文本。

即使两个 iframe URL 完全不同，也不会用 URL 做映射。

## Coverage 语义

如果 declared accessible frame 中任何一个无法 exact mapping：

```text
AX coverage = partial
```

而不是：

```text
“剩余 frame 都成功，所以 complete”
```

这意味着上层 FastPath 可以明确知道 Hybrid action space 不完整。

## Navigation 生命周期

child reload 后：

- child content-script instance 重新生成 `frameEpoch`；
- 新 frameEpoch 重新映射到当前 CDP frame；
- 新 AX backend node 与新 DOM stableId 重新 link；
- 旧 child Persistent Ref 不得继续表示 replacement document 中的对象；
- main frame 未导航时 main ref 保持。

真实 Chromium E2E 已覆盖这个行为。

## OOPIF / cross-process iframe

当前实现使用 tab root `chrome.debugger` session 中可观察到的 execution context 建立 mapping。

如果 cross-process/OOPIF 没有暴露在当前 root session：

```text
mapping unavailable
→ degraded/unmapped frame
→ AX coverage partial
```

当前不会：

- 按 URL 猜对应 session；
- 自动 attach 任意 child target；
- 把未知 child frame 当成 main-frame AX。

OOPIF exact session mapping 后续应作为独立能力设计。

## 为什么暂不开放 child-frame Strict Click

child frame 内：

```text
getBoundingClientRect()
```

得到的是 **frame-local viewport 坐标**。

而：

```text
Input.dispatchMouseEvent
```

需要 top-level target viewport 坐标。

直接把 child-local point 传给 CDP Input 会点错位置，因此 PR #3 明确只扩展：

```text
Perception
Identity
Lifecycle
```

不扩展：

```text
Child-frame Actuation
```

真正执行前至少还需要：

1. frame-owner element exact identity；
2. nested frame offset projection；
3. scroll/transform/border 等坐标语义验证；
4. top-level fresh hit-test；
5. dispatch 前第二次 projection/preflight；
6. adversarial E2E。

## 当前结论

PR #3 的 child-frame 支持是：

```text
可观察
可建立强身份
可维护生命周期
不可直接自动点击
```

这是有意的安全边界，不是功能遗漏。
