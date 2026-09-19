# PR #2 最终对抗式审查

审查日期：2026-09-19

## 结论

PR #2 已达到“main-frame Hybrid Perception + Strict Click Execution + Trusted Control Plane”阶段的合并门槛。

在当前明确的威胁模型和功能边界内，本轮审查未发现需要阻止合并的未解决 design blocker。

这不表示 Browser Agent 已经完成，也不表示任意网页都可以无人值守自动执行。当前真实执行能力仍然严格受以下边界限制：

- 仅 main-frame；
- 仅 linked DOM+AX strong identity；
- 仅 click；
- generic click effect 默认 unknown；
- 必须 exact-origin allowlist；
- 必须 trusted control-plane grant；
- dispatch 前必须 second Strict Prepare；
- 结果必须 fresh Observe + Verify；
- child frame / DOM-only / AX-only target fail closed。

## 本轮确认的关键安全属性

### 1. DOM 与 AX 只通过 browser-level strong correspondence 合并

role、name、text、geometry 相同都不能证明是同一对象。

当前 main-frame correspondence 使用：backendDOMNodeId → DOM.resolveNode(executionContextId) → isolated-world live Element → stableId。

### 2. Stored Observation 是 Strict Action 的可信 expected source

调用方只传 observedRevision + ref。expected role/name/capability 不由模型提供。

### 3. Same-looking replacement 在授权后仍被拒绝

真实 Chromium E2E 已覆盖：先观察并授权 Save，再用 cloneNode 替换成视觉/语义相同的新节点，旧 revision/ref/grant 执行时必须返回 TARGET_IDENTITY_MISMATCH，且页面不发生导航。

只有重新 Observe 得到新 ref，并针对新 revision/ref 重新签发授权后才能执行。

### 4. Policy 与 Identity 是两道独立门

授权存在不跳过 Strict Prepare；Strict Prepare 通过也不跳过 Effect/Origin/Authorization Policy。

### 5. Generic click effect 保持 unknown

trusted grant 只代表允许尝试该精确动作，不把 unknown 重新标记成 known-safe。

### 6. Grant 精确绑定且默认一次性

绑定维度：tab + observedRevision + ref + actionKind + effectClass。

active authorization id 不能被同名新 grant 静默覆盖；navigation/tab removal 会撤销相关 grant。

### 7. Dispatch 前执行第二次 Strict Prepare

第一次 prepare 得到的 point 不跨 policy/authorization 时间窗口复用。

### 8. Ambiguous outcome 禁止自动重放

mousePressed 后发生 transport error 会升级为 ACTION_OUTCOME_UNKNOWN。允许重新 Observe/Verify，不允许自动 retry click。

### 9. Verify 使用三值语义

verified / conclusively failed / inconclusive 被区分。partial/truncated/unknown coverage 不会被误判为“目标不存在”。

### 10. Trusted Host 与普通 Runtime ingress 分离

普通 extension runtime message 只暴露 observe/prepare 等非授权能力；grant issue 与真实 dispatch 只在指定 Native Messaging host 通道。

### 11. Local trusted RPC 做了边界收紧

- loopback only；
- Bearer token；
- Host header 防 DNS rebinding；
- request body 上限；
- token/state path 禁止 symlink；
- token 校验当前用户 ownership；
- auto-act 配置只接受纯 origin；
- Native Messaging 半帧风险 fail closed。

## 重要威胁模型修订

当前 Native Host token 是 control-plane authentication，不自动等价于“人工批准”。

如果同一个 Coding Agent 已经拥有同 UID 任意 filesystem + localhost network 权限，则它理论上也可能读取 token 并调用 trusted RPC。因此不能声称当前 0600 token 是对这种 Agent 的 OS 级 hard boundary。

该限制已经写入 docs/SECURITY.md，并视为明确的部署约束，而不是隐藏假设。

## 非 blocker 的已知限制

- child-frame webNavigation ↔ CDP FrameId exact mapping 尚未实现；
- strict execution 暂不支持 child frame；
- Hybrid perception 仍是显式 includeAx profile，而非全局默认；
- component adapter 尚未实现；
- Windows Native Messaging 安装器尚未实现；
- operator-approved / enterprise-policy assurance 层级尚未实现；
- browser.extract / event-driven wait / Jev / WebMCP / Vision 均属于后续阶段。

这些能力缺失时当前实现选择 fail closed，不影响本 PR 已实现路径的正确性。

## 合并判定

需要满足：

- typecheck 通过；
- unit tests 通过；
- build 通过；
- real Chromium lifecycle E2E 通过；
- trusted execution E2E 通过；
- same-looking replacement adversarial E2E 通过；
- main 无冲突；
- 最新安全边界文档已同步。

当最新 HEAD CI 全绿时，PR #2 可以从 Draft 切换为 Ready for review 并合并。

## 合并后建议

下一阶段建议单独新开 PR，不继续扩大 PR #2：

1. child-frame CDP exact mapping；
2. Hybrid observation profile 策略；
3. Authorization Assurance（control-plane / operator / enterprise）；
4. 高层 browser.observe / act / verify API；
5. 然后再进入 Jev Shadow / FastStep。
