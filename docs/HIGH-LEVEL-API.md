# High-level Browser API

最后更新：2026-09-20

## 目标

把底层 Perception、Persistent Ref、Strict Executor、Policy、Verification 组合成 Agent 可以稳定调用的少量高层原语。

当前 trusted RPC 已暴露：

```text
browser.observe
browser.verify
browser.wait
browser.act
```

## browser.observe

默认 profile 为 `hybrid`：DOM + AX exact correspondence。

请求只接受：

- tabId；
- sinceRevision；
- profile；
- bounded maxElements / maxAxElements；
- includeValues；
- includeOpenShadowRoots。

高层 API **不接受 `ownedBySession`**。

在独立 Tab Ownership Registry 完成之前，高层 API 统一把目标视为 user-existing tab：

```text
ownedBySession = false
```

这是安全默认，避免 Agent 自己声称“这个 Tab 是我创建的”从而降低 Policy 门槛。因此当前由高层 browser.observe 得到的 user-existing observation，generic unknown click 不能只靠 control-plane grant 执行；需要后续 operator-approved issuance 或可信 Tab Ownership Registry。

单次高层 observation 当前最多请求 500 个 DOM/AX candidate。更大的页面通过 coverage=truncated 明确暴露不完整性，而不是冒险让 Native Messaging 返回超大状态。后续如需更大 action space，应优先增加 scoped/paged observation。

## browser.verify

`browser.verify` 只针对指定 retained revision 做 deterministic verification。

```text
tabId + observedRevision + VerificationSpec
```

它不会偷偷重新观察页面，因此：

- 适合验证某个已知 BrowserState；
- 不等价于 fresh live proof；
- revision 已淘汰时返回 OBSERVATION_EXPIRED。

## browser.wait

当前实现是 **bounded fresh-observation wait baseline**：

```text
Observe fresh state
→ Verify
→ 未满足则等待
→ 再 Observe
```

它不会执行任何 action，也不会因为条件没满足而重放动作。

当前仍是有界 polling，真正的 event-driven mutation/navigation wake-up 留到后续优化。因此 Roadmap 中“event-driven wait”尚未完成。

## browser.act

第一版只支持当前已经经过真实 Chromium 对抗测试的：

```text
strict click
```

必须提供：

```text
actionId
observedRevision
ref
authorizationId
VerificationSpec
```

内部映射到现有：

```text
Stored Observation
→ Strict Prepare
→ Effect / Origin / Assurance Policy
→ consume exact-bound grant
→ Second Strict Prepare
→ CDP dispatch
→ Fresh Observe
→ Verify
```

非 click action 当前返回 ACTION_NOT_SUPPORTED，而不是降级到 compatible execution。

## 兼容接口

旧的：

- `authorization.issue-strict-click`
- `execution.execute-strict-click`

暂时保留，用于兼容和底层测试。新 Agent 接入应优先面向 `browser.*`。

## 当前未完成

- browser.extract；
- event-driven wait；
- Tab Ownership Registry；
- operator-approved / enterprise-policy issuance ingress；
- child-frame Strict Click；
- OOPIF exact session mapping。
