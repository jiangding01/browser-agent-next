# Model-facing Adapter Boundary

更新日期：2026-10-16

## 目标

PR #5 的目标不是“给 trusted RPC 套一层 MCP”，而是建立一个独立的模型信任边界：

```text
LLM / Agent
    ↓
Model-facing MCP Adapter
    ├─ explicit tool exposure allowlist
    ├─ model navigation policy
    ├─ model read / egress policy
    ├─ model act origin policy（side-effect tier，默认不暴露）
    ├─ bounded input validation
    ├─ model-visible observation store
    └─ Act broker（预算 / 单次执行账本 / 授权路径）
    ↓
High-level Browser Runtime
    ↓
Trusted control plane
```

模型层与 trusted control plane 的权限不是同一个集合。

## 工具目录

默认目录只包含 read / navigation tier 的五个工具：

```text
browser.open
browser.observe
browser.extract
browser.verify
browser.wait
```

`browser.act` 是目录中唯一的 side-effect tier 工具：

```text
browser.act                         side-effect tier，默认不暴露，需写进 MODEL_TOOLS
```

`MODEL_FACING_DEFAULT_TOOL_NAMES` 由全量工具名过滤掉 side-effect tier 得到。未设置 `BROWSER_AGENT_NEXT_MODEL_TOOLS` 时使用该默认集合；显式设置后列表完全替换默认值，因此要启用 `browser.act`，必须把它连同其它需要的工具一起写进 `MODEL_TOOLS`。

明确不包含：

```text
policy.replace-autoact-origins      禁止
authorization.issue-*              禁止
authorization.request-operator-approval / operator-approval-status / cancel-strict-click   禁止（仅 broker 内部使用）
execution.execute-strict-click      禁止
raw CDP                             禁止
任意 trusted-host internal RPC      禁止
```

`browser.act` 的 fail closed 依据：Runtime 的 Strict Click 需要 authorizationId，而模型不能直接获得 authorization issuance 能力。因此它只能经过 MCP 进程内的 scoped Act broker 暴露：模型只能提出“点击某个已出境 ref”，授权 id、action id 与授权路径都由 broker 生成（见下文「Act broker」）。

## 四个独立 policy plane

必须区分：

```text
Model Read / Egress Policy
Model Navigation Policy
Model Act Origin Policy
Runtime Auto-act Policy
```

四者不能互相推导。

例如：

- 模型可以读取 `https://docs.example`，不等于允许自动点击产生副作用；
- 模型可以被允许导航到某 origin，也不等于该 origin 的页面内容可以直接出境给模型；
- Runtime auto-act allowlist 不能被当作 model read allowlist 使用；
- Model act origin 决定“模型是否可以提出对该 origin 的点击请求”，它不等价于扩展侧 Runtime auto-act allowlist，后者仍由扩展独立校验。

Model act origin 有一条额外约束：必须是 read origin 的子集。模型不能对自己读不到的 origin 发起动作；配置时如果 act origin 不在 read origin 内，MCP 进程启动失败（fail closed）。act origin 默认为空，因此即使 `browser.act` 被暴露，在 operator 显式配置 act origin 之前所有调用都会以 `ORIGIN_NOT_ALLOWED` 被拒绝。

当前 read/navigation/act policy 都采用 exact-origin allowlist；配置只接受纯 http/https origin，不做 wildcard、suffix 或字符串包含匹配。

## 最小 Runtime surface

adapter 自身只依赖 trusted Runtime 的两个原语：

```text
browser.open
browser.observe
```

`browser.act` 所需的 trusted 方法不在 adapter 的 runtime client 类型里，而是只注入给 Act broker（见下文）。

以下模型工具不直接转发 trusted RPC：

```text
browser.extract
browser.verify
browser.wait
```

它们在 **已经通过 model-egress projection 的 observation** 上本地执行。

这样可以避免：

1. 模型拿内部 retained revision 做 extract；
2. 模型通过 verify 的 true/false 对未出境数据做 boolean probing；
3. wait 在隐藏 cross-origin frame 的内容上提前满足条件；
4. MCP adapter 因为“方便”而逐渐变成 trusted RPC passthrough。

## Model-visible revision store

只有成功通过 model-egress policy 的 observation 才会进入 adapter 自己的有界 revision store。

```text
Runtime Observation
      ↓
Origin / Frame Egress Check
      ↓
Projection / Redaction
      ↓
Model-visible Revision Store
      ↓
Model
```

