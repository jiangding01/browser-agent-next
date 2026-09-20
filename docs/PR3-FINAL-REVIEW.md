# PR #3 最终对抗式审查

审查日期：2026-09-20

## 结论

PR #3 已达到 **Child-frame Exact Mapping + Hybrid Perception** 的阶段合并门槛。

当前未发现需要阻止该阶段合并的未解决 blocker。

本 PR 不尝试实现 child-frame real click；这是明确的边界。

## 已验证的关键属性

### 1. webNavigation ↔ CDP 不使用弱匹配

frame mapping 只依赖 isolated-world `frameEpoch` exact equality。

URL、顺序、parent index、role/name/geometry 不参与 mapping。

### 2. frameEpoch 冲突 fail closed

如果一个 frameEpoch 在 web 或 CDP 一侧不唯一：

```text
mapping = none
coverage = degraded / partial
```

不会进入启发式消歧。

### 3. main + child AX 使用各自 document identity

每个 AX strong identity 继续包含：

```text
tabId
+ cdpFrameId
+ documentEpoch
+ backendDOMNodeId
```

child 不借用 main documentEpoch。

### 4. DOM ↔ AX linking 泛化到多 frame

每个 frame 分别执行：

```text
backendDOMNodeId
→ exact live Element
→ frame-local stableId
```

然后才生成 mergeKey。

### 5. linking 不再额外静默截断

AX collection 已有显式 maxElements/coverage。

默认 linking 覆盖全部已收集 AX candidate，避免第二个隐式 200 条 cap 造成“source complete 但 merge 不完整”的状态。

### 6. child reload 生命周期已由真实 Chromium 验证

已验证：

- child Hybrid element 同时具有 DOM + AX provenance；
- child reload 后 child ref 变化；
- main ref 保持；
- 新 child element 再次建立 DOM + AX linked identity。

### 7. child-frame execute 继续 fail closed

即便 child target 已具有 linked DOM+AX strong identity，现有 Strict Resolver 仍拒绝 child frame。

原因不是 identity 不足，而是 top-level dispatch coordinate 尚未被证明正确。

### 8. OOPIF 未覆盖时显式降级

如果 root debugger session 无法得到 child execution context：

```text
unmapped frame
→ AX partial
```

不通过 URL 猜 target/session。

## 已知非 blocker

以下能力属于后续阶段：

- OOPIF child target/session exact mapping；
- child-frame coordinate projection；
- child-frame top-level hit-test；
- child-frame Strict Click；
- component adapter；
- Authorization Assurance levels；
- high-level browser.observe / act / verify；
- Jev FastPath。

当前缺失这些能力时均保持 fail closed。

## 合并门槛

当前实现已经通过：

- TypeScript typecheck；
- Unit tests；
- build；
- Real Chromium E2E；
- child Hybrid provenance E2E；
- child reload linked-identity lifecycle E2E；
- child Strict Prepare fail-closed E2E。

最新 HEAD CI 保持绿色后，PR #3 可以合并。
