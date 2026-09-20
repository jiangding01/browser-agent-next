# 安全模型与信任边界

最后更新：2026-09-20

## 目标

Browser Agent Next 的安全目标不是“模型永远不会犯错”，而是把模型、页面内容和真实浏览器副作用分层隔开：

Page / Model Decision → Stored Observation → Strong Identity → Policy → Trusted Authorization → Second Strict Prepare → Browser Input → Independent Verify

页面文本、Prompt、AX name、DOM label、模型 confidence 都不能直接获得执行权限。

## 当前可以防御的威胁

- 页面 Prompt Injection 诱导模型点击错误对象；
- stale ref / same-looking replacement；
- DOM/AX semantic similarity 被误当 identity；
- observation 后导航或 frame lifecycle 变化；
- target 被遮挡、禁用、离开 viewport；
- unknown-effect click 在没有 trusted grant 时直接执行；
- grant 被挪用到其它 tab/revision/ref/action/effect；
- grant 跨 navigation 存活；
- dispatch 后 outcome ambiguous 时自动 retry；
- verify inconclusive 时重放 non-idempotent action；
- DNS rebinding 风格 Host header；
- token symlink / 非当前用户 ownership；
- Native Messaging 半帧后继续发送导致协议失步。

## Trusted Native Host 的真实语义

当前 Native Host + localhost Bearer token 提供的是“控制平面身份验证（control-plane authentication）”。

它可以证明请求来自一个能够读取 trusted token 的本地进程，但不能在所有部署场景中自动等价为人工批准或 OS 级硬隔离。

特别是，如果 Claude Code / Coding Agent 拥有与用户相同的任意文件读取 + localhost 网络权限，那么该 Agent 理论上也可能读取 ~/.browser-agent-next/trusted-rpc.token 并直接调用 trusted RPC。

因此，同 UID、拥有任意本地代码/文件能力的 Agent，不属于当前 token 能单独隔离的对象。

当前 token 可以隔离普通网页、页面 JS、Extension 普通 runtime message，以及不具备本地 token 访问权的模型/Agent；但不能单靠一个 0600 文件隔离已经拥有同用户任意 shell/filesystem 权限的 Coding Agent。

## 部署要求

受限 Browser Agent 场景中，如果模型只能通过受限 MCP / Browser Runtime 使用浏览器，不能任意读取本地 token，则 trusted-host grant 可以作为有效的控制平面授权。

如果 Agent 拥有同 UID shell/filesystem，推荐把授权控制平面放到 Agent 无法访问的边界外，例如独立 OS 用户、独立桌面审批进程、企业权限服务、人工确认 UI 或宿主提供的 capability-based authorization。

在这些模式完成前，不应声称当前 token 是“对任意本地 Coding Agent 的 hard authorization”。

## Auto-act Origin Policy

Auto-act allowlist 默认空，只支持 http/https，配置项必须是纯 origin，不允许 wildcard、suffix、path、query、fragment 或 credentials。

这样可以避免调用方误以为自己只授权了一个 path，实际上 Runtime 却扩大到了整个 origin。

## Unknown Effect

Generic click 默认 effect=unknown、confidence=unknown。

Trusted grant 的存在只表示允许对该精确 target 尝试这个动作；它不会把 unknown 重新标成 known-safe。

## Ambiguous Outcome

一旦 mousePressed 已成功，后续 transport error 必须视为 ACTION_OUTCOME_UNKNOWN。此时禁止自动 retry click，只允许重新 Observe → Verify → 由上层决定下一步。

## Authorization Assurance

当前已实现 `control-plane`、`operator-approved`、`enterprise-policy` 三个 assurance 层级，并按 Effect Class 校验最低 assurance。Trusted Native Host 只能签发 `control-plane`；operator-approved 与 enterprise-policy 仍需要各自独立的受信签发入口。

## Tab Ownership

Tab ownership 是 Policy 输入，因此属于安全属性。

当前唯一可以 mint `ownedBySession=true` 的路径是：

```text
trusted browser.open
→ chrome.tabs.create
→ valid tabId
→ TabOwnershipRegistry.markCreated
```

普通 `runtime.onMessage` 的 perception 请求不能携带 `ownedBySession`。即使请求来自 Extension 自己的页面/上下文，也不能通过该字段把用户已有 Tab 提升成 Agent-owned。

MV3 service worker restart 后 registry 丢失，旧 Tab 会安全降级为 user-existing，而不是猜测恢复 ownership。
