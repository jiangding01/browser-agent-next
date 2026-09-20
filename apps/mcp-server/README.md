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

下一步会在这个 adapter core 上增加 MCP tool schema/transport，而不是反过来让 MCP transport 决定安全边界。
