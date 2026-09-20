# Model-facing Adapter Boundary

更新日期：2026-09-20

## 目标

PR #5 的目标不是“给 trusted RPC 套一层 MCP”，而是建立一个独立的模型信任边界：

```text
LLM / Agent
    ↓
Model-facing MCP Adapter
    ├─ explicit tool exposure allowlist
    ├─ model navigation policy
    ├─ model read / egress policy
    ├─ bounded input validation
    └─ model-visible observation store
    ↓
High-level Browser Runtime
    ↓
Trusted control plane
```

模型层与 trusted control plane 的权限不是同一个集合。

## 第一阶段工具目录

当前 adapter core 只允许以下工具进入模型目录：

```text
browser.open
browser.observe
browser.extract
browser.verify
browser.wait
```

明确不包含：

```text
browser.act                         暂缓
policy.replace-autoact-origins      禁止
authorization.issue-*              禁止
execution.execute-strict-click      禁止
raw CDP                             禁止
任意 trusted-host internal RPC      禁止
```

`browser.act` 暂缓不是功能遗漏，而是有意保持 fail closed：当前 Runtime 的 Strict Click 需要 authorizationId；模型不能直接获得 authorization issuance 能力。后续必须先引入内部、不可由模型直接调用的 scoped authorization broker，再考虑暴露 side-effect tool。

## 三个独立 policy plane

必须区分：

```text
Model Read / Egress Policy
Model Navigation Policy
Runtime Auto-act Policy
```

三者不能互相推导。

例如：

- 模型可以读取 `https://docs.example`，不等于允许自动点击产生副作用；
- 模型可以被允许导航到某 origin，也不等于该 origin 的页面内容可以直接出境给模型；
- Runtime auto-act allowlist 不能被当作 model read allowlist 使用。

当前 read/navigation policy 都采用 exact-origin allowlist；配置只接受纯 http/https origin，不做 wildcard、suffix 或字符串包含匹配。

## 最小 Runtime surface

第一阶段 adapter 只依赖 trusted Runtime 的两个原语：

```text
browser.open
browser.observe
```

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

当前 catalog 为五个 model-facing tool 提供显式 JSON Schema：

```text
browser.open
browser.observe
browser.extract
browser.verify
browser.wait
```

Schema 与 runtime validator 共用 `MODEL_INPUT_LIMITS`，包括 element count、refs、verification conditions、timeout 与 polling interval 上限。所有可识别 object 默认 `additionalProperties: false`，避免 MCP client 通过额外字段注入内部语义。

`field_value.equals` 的 JSON Schema 对字符串长度、数组/对象规模和递归深度做有界约束；runtime validator 仍保留额外的全局 100-node budget，作为 schema 之外的第二道资源边界。

Tool definitions 会被深度冻结，并且 `createModelFacingMcpToolCatalog()` 仍需通过 `ModelToolExposurePolicy` 过滤。未来新增 trusted RPC 不会自动注册为 MCP tool。

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

当前这一层只是 server/transport seam；真正可执行的本地 MCP 进程仍需要下一阶段的 model-facing Runtime client。

## Trusted Runtime Client

Model-facing adapter 到 trusted control plane 之间新增最小 `TrustedRuntimeHttpClient`：

```text
ModelFacingBrowserAdapter
      ↓
TrustedRuntimeHttpClient
      ├─ browser.open
      └─ browser.observe
      ↓
http://127.0.0.1:<port>/trusted
      ↓
Native Host
      ↓
Extension High-level Runtime
```

client 没有 public generic `callTrusted(type, payload)` API，因此 MCP 层无法借它调用 authorization issuance、policy mutation、execution internal RPC 或其它未来新增 trusted 方法。

连接只允许显式 loopback host，并禁止 HTTP redirect，避免 trusted Bearer token 离开本机 trusted endpoint。token 默认从 native-host 已创建的 `~/.browser-agent-next/trusted-rpc.token` 只读获取；MCP 侧不会 mint token。

响应必须满足 requestId 精确匹配、字节预算与最小结构验证。对于 `browser.open`，传输在请求发出后失败时无法证明 tab 是否已经创建，因此必须报告 `ACTION_OUTCOME_UNKNOWN`；`browser.observe` 没有副作用，同类失败使用 `STATE_INCOMPLETE`。

## MCP CLI / Operator Configuration

`@browser-agent-next/mcp-server` 提供 `browser-agent-next-mcp` 可执行入口。

配置只从进程启动环境读取，属于 operator/control-plane 配置，不允许模型通过 tool arguments 修改。默认值刻意 fail closed：

```text
MODEL_READ_ORIGINS        = []
MODEL_NAVIGATION_ORIGINS  = []
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

origin 配置仍必须是纯 http/https exact origin。RPC host 只能是 `127.0.0.1 / localhost / ::1`。

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

## 后续工作

PR #5 接下来继续：

1. 完成 PR #5 最终对抗式 Review 与文档收口；
2. 更新依赖 lockfile 并确认最终 HEAD CI；
3. `browser.act` 继续保持 model-facing 不可见；scoped authorization broker 作为后续独立安全阶段处理。
