# 实现进度

最后更新：2026-09-19

## 当前分支

`feat/bootstrap-runtime-foundation`

PR #1 继续保持 Draft。

## 当前阶段

Phase 0 Foundation：基本完成。  
Phase 1 Perception IR：合并前对抗式收口。

## Real Chromium E2E

CI #19 已通过真实 Chromium + MV3 Extension 生命周期 E2E：

- same live node → same ref；
- same-looking replacement node → new ref；
- child frame reload → main ref 保持、child ref 变化；
- main document reload → document epoch 和 refs 变化。

## 本轮对抗式 Review 新发现并修正

1. Canonical forms coverage 之前被固定成 0；现在按合并后的 field 实际计数。
2. documentId-targeted request 仍存在“旧文档刚返回、随后立即导航”的窄竞态；现在采集后、提交状态前重新校验完整 frame/document catalog。
3. BrowserObservation URL 改为与 documentId 同源的 main-frame URL，避免 tabs.get 与 frame catalog 来自不同导航时刻。
4. 明确 MV3 service-worker restart 语义：裸 ref 不跨 stateEpoch 构成权威身份，Strict Action 必须绑定仍存在的 observedRevision。
5. 明确 coverage.complete 是 observation profile 的完整性，不等价于发现网页所有隐式交互区域。

## 合并状态

本轮修正后的完整 CI（含 browser-e2e）再次全绿后，再完成 PR 描述/文档最终收口；在此之前仍不要合并 PR #1。
