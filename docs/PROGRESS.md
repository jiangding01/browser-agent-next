# 实现进度

最后更新：2026-09-20

## 当前分支

```text
feat/authorization-assurance-ingress
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception        ✅ 已合并
PR #2 Hybrid + Strict Click              ✅ 已合并
PR #3 Child-frame Hybrid                 ✅ 已合并
PR #4 Authorization + High-level API     ✅ 已合并
PR #5 Model-facing Adapter Boundary      ✅ 已合并
PR #6 Assurance Issuance Ingress         ✅ 已合并
PR #7 OOPIF + Child-frame Actuation       🚧 进行中

Model tool exposure allowlist             ✅ baseline
Model read / navigation origin policy     ✅ baseline
Model-visible revision store              ✅ bounded
Egress projection / value redaction       ✅ baseline
Cross-origin child-frame egress filtering ✅ baseline
Projected extract / verify / wait         ✅ baseline
MCP tool schema/catalog                    ✅
MCP stdio transport                        ✅ server seam
Model-facing Runtime client                ✅ open/observe only
MCP executable CLI + operator config       ✅ fail-closed baseline
MCP stdio wire integration                  ✅ legacy handshake + tools
PR #5 Final Adversarial Review              ✅
```

## PR #5 第一阶段已完成

- 新增独立 `ModelToolExposurePolicy`，模型工具目录只能来自显式 allowlist；
- 第一阶段只暴露 `browser.open / observe / extract / verify / wait`，`browser.act` 继续 fail closed；
- authorization issuance、auto-act policy mutation、raw trusted RPC、raw CDP 不属于 model-facing tool catalog；
- 新增独立 `ModelOriginAccessPolicy`，model read/egress 与 model navigation 使用两套 exact-origin allowlist；
- model read/navigation policy 与 Runtime auto-act origin policy 保持完全独立；
- adapter 只依赖 trusted Runtime 的 `browser.open / browser.observe` 最小 surface；
- `browser.extract / browser.verify / browser.wait` 在 projected model-visible observation 上本地执行，避免内部 revision / hidden-frame boolean side channel；
- model-visible observation store 默认最多保留 64 个 revision，重启后安全降级为重新 observe；
- values 默认不出境；page-declared capabilities 与 runtime delta 当前也不进入模型；
- 未被 model read policy 允许的 child frame 会过滤 URL 与元素，并把 coverage 降级为 partial；
- model input 使用 exact key + bounded collection/string/timeout 校验；
- verification evidence 的 `observed` 字段不返回模型。

## 本轮新增

- MCP tool catalog 只包含 `browser.open / observe / extract / verify / wait`；
- 每个 tool 都有显式 JSON Schema，顶层和嵌套 object 默认 `additionalProperties: false`；
- schema 数量、字符串、timeout、polling 上限直接引用 `MODEL_INPUT_LIMITS`，避免和 runtime validator 漂移；
- `field_value.equals` 使用有界 JSON Schema；runtime validator 继续额外执行全局节点 budget；
- catalog definitions 深度冻结，transport 层不能在运行时修改安全契约；
- catalog 最终仍由 `ModelToolExposurePolicy` 过滤，不存在扫描内部 RPC 自动注册的路径。

## Stdio transport baseline

- 使用官方 MCP TypeScript SDK v2 `@modelcontextprotocol/server@2.0.0`；
- 使用低层 `Server` 保留现有 JSON Schema + runtime validator 单一安全契约；
- stdio 使用官方 `serveStdio(factory)`，不是旧版 `StdioServerTransport.connect()` 路径；
- 每个 stdio connection 在 factory 内创建新的 model-facing invoker，防止 model-visible revision store 跨连接共享；
- 未暴露 tool 在 adapter dispatch 前 fail closed；
- MCP tool result 默认最多 256 KiB，最大配置 1 MiB；
- BrowserRuntimeError 只返回 bounded code/message，不返回 details；未知异常统一为 INTERNAL_ERROR；
- 当前已完成 transport/server seam，但可执行 CLI 还依赖下一步 trusted Runtime client。

## Trusted Runtime client baseline

