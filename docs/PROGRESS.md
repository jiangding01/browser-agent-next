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
Phase 1 Perception IR     浏览器 E2E 门禁接入中
```

## 本轮新增

新增真实 Chromium + MV3 Extension 的 Playwright E2E 门禁。

测试加载的是正式构建产物：

```text
apps/extension/dist
```

而不是 fake transport。

首批 browser lifecycle 用例覆盖：

1. 同一个 live DOM node 重复 observation → ref 不变；
2. 同文案 replacement node → ref 必须变化；
3. child frame reload → child ref 变化、main ref 保持；
4. main document reload → document epoch 和 refs 都变化。

CI 新增独立 `browser-e2e` job，只有 unit/type/build 全绿后才运行。

## 说明

本提交只是把 browser E2E gate 接入仓库；只有 GitHub CI 实际跑绿后，Roadmap 才会把 lifecycle E2E 标为完成。

## 合并状态

**现在仍不要合并 PR #1。**

等待 real Chromium E2E 实际跑绿，然后做最后一轮 Invariants 对抗式 Review。
