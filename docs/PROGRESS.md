# 实现进度

最后更新：2026-09-19

## 当前分支

```text
feat/bootstrap-runtime-foundation
```

PR #1 继续保持 Draft。

## 当前阶段

```text
Phase 0 Foundation        基本完成
Phase 1 Perception IR     接近收口
```

## 最新完成

在 MV3 打包和 Chrome document-targeted transport 基础上，补齐了一个重要 identity 生命周期缺口：

- 同文档 complete observation 中，如果旧 actionable ref 不再出现，会被 tombstone；
- replacement node 即使 role/name 完全相同，也会获得新 ref；
- partial/truncated/unknown observation 不会因为“没看到”就错误 tombstone 旧 ref；
- 对应规则已经写入 `docs/INVARIANTS.md`。

这保证了：

```text
旧 Save button A
↓ DOM replacement
新 Save button B
↓
A ref tombstone
B gets new ref
```

而不是留下两个都 active 的“保存”身份。

## 当前真实 Chrome 链路

```text
runtime.sendMessage(perception.observe-tab)
        ↓
MV3 background
        ↓
webNavigation.getAllFrames
        ↓
documentId-targeted tabs.sendMessage
        ↓
all-frame content script
        ↓
DOM perception
        ↓
Persistent Ref / tombstone reconcile
        ↓
BrowserObservation / Delta
```

## 下一步

1. 增加 Playwright real Chromium extension E2E。
2. 覆盖 same node、replacement、main reload、child reload。
3. 尝试构造真实 inaccessible-frame fixture；若浏览器环境无法稳定构造，则保留 unit/integration fail-visible gate 并记录原因。
4. E2E 全绿后做最后一轮 Invariants 对抗式 Review。
5. 再决定 PR #1 是否可以合并。

## 合并状态

**现在仍不要合并 PR #1。**
