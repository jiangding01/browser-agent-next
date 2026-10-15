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

### 配置文件来源

Native host 在每次启动（即扩展连接）时读取 `~/.browser-agent-next/autoact-origins.json`，并在 trusted RPC 开始监听之前通过 `policy.replace-autoact-origins` 整体下发给扩展。格式固定为 `{"version":1,"origins":[...]}`，最多 100 项，每项必须是纯 origin。

- 文件必须是当前用户拥有、非 symlink、不可被组或其他用户写入的普通文件，大小不超过 64 KiB；所在目录要求与 trusted token 目录相同。origins 不是机密，因此不强制 `0600`。
- 任一条目非法、或文件校验失败时，整份文件作废，不做部分应用。
- 文件缺失、非法或下发失败时，native host 只在 stderr 记录原因并继续启动，不下发任何内容，扩展 allowlist 保持为空，act 全部被拒绝（fail closed）。日志不得包含 origin 列表，且绝不能写入 stdout（Native Messaging 协议通道）。
- allowlist 只存在于扩展内存。运行期间通过 RPC replace 的结果会在下一次 native host 重连时被配置文件内容覆盖；没有配置文件时则重置为空。

## Unknown Effect

Generic click 默认 effect=unknown、confidence=unknown。

Trusted grant 的存在只表示允许对该精确 target 尝试这个动作；它不会把 unknown 重新标成 known-safe。

## Ambiguous Outcome

mousePressed 请求发出后发生的任何 transport error 都必须视为 ACTION_OUTCOME_UNKNOWN，因为浏览器可能已执行输入但响应丢失。此时禁止自动 retry click，只允许重新 Observe → Verify → 由上层决定下一步。

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


## Operator approval UI boundary

`operator-approved` 的 baseline 由专用 Extension action popup 提供人工审批路径。

background 只接受 sender 同时满足：

```text
sender.id  == current extension id
sender.url == chrome-extension://<id>/operator-approval.html
```

control-plane/native-host 只能创建 pending request 和读取状态，不能调用 approve。批准按钮触发后，pending request 会被单次消费，并在真正签发前重新验证 retained observation、ref、origin 与 assurance requirement。

这个边界表示“来自受信扩展审批 UI 的明确批准路径”，仍不应被描述成对拥有同 UID 任意桌面自动化、调试器或扩展代码修改能力的攻击者提供 OS 级硬隔离。更强部署仍应使用独立 OS 用户、宿主审批进程或企业策略服务。


## Enterprise authorization proof boundary

`enterprise-policy` assurance 只能由经过受管公钥验证的签名 assertion 进入。

公钥来自 `chrome.storage.managed`，该区域由企业管理员下发且扩展侧只读；实现会进一步把 managed storage access level 限制为 `TRUSTED_CONTEXTS`。企业 assertion 使用 ECDSA P-256/SHA-256，并精确绑定 target/revision/origin/TTL 与 action/effect。

control-plane/native-host 只是 relay，不能：

- 自报 `source=enterprise-policy`；
- 自报 `assurance=enterprise-policy`；
- 提供任意验证公钥；
- 修改已签名的 ref/revision/origin/TTL；
- replay 已消费 assertion。

assertion replay ledger 存在 `storage.local` 并同样限制到 trusted contexts，因此 MV3 service-worker restart 不会清掉 replay 记录。持久化失败时 enterprise issuance fail closed。

这条边界的安全性依赖企业私钥在扩展之外安全保存。扩展只持有公开验证 key，不具备企业 assertion 的签名能力。


### Replay ledger capacity

Persistent enterprise replay state 采用 fail-closed capacity policy：

- 先清理已过期 assertion id；
- 未过期记录绝不因容量压力被淘汰；
- ledger 满时拒绝新的 enterprise issuance；
- storage 读取、结构校验或持久化失败时同样拒绝 issuance。

这样避免通过大量合法签名 assertion 挤出旧 replay marker 后重新使用旧 assertion。
