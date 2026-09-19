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
PR #2 Final Invariants Review            ✅
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

## 本轮安全加固

- active authorization id 禁止被同名 grant 静默覆盖；
- 过期 grant ID 可以重新使用；
- trusted RPC token/state path 拒绝 symlink；
- token file 校验当前用户 ownership；
- Native Messaging 写失败立即返回失败，不再伪装成功等待 timeout。

## 下一步

1. 对 PR #2 做最终 Invariants 对抗式 Review；
2. 收口 PR #2 文档与安装说明；
3. CI/E2E 全绿后判断是否可合并。

## 合并状态

PR #2 最终 Review 已完成；等待最新 HEAD CI/E2E 全绿后即可合并。

## 信任边界修订

- Native Host token 被明确定义为 control-plane authentication；
- 它不自动等价于人工批准；
- 如果 Coding Agent 本身拥有同 UID 任意文件读取 + localhost 网络权限，不能把 0600 token 当成对该 Agent 的 OS 级 hard boundary；
- 高风险生产部署应使用 Agent 无法访问的 operator/enterprise authorization boundary。