因此：

- `sinceRevision` 必须引用已对该模型出境的 revision；
- `browser.extract` 只能读取 model-visible revision；
- `browser.verify` 只能验证 model-visible revision；
- adapter restart 后 store 丢失时安全降级，模型需要重新 observe，而不是猜测恢复内部状态。

store 当前默认最多保留 64 个 projected revisions，配置上限 512。

## Egress projection

默认策略：

- `value.display` 不出境；
- 即使模型请求 `includeValues=true`，如果 trusted egress policy 没开启 values，也会在 Runtime 采集前强制为 false；
- page-declared capabilities 暂不出境，等待 Phase 8 WebMCP/capability policy；
- runtime delta 暂不直接出境；
- 单次 observation 默认最多 100 elements，trusted 配置最大 500。

### Cross-origin child frame

Top-level origin 未被 read policy 允许时，整个 observation fail closed。

child frame 单独判断：

- allowlisted http/https origin → 可出境；
- `about:blank` / `about:srcdoc` → 继承 parent frame 的 egress 决策；
- 未 allowlist / 无法证明来源 → frame URL 与 frame content 不出境。

发生过滤后：

```text
coverage.actionable → partial
coverage.forms      → partial
coverage.text       → partial
```

并把对应 frame 标成 `model-egress-origin-blocked`。

这是为了继续维持核心语义：

```text
模型没看到 ≠ 页面不存在
```

## Verification

`browser.verify` 使用共享 `verifyObservation()`，但输入是 projected observation。

Verification evidence 中的 `observed` 字段在返回模型前被移除，避免把 field value、URL/title 等观测值通过 evidence 二次泄露。

默认 values 被移除后，对 `field_value` 的验证会变成 inconclusive，而不会去 Runtime 原始 observation 上查询真实值。

## Wait

第一阶段 model-facing `browser.wait` 使用：

```text
Fresh Runtime Observe
      ↓
Model Egress Projection
      ↓
Verify Projected Observation
      ↓
Bounded Poll / Retry
```

它暂时不直接调用 trusted Runtime 的 event-assisted `browser.wait`，原因是 Runtime verification 可以看到完整 observation，而模型只能看到 projected observation。直接转发会重新引入 hidden-frame boolean side channel。

后续如果要恢复 event-assisted wake-up，应只把无页面内容的 change signal 作为 pacing hint 提供给 model adapter；最终 correctness 仍必须基于 projected Fresh Observe + Verify。

## MCP Tool Catalog

当前 catalog 为六个 model-facing tool 提供显式 JSON Schema，其中 `browser.act` 属于 side-effect tier、默认不暴露：

```text
browser.open
browser.observe
browser.extract
browser.verify
browser.wait
browser.act      （side-effect，需显式写进 MODEL_TOOLS）
```

Schema 与 runtime validator 共用 `MODEL_INPUT_LIMITS`，包括 element count、refs、verification conditions、timeout 与 polling interval 上限。所有可识别 object 默认 `additionalProperties: false`，避免 MCP client 通过额外字段注入内部语义。

`field_value.equals` 的 JSON Schema 对字符串长度、数组/对象规模和递归深度做有界约束；runtime validator 仍保留额外的全局 100-node budget，作为 schema 之外的第二道资源边界。

Tool definitions 会被深度冻结，并且 `createModelFacingMcpToolCatalog()` 仍需通过 `ModelToolExposurePolicy` 过滤。未来新增 trusted RPC 不会自动注册为 MCP tool。

`browser.act` 的 schema 只有 `tabId`、`observedRevision`、`ref`、`kind`（固定 `"click"`）、`verification` 与可选的 `verifyTimeoutMs`（0..5000），`additionalProperties: false`。`authorizationId`、`actionId`、`assurance`、`source` 等字段不在 schema 里，运行时校验也会拒绝任何多余键。

## MCP Stdio Transport

当前使用官方 MCP TypeScript SDK v2 的低层 `Server` 与 `serveStdio(factory)`。

选择低层 `Server` 是有意的：本项目已经拥有独立 JSON Schema catalog 和 runtime validator，并且需要自己控制 tool dispatch。这样不用再维护第二份 Zod schema，也不会让 SDK registration API 变成新的安全策略来源。

```text
serveStdio
  ↓ connection factory
create Model-facing Invoker
  ↓
createModelFacingMcpServer
  ↓
tools/list ← frozen filtered catalog
tools/call ← ModelFacingMcpBridge
  ↓
ModelFacingBrowserAdapter
```