- 新增 `TrustedRuntimeHttpClient`，公共 surface 只有 `open()` / `observe()`；
- 不提供 generic trusted RPC type/payload passthrough；
- endpoint 只能是显式 loopback（`127.0.0.1 / localhost / ::1`），HTTP redirect 直接禁止；
- 默认只读 `~/.browser-agent-next/trusted-rpc.token`，MCP 进程不能创建或轮换 token；
- token path 拒绝 symlink、非当前用户 owner 和过宽 POSIX 权限；
- requestId 必须与 trusted response 精确匹配；
- trusted response 有 2 MiB 默认字节上限（配置最大 4 MiB），并做结构校验；
- `browser.open` 在未收到可信响应的传输失败上返回 `ACTION_OUTCOME_UNKNOWN`，禁止上层把它当成可安全重试；
- `browser.observe` 同类失败返回 `STATE_INCOMPLETE`；
- trusted host 的已知 Runtime error code 才允许保留语义，未知 code 不直接透传。

## MCP CLI baseline

- package 暴露 `browser-agent-next-mcp` 可执行入口；
- operator 配置只从进程启动环境读取，不从 MCP tool arguments 读取；
- read/navigation origin 默认都是空集合，未配置时数据出境和导航都 fail closed；
- tools 默认是当前 5 个 model-safe tools，但仍受 origin policy 与 adapter policy 双重约束；
- `includeValues` 默认 false；
- origin 继续使用 exact-origin 解析，path/query/fragment/credentials 配置直接拒绝；
- RPC host 在启动阶段就限制为 loopback；
- 不支持通过环境变量直接传 trusted token，只允许 token file path；
- trusted token 在 stdio wire 启动前读取并验证，启动错误只写 stderr；
- 每次 MCP connection factory 仍创建新的 adapter/model-visible revision store。

## MCP wire integration

- 使用 SDK 自带 `StdioServerTransport` + 内存 pipe 做真实 JSON-RPC wire 测试；
- 覆盖 legacy `initialize` 握手、`notifications/initialized`、`tools/list`、`tools/call`；
- 验证 catalog 只返回 operator allowlist 中的工具；
- 验证未暴露工具在 wire 上返回 `POLICY_BLOCKED`，且不会进入 invoker；
- 验证同一 stdio connection 只 pin 一个 factory instance。

## 当前边界

Runtime `browser.wait` 已支持 event-assisted wake-up；但 model-facing `browser.wait` 第一阶段故意只在 projected observation 上做 bounded polling + verify，避免 Runtime 完整 observation 形成模型不可见数据的 verification side channel。

Runtime `browser.act` 仍可在 trusted control plane 内使用；model-facing adapter 当前不暴露它。后续只有在 scoped authorization broker 不能被模型直接调用或自报 assurance 的前提下才开放副作用工具。

child-frame actuation / OOPIF session exact mapping 仍按既有 Roadmap 独立推进，不在 PR #5 第一阶段隐式放宽。

## PR #6 当前进度

- Strict Click 授权签发逻辑已抽为统一 `StrictClickAuthorizationIssuanceService`；
- control-plane / operator-approved / enterprise-policy 三条 public issuance path 在代码层固定 source ↔ assurance；
- 调用方不能通过 input 自报 source/assurance；
- 三条路径共享 retained observation / ref / origin / TTL / minimum assurance 校验；
- 现有 trusted-host 只委托 control-plane issuance，外部协议行为保持不变；
- operator-approved 独立人工审批 ingress 已完成 baseline；
- enterprise-policy 独立签名证明 ingress 已完成 baseline。

## Operator-approved ingress baseline

- control-plane 只能创建 pending approval / 查询 status，不能直接 approve；
- pending request 精确绑定 authorizationId / tab / revision / ref / TTL；
- pending request 有独立过期时间、容量上限与重复 authorizationId 防护；
- 专用 Extension action popup 展示 origin、页面标题、role/name/ref，并提供“批准一次 / 拒绝”；
- 真正 approve 只接受精确 `chrome-extension://<id>/operator-approval.html` sender；
- popup message 使用 exact-key schema，不能夹带 source / assurance；
- approve 单次消费 pending，并在签发前重新调用统一 issuer；
- navigation / tab removal 同时撤销 active grant 与 pending approval；
- reject / expire / lifecycle invalidation 都不会产生 grant；
- trusted-host 协议不存在 operator approve 消息类型。

