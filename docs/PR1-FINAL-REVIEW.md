# PR #1 最终对抗式审查

审查日期：2026-09-19

## 结论

PR #1 已达到“Foundation + DOM Perception 基线”合并门槛。

本次审查没有发现需要阻止该 PR 合并的未解决 blocker。

注意：这不代表 Browser Agent 已经完成，也不代表可以开始无人值守自动点击。PR #1 的边界仍然是：

```text
状态
身份
DOM 感知
生命周期
Delta
Strict Preflight
```

真实浏览器执行器、AX Hybrid Perception、Jev、WebMCP 等仍属于后续 PR。

---

## 已验证的关键不变量

### 1. Same-looking replacement 不继承旧 ref

真实 Chromium E2E 已覆盖：

```text
<button id="main-action">Save</button>
↓ replaceWith(cloneNode)
视觉与语义保持相同
↓
Persistent Ref 必须变化
```

这证明当前 ref continuity 绑定 live object identity，而不是 role/name/text 相似度。

### 2. Child frame reload 只失效 child identity

真实 Chromium E2E 已验证：

- main frame ref 保持；
- child frame ref 变化；
- child navigation 通过 frame lifecycle 精确失效。

### 3. Main navigation 清空旧 document state

main-frame commit 会：

- invalidate tab refs；
- clear TabStateStore；
- clear recorded frame epochs。

新 observation 使用新的 Chrome `documentId` / document epoch。

### 4. Observation 期间发生导航时整次 observation 作废

DOM collection 后、分配 ref 和写入 state 前，会重新获取完整 frame/document catalog。

若以下任一项变化：

- main document；
- child document；
- frame topology；
- main frame URL；

则本次 observation 不提交。

这关闭了“旧 content response 到达后恰好发生导航”的 TOCTOU 窗口。

### 5. URL 与 document identity 来自同一 frame catalog

BrowserObservation 的 canonical URL 不再使用可能和 webNavigation catalog 跨导航竞态的独立 tab URL。

### 6. Coverage 不因采集失败被错误报告为 complete

不可访问或失败的 frame 会：

```text
coverage → partial
degradedFrames → 显式记录
warnings → 显式记录
```

### 7. Complete observation 才允许 disappearance tombstone

只有在：

- same document；
- same observation scope；
- actionable coverage = complete；

时，旧 actionable ref 的消失才会被 tombstone。

partial / truncated / unknown observation 不会因为“没看到”就错误删除旧 identity。

### 8. MV3 Service Worker restart 不把裸 ref 当永久权威身份

`stateEpoch` 是 runtime-lifetime 边界。

旧 ref 字符串即便未来出现相同格式，也不能脱离 stored observation 独立用于 Strict Action。

Strict Action 仍必须绑定：

```text
observedRevision + ref
```

---

## 本轮明确不视为 blocker 的内容

以下能力仍未完成，但属于后续阶段，不阻止 PR #1 合并：

- live AX source；
- DOM ↔ AX backend-node strong correspondence；
- component adapters；
- stored-observation Strict Executor coordinator；
- live hit test；
- Effect classifier / authorization token；
- Jev Fast Policy；
- WebMCP；
- Vision / CUA。

---

## 合并后下一阶段

建议新分支：

```text
feat/hybrid-perception-strict-executor
```

优先顺序：

1. AX perception source；
2. DOM ↔ AX exact strong correspondence；
3. Hybrid BrowserState；
4. stored observation strict executor coordinator；
5. live target resolve；
6. fresh viewport + hit-test；
7. replacement-node strict execution E2E；
8. 再进入 Effect/Authorization。

---

## 合并判定

当前：

```text
CI                     ✅
Unit tests             ✅
Typecheck              ✅
Build                  ✅
Real Chromium E2E      ✅
No base conflicts      ✅
Architecture docs      ✅
Invariants review      ✅
Known merge blockers   0
```

因此 PR #1 可以从 Draft 转为 Ready for review，并合并到 `main`。
