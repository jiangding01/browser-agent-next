# MCP Server

PR #5 已将这里从空壳收敛成真正的 **Model-facing Adapter Boundary**。

当前第一阶段先实现 transport-independent adapter core，而不是直接把 trusted native-host RPC 注册成 MCP tools：

- 模型只能看到显式 allowlist 中的 `browser.*` 工具；
- `authorization.issue-*`、auto-act policy mutation、raw trusted RPC、raw CDP 不属于模型工具目录；
- model read/egress origin policy 与 model navigation origin policy 独立；
- 这两个 policy 又与 model act origin policy、runtime auto-act origin policy 保持独立，其中 act origin 必须是 read origin 的子集；
- observation 只有通过 model-egress projection 后才会进入 model-visible revision store；
- `browser.extract` / `browser.verify` / `browser.wait` 在已投影状态上本地执行，避免通过隐藏 frame 或内部 revision 形成旁路读取；
- values 默认不出境；page-declared capabilities 与 runtime delta 当前也不直接进入模型；
- 跨 origin child frame 如果不在 model read allowlist，会被过滤并把 coverage 降级为 partial；
- `browser.act` 是 side-effect tier 的工具，默认不在 model-facing tool catalog 里；operator 显式配置后，它只能经过 MCP 进程内的 Act broker（预算、单次执行、operator approval 默认）执行，模型不能提供 `authorizationId` 等授权字段。

第二阶段已增加显式 MCP tool catalog 与 JSON Schema。Schema 的核心 bounds 直接来自 runtime validator 使用的 `MODEL_INPUT_LIMITS`，catalog 仍需经过 `ModelToolExposurePolicy` 过滤。

真实 MCP stdio transport 已接入；transport 只能消费既有 catalog/adapter，不得重新定义安全边界。

第三阶段已接入官方 MCP v2 stdio server seam：

- `@modelcontextprotocol/server@2.0.0`；
- 低层 `Server` 手工挂接 `tools/list` / `tools/call`；
- `serveStdio(factory)` 建立 connection-pinned stdio server；
- 每连接独立 adapter state；
- bounded tool result 与错误脱敏。

当前已提供可执行 CLI：它通过 `TrustedRuntimeHttpClient` 映射 `browser.open / browser.observe`；仅当 operator 显式暴露 `browser.act` 时，才额外创建 Act broker。CLI 仍保持 fail closed 的 origin、token 和 tool allowlist 配置。

第四阶段已增加最小 `TrustedRuntimeHttpClient`：

- 公共能力是 `browser.open` / `browser.observe`，外加 Act broker 专用的 `browser.act`、`authorization.issue-strict-click`、`authorization.request-operator-approval`、`authorization.operator-approval-status`，没有 generic passthrough；
- 只允许 loopback endpoint，禁止 redirect；
- 只读 native-host trusted token；
- request/response 绑定 requestId；
- bounded response body + observation 结构校验；
- `browser.open` 的传输歧义按 `ACTION_OUTCOME_UNKNOWN` 处理。

现有 CLI 已通过 stdio server 与该 client 组装为可执行 MCP 进程。子进程级 CLI 集成测试与 side-effect 的 stdio wire 集成测试属于 Phase 6.6c。

## 运行 CLI

在新检出或清理过 workspace `dist` 的环境中，先构建根 workspace，或构建 MCP Server 及其 workspace 依赖：

```bash
pnpm build
# 或：pnpm --filter '@browser-agent-next/mcp-server...' build
```

workspace 依赖已经构建后，也可以只构建 MCP Server：

```bash
pnpm --filter @browser-agent-next/mcp-server build
```

构建后可执行：

```bash
BROWSER_AGENT_NEXT_MODEL_READ_ORIGINS=https://example.com \
BROWSER_AGENT_NEXT_MODEL_NAVIGATION_ORIGINS=https://example.com \
node apps/mcp-server/dist/cli.js
```

也可以使用 package bin：`browser-agent-next-mcp`。

默认 read/navigation/act origins 都为空，因此不配置 origin 时会 fail closed。values 默认不出境。

