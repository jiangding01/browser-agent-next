# 实现进度

最后更新：2026-09-19

## 当前分支

```text
feat/hybrid-perception-strict-executor
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception       ✅ 已合并
AX Perception                            ✅ main-frame 基线
AX → canonical pipeline                 ✅ opt-in
DOM ↔ AX Exact Correspondence           ✅ 代码链路完成
Hybrid BrowserState E2E                 🚧 下一步
Stored Observation Strict Executor      ⏭
```

## 本轮新增

- isolated-world DOM identity bridge；
- `WeakMap<Element, stableId>` 增加反向 WeakRef 查找；
- Chrome Debugger transport 跟踪 Runtime execution context；
- 使用 `DOM.resolveNode(backendDOMNodeId, executionContextId)` 获取同一个 live Element；
- bridge 用对象身份返回已存在的 stableId；
- DOM/AX 只有在 exact bridge 成功时生成相同 mergeKey；
- canonical assembler 因此可以绑定 DOM + AX strong identities 到同一 Persistent Ref；
- element/field 分类在 exact identity merge 时收敛为更具体的 field。

## 明确未使用

- role/name 相似度；
- geometry overlap；
- nth/index；
- CSS selector re-find；
- 临时 data-* attribute。

## 下一步

1. Real Chromium isolated-world correspondence E2E；
2. main-frame Hybrid BrowserState 默认化；
3. child-frame CDP mapping；
4. Stored Observation Strict Executor；
5. fresh viewport + hit-test。

## 合并状态

PR #2 仍为 Draft，当前不要合并。