每个 stdio connection 必须在 factory 内创建新的 invoker/adapter，model-visible revision store 不能跨连接共享。

工具结果只通过 JSON text content 返回，并受结果字节数上限约束。Runtime error 仅允许 code/message 出境，`details`、stack 和未知异常原文不进入模型。

该 server/transport seam 已与 `TrustedRuntimeHttpClient` 组装为可执行的本地 MCP 进程；默认模型目录仍只包含 `browser.open`、`browser.observe`、`browser.extract`、`browser.verify`、`browser.wait`，`browser.act` 只有 operator 显式配置后才会出现在 `tools/list`。

## Trusted Runtime Client

Model-facing adapter 到 trusted control plane 之间新增最小 `TrustedRuntimeHttpClient`：

```text
ModelFacingBrowserAdapter          Act broker（仅当暴露 browser.act）
      ↓                                  ↓
TrustedRuntimeHttpClient（同一实例）
      ├─ browser.open                 ← adapter
      ├─ browser.observe              ← adapter
      ├─ browser.act                  ← broker 专用
      ├─ authorization.issue-strict-click           ← broker 专用
      ├─ authorization.request-operator-approval    ← broker 专用
      ├─ authorization.operator-approval-status     ← broker 专用
      └─ authorization.cancel-strict-click          ← broker 专用
      ↓
http://127.0.0.1:<port>/trusted
      ↓
Native Host
      ↓
Extension High-level Runtime
```

client 没有 public generic `callTrusted(type, payload)` API，各方法手工拼装自己的 type 字面量，因此 MCP 层无法借它调用 policy mutation、execution internal RPC 或其它未来新增 trusted 方法。

公共能力分两组接口：`ModelBrowserRuntimeClient` 只有 `open / observe`，adapter 依赖它；`TrustedActBrokerRuntimeClient` 额外提供 `act / issueStrictClick / requestOperatorApproval / operatorApprovalStatus / cancelStrictClick`，只注入给 Act broker。这五个方法不得出现在 adapter 的 runtime client 类型里。每个方法各有独立的响应校验器，只挑出所需字段：

- `act` 在 client 层即丢弃 `freshRevision`、`postActionObservationError`、`execution` 细节，以及 verification evidence 中的 `observed`；
- `issueStrictClick` 与 `requestOperatorApproval` 校验返回的 id 与请求一致；`operatorApprovalStatus` 校验返回的 `approvalRequestId` 与请求一致；`cancelStrictClick` 校验返回的 `authorizationId` 与请求一致。

连接只允许显式 loopback host，并禁止 HTTP redirect，避免 trusted Bearer token 离开本机 trusted endpoint。token 默认从 native-host 已创建的 `~/.browser-agent-next/trusted-rpc.token` 只读获取；MCP 侧不会 mint token。

响应必须满足 requestId 精确匹配、字节预算与最小结构验证。对于 `browser.open`，传输在请求发出后失败时无法证明 tab 是否已经创建，因此必须报告 `ACTION_OUTCOME_UNKNOWN`；`browser.observe` 没有副作用，同类失败使用 `STATE_INCOMPLETE`。`browser.act` 的传输失败、响应异形与 trusted 侧 `outcomeMayHaveChanged` 同样映射为 `ACTION_OUTCOME_UNKNOWN`；授权方法（issue / request approval / status / cancel）的传输失败或响应异形映射为 `AUTHORIZATION_REQUIRED`；cancel 的失败只在 broker 内部被吞掉，不会出现在返回给模型的错误里。

## MCP CLI / Operator Configuration

`@browser-agent-next/mcp-server` 提供 `browser-agent-next-mcp` 可执行入口。

配置只从进程启动环境读取，属于 operator/control-plane 配置，不允许模型通过 tool arguments 修改。默认值刻意 fail closed：

```text
MODEL_READ_ORIGINS        = []
MODEL_NAVIGATION_ORIGINS  = []
MODEL_ACT_ORIGINS         = []
MODEL_TOOLS               = 默认集合（不含 browser.act）
MODEL_ACT_BUDGET          = 16
MODEL_ACT_APPROVAL        = operator
MODEL_APPROVAL_TIMEOUT_MS = 60000
MODEL_INCLUDE_VALUES      = false
MODEL_MAX_ELEMENTS        = 100
MODEL_VISIBLE_REVISIONS   = 64
RPC_HOST                  = 127.0.0.1
RPC_PORT                  = 17366
```

