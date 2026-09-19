# 实现进度

最后更新：2026-09-19

## 当前分支

```text
feat/hybrid-perception-strict-executor
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception       ✅ 已合并
Hybrid Perception                        ✅ main-frame exact correspondence
Strict Prepare                           ✅ Real Chromium E2E
Policy-gated Dispatch                    ✅
Exact Origin Policy                      ✅
Authorization Lifecycle Revocation       ✅
Trusted Native Host Ingress              ✅
Execute → Fresh Observe → Verify         ✅
Adversarial Replacement Execution E2E    ✅ 新增
PR #2 Final Invariants Review            ⏭
```

## 本轮新增

- 强化真实 Chromium trusted-execution E2E；
- 在 trusted grant 签发后，将目标替换成 role/name 完全相同的新 DOM node；
- 使用旧 `observedRevision + ref + authorization` 执行时必须返回：
  `TARGET_IDENTITY_MISMATCH`；
- replacement 不得触发点击，也不得发生导航；
- fresh observation 必须为 replacement 分配新 ref；
- 只有针对新 revision/ref 重新签发授权后，Strict Click 才能真实 dispatch；
- dispatch 后继续使用 fresh observation 独立 Verify URL。

## 当前执行闭环

```text
Trusted Host
  ↓ exact-origin policy
Issue one-time grant
  ↓
observedRevision + ref + click + unknown-effect
  ↓
Strict prepare
  ↓
consume exact-bound grant
  ↓
Strict prepare again
  ↓
CDP mouse dispatch
  ↓
fresh BrowserObservation
  ↓
deterministic Verification
```

任何 identity / document / semantic / actionability / hit-test 变化都会在 dispatch 前 fail closed。

## 下一步

1. 对 PR #2 做最终 Invariants 对抗式 Review；
2. 检查 trusted RPC / native-host 安装与失败模式；
3. 收口 PR #2 文档；
4. CI/E2E 全绿后判断是否可合并。

## 合并状态

PR #2 继续保持 Draft；完成最终 Review 前不要合并。
