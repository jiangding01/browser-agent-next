# 实现进度

最后更新：2026-09-19

## 当前分支

```text
feat/hybrid-perception-strict-executor
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception       ✅ 已合并
AX Perception                            🚧 开始实现
DOM ↔ AX Strong Correspondence          ⏭ 下一步
Hybrid BrowserState                     ⏭
Stored Observation Strict Executor      ⏭
```

## 本轮新增

- 新建下一阶段开发分支；
- Manifest 增加 Chrome `debugger` permission；
- 新增最小化的只读 `ChromeDebuggerReadTransport`；
- 新增 main-frame live AX source；
- AX strong identity 使用：
  `tabId + cdpFrameId + documentEpoch + backendDOMNodeId`；
- AX actionable coverage / truncation 显式建模；
- 未引入 role/name/geometry 猜测式 DOM↔AX merge。

## 当前边界

AX source 暂时只覆盖 main frame。

原因是：

`webNavigation.frameId` 与 CDP `Page.FrameId` 不属于同一个命名空间。

在建立可靠映射前，不会通过 URL 或顺序猜 child frame 对应关系。

## 下一步

1. AX source 接入 canonical observation pipeline；
2. 设计 exact DOM stableId → backendDOMNodeId bridge；
3. main-frame Hybrid BrowserState；
4. child frame CDP mapping；
5. stored-observation Strict Executor coordinator。

## 合并状态

当前为新阶段早期开发，**不需要合并**。
