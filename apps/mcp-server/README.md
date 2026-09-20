# MCP Server

PR #5 正在把这里从空壳收敛成真正的 **Model-facing Adapter Boundary**。

当前第一阶段先实现 transport-independent adapter core，而不是直接把 trusted native-host RPC 注册成 MCP tools：

- 模型只能看到显式 allowlist 中的 `browser.*` 工具；
- `authorization.issue-*`、auto-act policy mutation、raw trusted RPC、raw CDP 不属于模型工具目录；
- model read/egress origin policy 与 model navigation origin policy 独立；
- 这两个 policy 又与 runtime auto-act origin policy 保持独立；
- observation 只有通过 model-egress projection 后才会进入 model-visible revision store；
- `browser.extract` / `browser.verify` / `browser.wait` 在已投影状态上本地执行，避免通过隐藏 frame 或内部 revision 形成旁路读取；
- values 默认不出境；page-declared capabilities 与 runtime delta 当前也不直接进入模型；
- 跨 origin child frame 如果不在 model read allowlist，会被过滤并把 coverage 降级为 partial；
- `browser.act` 当前故意不属于 model-facing tool catalog，等待后续安全的内部 authorization broker 与 side-effect policy 完成后再开放。

第二阶段已增加显式 MCP tool catalog 与 JSON Schema。Schema 的核心 bounds 直接来自 runtime validator 使用的 `MODEL_INPUT_LIMITS`，catalog 仍需经过 `ModelToolExposurePolicy` 过滤。

下一步增加真实 MCP stdio transport；transport 只能消费既有 catalog/adapter，不得重新定义安全边界。

第三阶段已接入官方 MCP v2 stdio server seam：

- `@modelcontextprotocol/server@2.0.0`；
- 低层 `Server` 手工挂接 `tools/list` / `tools/call`；
- `serveStdio(factory)` 建立 connection-pinned stdio server；
- 每连接独立 adapter state；
- bounded tool result 与错误脱敏。

当前还没有最终可执行 CLI，因为下一步需要实现只映射 `browser.open / browser.observe` 的 trusted Runtime client。

第四阶段已增加最小 `TrustedRuntimeHttpClient`：

- 只实现 `browser.open` / `browser.observe`；
- 只允许 loopback endpoint，禁止 redirect；
- 只读 native-host trusted token；
- request/response 绑定 requestId；
- bounded response body + observation 结构校验；
- `browser.open` 的传输歧义按 `ACTION_OUTCOME_UNKNOWN` 处理。

下一步是把这一 client 与 stdio server 通过受信配置入口组装成真正可执行的 MCP 进程，并增加子进程级集成测试。

## 运行 CLI

构建后可执行：

```bash
pnpm --filter @browser-agent-next/mcp-server build

BROWSER_AGENT_NEXT_MODEL_READ_ORIGINS=https://example.com \
BROWSER_AGENT_NEXT_MODEL_NAVIGATION_ORIGINS=https://example.com \
node apps/mcp-server/dist/cli.js
```

也可以使用 package bin：`browser-agent-next-mcp`。

默认 read/navigation origins 都为空，因此不配置 origin 时会 fail closed。values 默认不出境。

可选配置包括：

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

## Wire-level integration

测试使用官方 `StdioServerTransport` 和内存 pipe 真实执行 MCP legacy 握手、`tools/list` 与 `tools/call`。未暴露工具即使被客户端手工调用，也会在进入 adapter 前返回 `POLICY_BLOCKED`。