常用环境变量：

```text
BROWSER_AGENT_NEXT_MODEL_READ_ORIGINS
BROWSER_AGENT_NEXT_MODEL_NAVIGATION_ORIGINS
BROWSER_AGENT_NEXT_MODEL_ACT_ORIGINS
BROWSER_AGENT_NEXT_MODEL_ACT_BUDGET
BROWSER_AGENT_NEXT_MODEL_ACT_APPROVAL
BROWSER_AGENT_NEXT_MODEL_APPROVAL_TIMEOUT_MS
BROWSER_AGENT_NEXT_MODEL_TOOLS
BROWSER_AGENT_NEXT_MODEL_INCLUDE_VALUES
BROWSER_AGENT_NEXT_MODEL_MAX_OBSERVATION_ELEMENTS
BROWSER_AGENT_NEXT_MODEL_MAX_VISIBLE_REVISIONS
BROWSER_AGENT_NEXT_RPC_HOST
BROWSER_AGENT_NEXT_RPC_PORT
BROWSER_AGENT_NEXT_RPC_TOKEN_PATH
BROWSER_AGENT_NEXT_RPC_TIMEOUT_MS
BROWSER_AGENT_NEXT_RPC_MAX_RESPONSE_BYTES
BROWSER_AGENT_NEXT_MCP_MAX_RESULT_BYTES
```

origin 配置仍必须是纯 http/https exact origin。`MODEL_ACT_ORIGINS` 最多 100 项且必须是 `MODEL_READ_ORIGINS` 的子集，`MODEL_ACT_BUDGET` 取 1..256 的整数，`MODEL_ACT_APPROVAL` 只接受 `operator` 或 `agent-owned-auto`，`MODEL_APPROVAL_TIMEOUT_MS` 取 1..120000 的整数；任何一项非法都会让进程在启动阶段失败。RPC host 只能是 `127.0.0.1 / localhost / ::1`。

没有提供“trusted token value”环境变量。CLI 在 stdio server 启动前从 native-host token file 只读获取 token，并沿用 symlink / owner / permission 校验；因此配置错误不会等到首个 tool call 才出现，也不会向 stdout 写任何错误文本。

`serveStdio(factory)` 每次构造连接实例时都会重新创建 `ModelFacingBrowserAdapter`，所以 projected revision state 仍然是 connection-local。

## Wire-level Integration Gate

PR #5 不只测试 bridge 方法本身，还使用官方 `StdioServerTransport` 与内存 `PassThrough` pipe 完成真实 JSON-RPC wire 验证：

```text
initialize
  ↓
notifications/initialized
  ↓
tools/list
  ↓
tools/call(browser.observe)
  ↓
tools/call(unexposed browser.open) → POLICY_BLOCKED
```

该测试确认 `serveStdio(factory)` 的 legacy connection 可以正常 pin server instance，catalog 与 dispatch policy 在真实 wire 上保持一致，未暴露工具不会因为客户端手工构造 `tools/call` 而绕过 catalog。

## Act broker

`browser.act` 不直接转发 trusted RPC。adapter 先做本地检查，再把请求交给 MCP 进程内的 Act broker；broker 才拥有 `act / issueStrictClick / requestOperatorApproval / operatorApprovalStatus` 这四个 trusted 方法。

```text
tools/call(browser.act)
  ↓
parseModelActInput（多余字段、kind≠click 一律 POLICY_BLOCKED）
  ↓
revision 必须已对本连接出境（否则 MODEL_EGRESS_BLOCKED）
  ↓
ref 必须在投影后的 observation 里（否则 REF_NOT_IN_OBSERVATION）
  ↓
Act broker
  ├─ act origin 检查（tab origin + 目标 frame 有效 origin）
  ├─ 预算
  ├─ (tab, revision, ref) 单次执行账本
  ├─ 授权（operator approval 或 agent-owned control-plane grant）
  └─ trusted browser.act（verifyTimeoutMs 固定为 0）
  ↓
adapter 在投影后的 observation 上本地重算 verification
  ↓
{ status, effectClass, verification, verificationAttempts }
```

### 模型能提供什么

模型只提供 `tabId`、`observedRevision`、`ref`、`kind: "click"`、`verification` 与可选 `verifyTimeoutMs`。`authorizationId`、`actionId`、`assurance`、`source` 都由 broker 生成或固定，模型传入即拒绝。授权 id 与 action id 均为 broker 生成的随机 UUID。