默认工具集合不包含 side-effect tier 的 `browser.act`，即 `browser.open / observe / extract / verify / wait` 五个工具。`BROWSER_AGENT_NEXT_MODEL_TOOLS` 一旦设置就完全替换默认集合（逗号分隔），所以启用 `browser.act` 时要把其它需要的工具一并写上。

可选配置包括：

- `BROWSER_AGENT_NEXT_MODEL_ACT_ORIGINS`：默认为空；纯 http/https exact origin，逗号分隔，≤100 条，且必须是 `BROWSER_AGENT_NEXT_MODEL_READ_ORIGINS` 的子集，否则启动失败；
- `BROWSER_AGENT_NEXT_MODEL_ACT_BUDGET`：每连接的 act 预算，默认 `16`，范围 1..256 的整数；
- `BROWSER_AGENT_NEXT_MODEL_ACT_APPROVAL`：默认 `operator`，可选 `agent-owned-auto`；
- `BROWSER_AGENT_NEXT_MODEL_APPROVAL_TIMEOUT_MS`：等待 operator 批准的上限，默认 `60000`，范围 1..120000 的整数；
- `BROWSER_AGENT_NEXT_MODEL_TOOLS`
- `BROWSER_AGENT_NEXT_MODEL_INCLUDE_VALUES`
- `BROWSER_AGENT_NEXT_MODEL_MAX_OBSERVATION_ELEMENTS`
- `BROWSER_AGENT_NEXT_MODEL_MAX_VISIBLE_REVISIONS`
- `BROWSER_AGENT_NEXT_RPC_HOST`
- `BROWSER_AGENT_NEXT_RPC_PORT`
- `BROWSER_AGENT_NEXT_RPC_TOKEN_PATH`
- `BROWSER_AGENT_NEXT_RPC_TIMEOUT_MS`
- `BROWSER_AGENT_NEXT_RPC_MAX_RESPONSE_BYTES`
- `BROWSER_AGENT_NEXT_MCP_MAX_RESULT_BYTES`

trusted token 本身不接受环境变量明文配置；CLI 只读取 native-host token file。

## 启用 browser.act

`browser.act` 需要同时满足：写进 `BROWSER_AGENT_NEXT_MODEL_TOOLS`、配置非空的 `BROWSER_AGENT_NEXT_MODEL_ACT_ORIGINS`（⊆ read origins）、扩展侧批准。示例：

```bash
BROWSER_AGENT_NEXT_MODEL_READ_ORIGINS=https://example.com \
BROWSER_AGENT_NEXT_MODEL_NAVIGATION_ORIGINS=https://example.com \
BROWSER_AGENT_NEXT_MODEL_ACT_ORIGINS=https://example.com \
BROWSER_AGENT_NEXT_MODEL_TOOLS=browser.open,browser.observe,browser.extract,browser.verify,browser.wait,browser.act \
node apps/mcp-server/dist/cli.js
```

行为要点：

- 默认授权路径是 operator approval：broker 在扩展里创建 pending request 并轮询状态，需要人在扩展的审批 UI 里批准；MCP elicitation 或 client UI 不构成批准证明；
- `BROWSER_AGENT_NEXT_MODEL_ACT_APPROVAL=agent-owned-auto` 只对 `browser.open` 创建、`ownedBySession` 且未降级的 tab 直接签发 control-plane grant，其余仍走 operator；
- 预算、`(tab, revision, ref)` 单次执行账本与降级状态都是每个 MCP 连接独立，重连后重置；
- act origin 检查同时覆盖 tab origin 和目标 element 所在 frame 的有效 origin；
- 返回 `status`、`effectClass: "unknown"`、在投影后 observation 上本地重算的 `verification` 与 `verificationAttempts`；`verifyTimeoutMs` 默认 1500；
- 详细语义见 `docs/MODEL-FACING-ADAPTER.md` 的「Act broker」与 `docs/SECURITY.md`。

## Wire-level integration

测试使用官方 `StdioServerTransport` 和内存 pipe 真实执行 MCP legacy 握手、`tools/list` 与 `tools/call`。未暴露工具即使被客户端手工调用，也会在进入 adapter 前返回 `POLICY_BLOCKED`。
