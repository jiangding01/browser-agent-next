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

Lifecycle registry 会同时记录 frameEpoch、CDP frame id 与 documentEpoch。这样，AX 对应关系缺失的后续 DOM-only observation 不会覆盖同一文档已有的精确 binding；如果 navigation committed event 在 observation 之后才到达，但 documentEpoch 已经是当前文档，也不会误失效新文档的 refs。

真实 Chromium E2E 已覆盖 child reload 后的 frameEpoch、ref 失效与 main-frame ref 保持。AX-only binding 保留和迟到 navigation event 的回归目前由 unit tests 覆盖。

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


## PR #7：flat child-session transport baseline

PR #7 第一小步先扩展 Chrome debugger transport，不立即放宽 child-frame actuation。

Chrome 125+ 的 `chrome.debugger` flat sessions 可以在根 tab debugger 会话下通过 `sessionId` 精确寻址 OOPIF child target。当前 baseline 的目标是：

```text
root tab session
  ↓ Target.setAutoAttach(flatten=true, iframe only)
child iframe session
  ↓ Runtime/Page/DOM/Accessibility enable
  ↓ Target.setAutoAttach(flatten=true, iframe only)
nested iframe session
```

安全约束：

- registry 只接受 `targetInfo.type === "iframe"`；
- child session identity 使用 opaque `sessionId`，不按 URL 猜 target；
- Runtime execution context 记录所属 session；
- root-only `contextsForFrame()` 暂时保持原语义，避免现有调用方误把 child context 发送到 root session；
- 新增 session-aware context binding，后续 exact frame mapping 显式使用；
- child detach 会递归删除 descendants 与对应 contexts；
- 如果 flat auto-attach 不可用，现有 main-frame 功能继续工作，OOPIF 保持 unmapped / fail-closed。

这一小步本身不会让 child-frame Strict Click 变为可执行。


## OOPIF session-aware exact mapping

在 flat-session transport 之上，PR #7 第二小步把 session provenance 纳入 exact mapping：

```text
web frame
  ↓ frameEpoch exact equality
CDP frame candidate
  + root/child session provenance
  ↓
ExactFrameMapping {
  webFrameId,
  cdpFrameId,
  cdpSessionId?,
  frameEpoch,
  documentEpoch
}
```

OOPIF 的 AX 与 DOM identity resolution 必须使用 mapping 中同一个 `cdpSessionId`：

```text
Accessibility.getFullAXTree
DOM.resolveNode
Runtime.evaluate / callFunctionOn
```

不能因为已知 `cdpFrameId` 就把 child-session command 退回 root session。

如果同一 `frameEpoch` 在多个 CDP session/frame 中都能被证明，映射视为歧义并 fail closed。


## PR #7：Strict live revalidation 进入 child session

在开放坐标投影前，Strict resolver 先补齐 child target 的 exact live identity 复核：

```text
retained ref
  ↓
web frame + documentEpoch
  ↓
observed exact binding
(frameEpoch + cdpFrameId + cdpSessionId + documentEpoch)
  ↓
same-session backendDOMNodeId → stableId
  ↓
same-session live DOM inspection
  ↓
same-session partial AX tree
  ↓
identity exact
  ↓
coordinate projection unavailable
  → fail closed
```

这一步的目的不是提前开放 child click，而是确保后续 projection 只建立在“已经证明找对了 OOPIF 文档和节点”的 target 上。

任何以下情况都会在 projection 之前拒绝：

- child documentEpoch 已变化；
- lifecycle exact binding 缺失；
- frameEpoch 与 retained DOM identity 不一致；
- cdpFrameId 与 retained AX identity 不一致；
- child session provenance 不可用；
- backendDOMNodeId 不再解析为原 stableId；
- live DOM/AX target 不再存在。
