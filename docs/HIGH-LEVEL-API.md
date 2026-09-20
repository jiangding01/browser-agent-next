# High-level Browser API

最后更新：2026-09-20

## 目标

把底层 Perception、Persistent Ref、Strict Executor、Policy、Verification 组合成 Agent 可以稳定调用的少量高层原语。

当前 trusted RPC 已暴露：

```text
browser.open
browser.observe
browser.extract
browser.verify
browser.wait
browser.act
```

## browser.open

`browser.open` 是当前唯一可以 mint Agent-owned Tab 的高层入口。

它只接受：

- absolute http/https URL；
- 无 URL credentials；
- 有界 URL 长度。

调用成功后，Runtime 仅根据真实 `chrome.tabs.create` 返回的 tabId 写入 Tab Ownership Registry。

返回的 `requestedUrl` 只表示创建请求的目标 URL，不表示页面已经完成导航，也不表示最终 committed URL。实际 URL 必须通过后续 `browser.observe` 获取。

调用方不能通过 `ownedBySession=true`、`claim(tabId)` 等方式提升已有 Tab 的 ownership。

MV3 service worker 重启后 ownership registry 丢失时，已有 Tab 自动安全降级为 user-existing。

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

ownership 来自 Tab Ownership Registry，而不是请求字段：

- `browser.open` 创建的 Tab：`ownedBySession=true`；
- 未记录的 Tab：`ownedBySession=false`；
- MV3 restart 后无法证明 ownership 的 Tab：`ownedBySession=false`。

因此用户已有 Tab 的 generic unknown click 不能只靠 control-plane grant 执行；而 Runtime 自己通过 `browser.open` 创建的 Tab，可以沿用 control-plane baseline。

单次高层 observation 当前最多请求 500 个 DOM/AX candidate。更大的页面通过 coverage=truncated 明确暴露不完整性，而不是冒险让 Native Messaging 返回超大状态。后续如需更大 action space，应优先增加 scoped/paged observation。

## browser.extract

`browser.extract` 只读取指定 retained BrowserObservation。

它不会：

- 接收 CSS/XPath selector；
- 执行 caller supplied JavaScript；
- 绕过 observation profile 去重新扫描 live DOM。

可选 `refs` 与 `maxItems` 都有严格上限，并返回：

- items；
- missingRefs；
- truncated；
- totalMatched；
- actionableCoverage。

因此 missing ref 本身不是“页面中确定不存在”的证明；是否可证明 absence 仍取决于原 observation coverage。

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

- event-driven wait；
- operator-approved / enterprise-policy issuance ingress；
- child-frame Strict Click；
- OOPIF exact session mapping。
