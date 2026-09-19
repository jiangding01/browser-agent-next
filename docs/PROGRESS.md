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

## 本轮完成

真实 MV3 Extension packaging 已落地：

- `manifest.json`；
- production content entry；
- production background service-worker entry；
- esbuild bundle；
- Chrome 106 minimum version；
- background `perception.observe-tab` typed internal endpoint；
- Content listener；
- Background listener；
- Chrome `documentId` 定向 frame messaging；
- webNavigation lifecycle binding。

现在代码已经能打出可加载 Chrome 的扩展，而不只是 transport-neutral library。

## 当前真实链路

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
Persistent Ref
        ↓
BrowserObservation
        ↓
StateStore / Delta
```

## 安全边界

- 页面本身没有 external messaging 入口；
- background 只接收本扩展 sender；
- read path 使用 Chrome documentId 避免 frame navigation race；
- 密码 value 永不采集；
- includeValues 默认关闭；
- 仍然没有 actuation。

## 下一步

1. 加 Playwright real Chromium extension E2E。
2. 覆盖：
   - same node → same ref；
   - same-looking replacement → new ref；
   - main reload → old ref invalid；
   - child reload → 只 invalid child；
   - inaccessible frame → coverage.partial。
3. E2E 全绿后做 Invariants 最后一轮对抗式 Review。
4. 再决定 PR #1 是否可以合并。

## 合并状态

**现在仍不要合并 PR #1。**
