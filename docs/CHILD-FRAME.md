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

PR #7 已把 OOPIF 从“root session 看不到就降级”推进为 flat child-session exact mapping：

```text
root tab debugger session
  ↓ Target.setAutoAttach(flatten=true)
iframe child session
  ↓ opaque sessionId
Runtime / Page / DOM / Accessibility
```

映射仍然只接受 strong evidence：

- web frame 的 frameEpoch；
- exact CDP frame id；
- exact child session id；
- documentEpoch。

URL、frame 顺序、名称、几何相似度仍不参与 identity mapping。

如果 auto-attach 不可用、session 已 detach、frameEpoch 无法唯一匹配或 child context provenance 不完整：

```text
mapping unavailable
→ degraded / partial
→ actuation fail closed
```

## Child-frame Strict Click

PR #7 已完成 child-frame Strict Click 的受限开放。

执行链：

```text
retained Persistent Ref
→ exact frame/session/document binding
→ same-session live DOM + AX identity revalidation
→ child-local target point
→ 每层 live frame-owner content quad
→ 每层 parent owner hit-test
→ top-level viewport point
→ second Strict prepare
→ Input.dispatchMouseEvent
→ fresh observation + verification
```

支持：

- OOPIF；
- nested child frame；
- scroll / layout shift 后重新计算；
- 2D affine translate / scale / rotate / skew。

明确不支持并 fail closed：

- perspective / 3D 非 affine projection；
- degenerate content quad；
- stale document/session；
- detached child session；
- parent owner 被 overlay 遮挡；
- projected point 超出任一 live parent viewport。

Real Chromium E2E 已覆盖：

- OOPIF Hybrid exact mapping；
- OOPIF child 真正 Strict Click dispatch；
- child reload 后旧 ref 拒绝；
- iframe detach 后旧授权拒绝；
- transform/scroll 后 live projection；
- perspective transform fail closed；
- nested OOPIF 中间 owner 遮挡 fail closed，解除遮挡后恢复可执行。

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


## PR #7：child viewport → top-level viewport 投影核心

投影不使用 URL、iframe 顺序或几何相似度做 identity。对每一层 parent/child：

```text
retained FrameState.parentFrameId
  + exact lifecycle binding
  + live isolated-world frameEpoch
  ↓
parent session: DOM.getFrameOwner(childCdpFrameId)
  ↓
parent session: DOM.getBoxModel(frameOwner)
  ↓
child live viewport → owner content quad affine projection
  ↓
repeat until web:0
```

### 支持范围

当前只接受能证明为 2D affine 的 content quad：

- translate
- scale
- rotate
- skew

如果四个 content-quad 顶点不能构成近似平行四边形，则视为 perspective / 3D 或不可安全解释的几何，直接拒绝。

### root-level guard

投影完成后还需要：

1. projected point 位于实时 root viewport；
2. 通过 root isolated-world context 将最外层 frame-owner backend node resolve 成 live element；
3. `document.elementFromPoint(x, y)` 必须命中该 frame owner 或其后代。

该 guard 用于阻止 overlay、布局漂移或 stale geometry 让投影点实际落到别的顶层元素。

这一阶段只建立 projection core；在它接入 Strict prepare 并通过第二次 preflight / Real Chromium actuation E2E 之前，child click 仍保持不可 dispatch。


## PR #7：projection 接入 Strict prepare

child target 的 Strict prepare 现在形成完整的 read-only pre-dispatch 链：

```text
retained child ref
→ exact frame/session binding
→ same-session DOM + AX live identity
→ local actionability / hit-test
→ child→root coordinate projection
→ root frame-owner hit-test
→ PreparedStrictClickTarget(
     coordinateSpace = top-level-viewport
   )
```

如果 projection 任一步失败，resolver 返回 identity mismatch，coordinator 不会产生 prepared target。

为了避免未来误把 child-local coordinate 直接交给 root `Input.dispatchMouseEvent`，prepared target 明确携带：

```text
coordinateSpace: "top-level-viewport"
```

dispatcher 在发出任何输入事件前再次检查该字段。这个字段属于 trusted internal prepared state，不进入 model-facing surface。

真实执行路径仍会在 effect/authorization policy 通过后执行第二次 Strict prepare，所以 dispatch 前的 projection 是重新计算的，而不是复用第一次 prepare 的几何。


## PR #7：逐层 owner hit-test

nested child-frame 的坐标链不能只验证最外层 iframe。

例如：

```text
root
  └─ iframe A
       └─ overlay
       └─ iframe B
            └─ target
```

即使 root 的 `elementFromPoint()` 仍然命中 iframe A，如果 iframe B 在 A 的文档内部已经被 overlay 覆盖，最终 top-level mouse event 也不会到达 target。

因此 projection 现在对每一跳都执行：

```text
child-local point
→ owner content quad projection
→ parent live viewport bounds
→ parent execution context
→ DOM.resolveNode(owner backendNodeId)
→ parent document.elementFromPoint(projected point)
→ owner / owner descendant exact hit
→ next parent
```

任意中间层 owner hit-test 失败：

```text
projection fail
→ Strict resolver identityMatches=false
→ TARGET_IDENTITY_MISMATCH
→ no dispatch
```

这样 nested frame 的遮挡检查与坐标投影使用同一条 exact frame/session/document binding，不会只在 root 层做“看起来还在 iframe 里”的弱验证。


## Root presentation fence（OOPIF 输入路由）

projection 与逐层 owner hit-test 证明的是 main-thread 实时 layout 下的几何；真实 `Input.dispatchMouseEvent` 由浏览器按 root renderer 已 present 的 compositor hit-test 数据路由到具体 frame process。两者之间存在 presentation 延迟：

```text
scrollIntoView / layout shift
→ main-thread layout 已更新（prepare 命中 OOPIF owner）
→ root renderer 尚未 present 新 frame（后台 Tab 在 Linux 上约 1 fps）
→ 浏览器仍按旧 hit-test 数据把 press/release 路由给 root frame
→ 事件落在 root 文档的 iframe owner 上，child 收不到 click
```

因此目标位于 OOPIF child session 的 Strict Click 在 dispatch 前执行：

```text
strict prepare #2
→ root frame 独立 isolated world 中等待 3 个 requestAnimationFrame（页面不能替换该 world 的 rAF）
→ strict prepare #3
→ identity / frame binding / top-level 点与 #2 一致
→ grant TTL 复核
→ mousePressed / mouseReleased
```

fence 超时、异常、frame 不足或 root 文档 hidden：`TARGET_NOT_VISIBLE`；fence 期间几何变化：`TARGET_IDENTITY_MISMATCH`。两者都在任何 input 之前 fail closed，不自动重试 click。

已知限制：

- 有界面 Chrome 中 `active:false` 打开的后台 Tab 对页面是 hidden，浏览器不会为它 present frame，因此 OOPIF 目标的 Strict Click 在这种 Tab 中会直接 fail closed（headless CI 中后台 Tab 仍是 visible，只是约 1 fps）；
- fence 只证明 root renderer 已 present。nested OOPIF 中，路由到内层 frame 还依赖中间层 OOPIF renderer 已提交的 hit-test 数据，这一层尚未单独 fence；
- main-frame 目标不经过 fence。若页面在 scroll 后某个 OOPIF 移出了点击点、但旧 hit-test 数据尚未更新，理论上仍可能被路由到该 OOPIF；这是 fence 之前就存在的窗口，未来如需覆盖应按 frame 链逐层 fence，而不是让所有含 iframe 的页面都等待 rAF。