### act origin 检查

检查同时覆盖两层，任何一层不在 act allowlist 内都返回 `ORIGIN_NOT_ALLOWED`：

1. observation 的 tab origin；
2. 目标 element 所在 frame 的有效 origin。`about:blank` / `about:srcdoc` 继承父 frame；顶层 frame 缺 url 时回落到 tab origin；其余无法证明 url 的 frame 视为未知，同样拒绝。

这样模型不能借 read origin 内的页面嵌入的跨 origin iframe，对一个未经 act allowlist 的 frame 发起点击。

### 预算

预算按连接计，默认 16，范围 1..256。每次通过 act origin 检查的调用先扣 1 点，之后无论授权是否通过、动作是否成功都不退还。重复调用同一 `(tab, revision, ref)` 被拒时也照扣 1 点（fail closed）。预算耗尽后返回 `POLICY_BLOCKED`。

### (tab, revision, ref) 单次执行

账本 key 是 `JSON.stringify([tabId, revision, ref])`。同一 key 在一个连接内至多执行一次；标记先于任何 trusted 请求落账，此后任何失败（授权被拒、超时、传输失败、act 失败）都不回滚。因此失败的点击不能被原样重试，模型需要重新 observe 得到新的 revision 后再提出新请求。

### 两条授权路径

broker 生成 `authorizationId`，grant TTL 固定为 30 秒（`MODEL_ACT_GRANT_TTL_MS = 30_000`），grant 精确绑定 tab + revision + ref：

- **operator（默认）**：调用 `authorization.request-operator-approval` 创建 pending request，然后每 1 秒（`MODEL_ACT_APPROVAL_POLL_INTERVAL_MS = 1_000`）轮询 `authorization.operator-approval-status`。请求带上 `approvalTtlMs = MODEL_APPROVAL_TIMEOUT_MS`，扩展里的审批有效期取它与扩展上限（120 秒）的较小值。`approved` 才继续执行；`rejected / expired / invalidated / cancelled / unknown` 与超过 `MODEL_APPROVAL_TIMEOUT_MS`（默认 60000，范围 1..120000）都返回 `AUTHORIZATION_REQUIRED`，message 区分原因。批准只能来自扩展的审批 UI，MCP elicitation 或 client UI 的响应不构成 operator-approved 的证明。
- **agent-owned-auto**：仅当 `MODEL_ACT_APPROVAL=agent-owned-auto`、observation 的 `tab.ownedBySession === true`、且该 tab 未被降级时，直接调用 `authorization.issue-strict-click` 签发 control-plane grant。其余情况一律回落到 operator 路径。非 `ownedBySession` 的 tab 即使配置了 auto，也会被扩展以 `AUTHORIZATION_REQUIRED` 拒绝 control-plane grant，因此 broker 在 MCP 侧也不会走这条路径。

默认路径是 operator，即使 tab 是 agent-owned 也是如此。auto 是 operator 的显式选择，而不是默认。

### 取消、撤销与 progress（Phase 6.6b-A）

- **撤销**：`authorizationId` 生成后，只要 act 没有成功返回（授权超时、客户端取消、status 出错、拒绝等终态、执行失败含 `ACTION_OUTCOME_UNKNOWN` 与 RPC 超时），broker 都调用一次 `authorization.cancel-strict-click`。撤销尽力而为，失败被吞掉，不覆盖原错误；撤销成功不代表点击被阻止。降级判断先于撤销 RPC 落定。
- **客户端取消**：MCP `tools/call` 的取消信号（`ctx.mcpReq.signal`）经 adapter 传给 broker。入口已取消时不发起任何 RPC、不扣预算；等待审批期间取消会立即停止轮询并撤销；批准后、act 发出前取消则不执行并撤销。act 一旦发出，取消信号不再生效，绝不中断在途 act RPC。客户端取消返回 `AUTHORIZATION_REQUIRED`（固定文本）。
- **progress**：客户端在 `_meta.progressToken` 里请求进度时，operator 路径每次轮询到 `pending` 后发一条 `notifications/progress`，`progress` 为 1、2、3… 的递增计数，`message` 为固定文本 `waiting for operator approval in the browser extension`，不带 `total`；不含 approval id、ref、origin、revision 或页面文本。未提供 token 或走 agent-owned-auto 路径时不发送。支持 progress 的客户端可以据此重置请求超时。