## Enterprise-policy ingress baseline

- 企业验证公钥只从 `chrome.storage.managed` 读取，属于管理员受管只读策略；
- managed storage 首次读取前限制为 `TRUSTED_CONTEXTS`；
- 当前 baseline 使用 ECDSA P-256 + SHA-256；
- signed assertion 精确绑定 assertionId / keyId / authorizationId / tab / revision / ref / origin / click / unknown effect / issuedAt / expiresAt / grant TTL；
- assertion validity window 有界，grant 不允许活得比 assertion 更久；
- control-plane 只能转发 assertion + signature，不能提供 source / assurance；
- assertion signature 验证通过后仍重新匹配 retained observation origin，并通过统一 issuer 再校验 ref / auto-act origin / minimum assurance；
- replay ledger 持久化到 `chrome.storage.local`，并限制为 `TRUSTED_CONTEXTS`，因此 MV3 service-worker 重启不会恢复 assertion 可重放性；
- replay consume 在当前 worker 内串行，持久化失败时 fail closed；
- replay ledger 只回收已过期 assertion；如果未过期记录已达到容量上限，则拒绝新的 enterprise issuance，绝不驱逐有效 replay 记录；
- 当前支持单个 managed P-256 key；key rotation / multi-key overlap 后续可按需要扩展。

## PR #6 最终门禁

- `pnpm install --frozen-lockfile` ✅
- TypeScript typecheck ✅
- Unit / integration tests（243）✅
- Workspace build ✅
- Operator approval protocol/store/UI ingress tests ✅
- Enterprise P-256 sign/verify tests ✅
- Managed policy / persistent replay tests ✅
- Extension packaging / managed schema via build ✅
- Real Chromium E2E ✅
- Final Adversarial Review ✅

## PR #7 当前进度

- ✅ PR #7 已同步 PR #6 合并后的最新 main，冲突清零；
- ✅ PR #7 重新定位为 OOPIF / child-frame actuation 阶段；
- 🚧 第一小步：Chrome debugger flat child-session transport；
- ⏳ OOPIF frameEpoch exact session mapping；
- ⏳ child-frame coordinate projection；
- ⏳ child-frame Strict Click dispatch；
- ⏳ navigation / detach / stale projection fail-closed；
- ⏳ Real Chromium OOPIF / child-frame actuation E2E。

### PR #7 第一小步：flat child-session transport

当前实现准备新增：

- root debugger attach 后尝试 `Target.setAutoAttach({ flatten: true })`；
- 只登记 `targetInfo.type === "iframe"` 的 child session；
- 记录 `sessionId / targetId / parentSessionId`；
- 每个 child session 递归启用 iframe auto-attach，覆盖 nested OOPIF；
- Runtime execution context 按 root / child session 分桶；
- 提供 session-aware context binding，但现有 root-only resolver 暂不改变；
- child target detach 递归清理 session/context；
- flat sessions 不可用时保留现有 root 能力，OOPIF 继续 fail closed。

## 下一步

1. 第一小步通过完整 CI 后，让 frameEpoch resolver 使用 exact child session；
2. 将 OOPIF exact mapping 接入 Hybrid AX collection；
3. 再设计 frame-owner exact identity 与坐标投影；
4. model-facing `browser.act` 继续保持不可见，Phase 6.6 独立推进。

## 文档

- `docs/MODEL-FACING-ADAPTER.md`：PR #5 模型信任边界与第一阶段设计；
- `docs/INVARIANTS.md`：新增 model-visible revision / projected verification 等不变量；
- `docs/ROADMAP.md`：Phase 6.5 按可验证子阶段推进。


## PR #5 最终门禁

- `pnpm install --frozen-lockfile` ✅
- TypeScript typecheck ✅
- Unit / integration tests ✅
- Workspace build ✅
- MCP stdio wire integration ✅
- Real Chromium E2E ✅
- MCP SDK v2 / serveStdio connection-pinned 语义核对 ✅
- Model-facing / trusted control-plane 边界最终对抗式 Review ✅

详见 `docs/PR5-FINAL-REVIEW.md`。
- `docs/PR6-FINAL-REVIEW.md`：PR #6 最终对抗式审查与 merge gate。