### ACTION_OUTCOME_UNKNOWN 后永久降级

授权阶段或执行阶段只要出现 `ACTION_OUTCOME_UNKNOWN`，或抛出非 Runtime 异常，该 tab 在当前连接内永久降级：之后在该 tab 上即使配置了 `agent-owned-auto` 也只走 operator 路径，降级不可逆。降级状态按连接计、不跨连接持久；宿主重连会重置，模型自身无法触发重连。

### 结果投影与本地重验证

broker 调用 trusted `browser.act` 时 `verifyTimeoutMs` 固定为 0，扩展返回的 `verification` 和 `verificationAttempts` 整体丢弃，只保留“已执行”：

```text
{ status: "executed", effectClass: "unknown" }
```

原因是扩展侧 verification 在未经出境投影的 fresh observation 上计算，可能编码隐藏 frame、被 redact 的 value 或非 read origin 的 URL。模型可见的 verification 由 adapter 在动作之后重新计算：

```text
Fresh Runtime Observe
      ↓
Model Egress Projection（写入本连接的 model-visible store）
      ↓
Verify Projected Observation
      ↓
Bounded Poll（窗口 = verifyTimeoutMs，默认 MODEL_ACT_DEFAULT_VERIFY_TIMEOUT_MS = 1_500）
```

返回给模型的结构为：

```text
{ status: "executed", effectClass: "unknown", verification, verificationAttempts }
```

- `effectClass` 恒为 `unknown`：generic click 的业务副作用无法由结构化 primitive 证明；
- `verification` 的 evidence 不含 `observed`；
- act 之后如果本地 observe 失败（含 egress / policy 失败）且没有取得任何可验证的 observation，不能把整个调用报成错误，因为动作已经执行；此时返回 executed + inconclusive，原因是固定文案，不透传原始错误文本。

### 错误出境

trusted Runtime 的错误 message 来自扩展原文，可能描述未出境的页面状态。broker 只保留 error code，message 换成固定文本（形如 `trusted Runtime rejected browser.act authorization: <code>`）。broker 自身产生的错误 message 是固定文案，不经过这一步。

### 错误码

| 失败 | code |
|---|---|
| 工具未暴露 / 未配置 broker | `POLICY_BLOCKED` |
| 入参非法 / 多余字段 / `kind≠click` | `POLICY_BLOCKED` |
| revision 未对本连接出境 | `MODEL_EGRESS_BLOCKED` |
| ref 不在投影后的 observation | `REF_NOT_IN_OBSERVATION` |
| tab 或目标 frame origin 不在 act allowlist | `ORIGIN_NOT_ALLOWED` |
| 预算耗尽 / `(tab, revision, ref)` 重复 | `POLICY_BLOCKED` |
| issue / approval / status 传输失败或响应异形 | `AUTHORIZATION_REQUIRED` |
| operator 拒绝 / 过期 / invalidated / cancelled / unknown / 超时 | `AUTHORIZATION_REQUIRED` |
| 客户端在 act 发出前取消 tools/call | `AUTHORIZATION_REQUIRED` |
| act 传输失败 / 响应异形 / `outcomeMayHaveChanged` | `ACTION_OUTCOME_UNKNOWN`，并降级该 tab |
| 扩展侧已知 runtime code | 保留 code，message 换成固定文本 |

### 已知限制

- act 执行失败时扩展返回的 runtime code（`TARGET_OCCLUDED`、`DOCUMENT_CHANGED` 等）会原样保留，每次最多泄露约 1 bit 实时页面状态，受预算、单次执行与授权约束；
- 撤销尽力而为：cancel RPC 不可达或失败，或 tombstone 被驱逐后同 id 的 request 才迟到时，扩展里仍可能遗留 pending request，事后批准会产生一个无人消费的 grant（随机 id、单次使用、TTL 30 秒、绑定 `(tab, rev, ref)`）；
- 上述两点的处置详见 `docs/SECURITY.md` 的「Model act broker 边界」。

## 后续工作

Phase 6.6a 已交付 Act broker baseline，Phase 6.6b-A 已交付取消、撤销与 progress。后续按 Roadmap 继续：

1. Phase 6.6b-B：扩展 badge 显示待审批数、popup 显示 TTL 倒计时并标注不可信页面文本，以及对应的 Real Chromium E2E；
2. Phase 6.6c：side-effect 的 MCP stdio wire 集成测试与最终对抗式审查。
