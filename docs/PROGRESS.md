# 实现进度

最后更新：2026-10-29

## 当前基线

PR #1～#16 已合并，Phase 0～6.6 全部完成；当前进行 Phase 7-0（Trace 与评测底座）。本文档描述仓库阶段状态，不绑定具体 checkout 分支。

## 当前阶段

```text
PR #1 Foundation + DOM Perception        ✅ 已合并
PR #2 Hybrid + Strict Click              ✅ 已合并
PR #3 Child-frame Hybrid                 ✅ 已合并
PR #4 Authorization + High-level API     ✅ 已合并
PR #5 Model-facing Adapter Boundary      ✅ 已合并
PR #6 Assurance Issuance Ingress         ✅ 已合并
PR #7 OOPIF + Child-frame Actuation       ✅ 已合并，Strict Click 时序修复已验证

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
Phase 6.6 PR-0 auto-act origins 配置文件下发 ✅
Phase 6.6a Act broker + model-facing browser.act ✅ baseline（默认不暴露）
Phase 6.6b 取消 / 撤销 / progress + 审批 UX    ✅
Phase 6.6c side-effect wire + 端到端 + 最终审查 ✅
Phase 7-0a 决策评测 harness + 对抗 fixture      ✅
Phase 7-0b 脱敏 trace + 有界 sink              ⏳ 待批准开工
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
- transport/server seam 与可执行 CLI 已完成，并已通过 stdio wire integration 验证。

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

Runtime `browser.act` 仍可在 trusted control plane 内使用；model-facing `browser.act` 自 Phase 6.6a 起作为 side-effect tier 工具存在，但默认不暴露，只有 operator 显式写进 `MODEL_TOOLS` 并配置 act origin 才可用，且只能经过 MCP 进程内的 Act broker，模型不能提供或自报 authorizationId / assurance。

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

## PR #7 当前进度（已合并，修复已验证）

- ✅ PR #7 已同步 PR #6 合并后的最新 main，冲突清零；
- ✅ PR #7 重新定位为 OOPIF / child-frame actuation 阶段；
- ✅ 第一小步：Chrome debugger flat child-session transport；
- ✅ 第二小步：OOPIF frameEpoch exact session mapping + session-aware AX/linking；
- ✅ 第三小步：Strict resolver session-aware child live revalidation baseline；
- ✅ 第四小步：child-frame → top-level coordinate projection core；
- ✅ 第五小步：projection 接入 Strict prepare；
- ✅ prepared target 显式约束为 top-level viewport coordinate space；
- ✅ 第六小步：Real Chromium OOPIF child Strict Click actuation E2E；
- ✅ child-frame Strict Click dispatch 已完成真实 Chromium 闭环；
- ✅ 第七小步：child reload / iframe detach stale target fail-closed E2E；
- ✅ 第八小步：scroll + affine transform OOPIF 实际点击 / perspective fail-closed Real Chromium E2E；
- ✅ 第九小步：nested projection 每一层 parent iframe owner hit-test fail-closed；
- ✅ 第十小步：detached child session late-event resurrection 防护；
- ✅ 第十一小步：nested OOPIF 中间 owner overlay fail-closed / 解除遮挡后真实点击 E2E；
- ✅ Real Chromium OOPIF / child-frame actuation 最终对抗式 Review；Strict Click `mouseMoved` 时序修复已完成并通过全量验收。

### 本轮修复：Strict Click `mouseMoved` 时序（已完成）

- dispatcher 已移除会制造竞态的显式 `mouseMoved`，并保持 `mousePressed` / `mouseReleased` 的安全失败语义；press transport reject 保守映射为 `ACTION_OUTCOME_UNKNOWN`，禁止自动重试；
- 相关 dispatcher / execution 测试、Real Chromium OOPIF / nested-frame 场景、遮挡 fail closed 与解除遮挡恢复均已验证；
- 全量门禁已通过：typecheck、263 个测试、10/10 Chromium E2E、workspace build，以及旧实现回归红 / 新实现回归绿验证。

### 本轮修复：Agent-owned OOPIF E2E readiness（已完成）

- `browser.open` 的 `tabs.create` 结果只证明 tab 已创建，不能证明目标文档已提交；因此 E2E 不再把 Playwright `createdPage` / `load` 或 child frame URL 当作 OOPIF readiness；
- OOPIF readiness 统一由 hybrid Observe 的 actionable complete、DOM + AX provenance 和 child ref 证明；Strict Click / Verify 成功后才读取 Playwright child frame 作最终 DOM 文本断言；
- 专用 delayed-child fixture 在 2250ms 后才导航 child，固定覆盖旧版约 2 秒 frame 轮询会失败、Observe retry 能完成真实 dispatch 的 CI 慢路径。

### PR #7 第一小步：flat child-session transport

本小步已实现：

- root debugger attach 后尝试 `Target.setAutoAttach({ flatten: true })`；
- 只登记 `targetInfo.type === "iframe"` 的 child session；
- 记录 `sessionId / targetId / parentSessionId`；
- 每个 child session 递归启用 iframe auto-attach，覆盖 nested OOPIF；
- Runtime execution context 按 root / child session 分桶；
- 提供 session-aware context binding，但现有 root-only resolver 暂不改变；
- child target detach 递归清理 session/context；
- flat sessions 不可用时保留现有 root 能力，OOPIF 继续 fail closed。

## PR #7 最终门禁

- `pnpm install --frozen-lockfile` ✅
- TypeScript typecheck ✅
- Unit / integration tests ✅
- Workspace build ✅
- OOPIF flat-session exact mapping tests ✅
- child same-session live identity tests ✅
- nested / affine / perspective coordinate projection tests ✅
- Real Chromium OOPIF Hybrid mapping ✅
- Real Chromium child Strict Click dispatch ✅
- reload / detach stale-target fail-closed ✅
- transform / scroll / perspective adversarial E2E ✅
- nested parent-owner occlusion fail-closed / recovery ✅
- Final Adversarial Review ✅

## Phase 6.6 PR-0：auto-act origins 配置文件下发

- native host 每次启动（即扩展连接）时读取 `~/.browser-agent-next/autoact-origins.json`，在 trusted RPC 监听前通过 `policy.replace-autoact-origins` 整体下发；
- 文件必须是当前用户拥有、非 symlink、不可被组/其他用户写入的普通文件，≤ 64 KiB，格式固定为 `{"version":1,"origins":[...]}`，只接受纯 origin；
- 任一项非法则整份作废，文件缺失、非法或下发失败时扩展 allowlist 保持为空（fail closed），日志只写 stderr 且只记数量；
- 新增不变量 117；Real Chromium E2E 覆盖“仅凭配置文件即可完成 control-plane strict click”与“无配置文件时 ORIGIN_NOT_ALLOWED”对照。

## Phase 6.6a：Act broker 与 model-facing browser.act

- `browser.act` 作为唯一的 side-effect tier 工具进入模型工具目录，默认集合 `MODEL_FACING_DEFAULT_TOOL_NAMES` 不包含它，必须显式写进 `MODEL_TOOLS`；
- 新增第 4 个独立 policy plane（model act origin）：默认空，必须是 read origin 的子集，非法时进程启动失败；检查同时覆盖 tab origin 与目标 element 所在 frame 的有效 origin（`about:blank` / `about:srcdoc` 继承父 frame）；
- 新增 4 个 operator 配置：`MODEL_ACT_ORIGINS`、`MODEL_ACT_BUDGET`（默认 16，1..256）、`MODEL_ACT_APPROVAL`（`operator` / `agent-owned-auto`，默认 `operator`）、`MODEL_APPROVAL_TIMEOUT_MS`（默认 60000，1..120000）；
- `TrustedRuntimeHttpClient` 新增 broker 专用的 `act / issueStrictClick / requestOperatorApproval / operatorApprovalStatus`，各自独立响应校验；act 在 client 层丢弃 `freshRevision`、`postActionObservationError`、execution 细节与 evidence 中的 `observed`；issue 与 approval status 校验返回 id 与请求一致；这四个方法不并入 adapter 使用的 `ModelBrowserRuntimeClient`；
- 新增 `modelActBroker`（工厂函数 + 闭包，无 class）：每连接预算、`(tab, revision, ref)` 单次执行账本（标记先于任何 trusted 请求落账，重复调用被拒仍扣 1 点预算）、grant TTL 30 秒、operator approval 每 1 秒轮询；
- 授权路径：默认 operator approval；`agent-owned-auto` 仅对 `ownedBySession` 且未降级的 tab 直接签发 control-plane grant；
- 授权阶段或执行阶段出现 `ACTION_OUTCOME_UNKNOWN`，或抛出非 Runtime 异常，该 tab 在当前连接内永久降级为 operator；降级状态不跨连接持久；
- act 以 `verifyTimeoutMs=0` 调用 trusted Runtime，扩展侧 verification 与 attempts 全部丢弃；adapter 在动作后对投影后的 observation 本地重算 verification（默认窗口 `MODEL_ACT_DEFAULT_VERIFY_TIMEOUT_MS = 1500`），act 之后 observe 失败时返回 executed + inconclusive（固定文案）；
- trusted Runtime 错误只保留 code，message 换成固定文本；
- 新增不变量 118～123（N1～N6），并修订第 78、84 条。

已接受的残余风险与 6.6b 计划见 `docs/SECURITY.md` 的「Model act broker 边界」。

## Phase 6.6a 最终门禁

- TypeScript typecheck ✅
- Unit / integration tests（424 个）✅
- Workspace build ✅
- Real Chromium E2E 11/11 ✅
- check 深度审查 + 对抗式审查：无 HIGH / MEDIUM 结论 ✅

## 修复：OOPIF 输入路由 presentation fence 与 CI E2E flake（已完成）

两个 OOPIF 用例只在 GitHub Actions（ubuntu-latest headless Chromium）上偶发失败，根因分别如下。

**滚动后的 affine transform OOPIF：产品层竞态（已在 Runtime 修复）**

- 证据（CI run 38777671337，8 个 shard × `--repeat-each 4`）：失败的 17/32 次全部是 root frame 收到了 trusted `pointerdown/mousedown/click`，target 是 `#oopif-transform-frame`（iframe owner），child 文档没有收到任何事件；成功的 15/32 次相反。是否送达与“scroll 后 root frame 跑过的 rAF 数”严格相关：≥ 2 帧时 15/15 送达，0～1 帧时 17/17 被路由到 root frame。
- 证据（CI run 38778819528，变体对照，各 12 次）：`active:false`（基线）后台 Tab 的 root renderer 只有约 1 fps（child OOPIF 约 44 fps，`visibilityState` 仍为 visible），失败 9/12；同一用例改为 `active:true` 时 root 为 60 fps，0/12 失败；保持后台 Tab、但 scroll 后先等待 root double-rAF（约 1.9s）时 0/12 失败。
- 结论：浏览器按 root renderer 最近一次 present 的 compositor hit-test 数据跨 process 路由输入；Strict prepare 的 `DOM.getBoxModel` / `elementFromPoint` 读到的是 main-thread 的实时 layout。scroll 尚未被 present 时 prepare 判定命中 OOPIF owner，真实输入却被路由到 root frame。这与 PR #8 移除 `mouseMoved` 无关：PR #8 之前的 run 35505962840 已经以同样方式失败。
- 修复：新增 `rootPresentationFence`。`PolicyGatedStrictClickExecutor` 在第二次 Strict prepare 后，若目标位于 OOPIF child session，就在 root frame 的独立 isolated world 中等待 3 个 animation frame（超时 5s，host 侧另有兜底；root 文档 hidden 时立即失败），然后第三次 prepare，要求 identity 与 top-level 点不变才 dispatch；fence 失败返回 `TARGET_NOT_VISIBLE`，几何变化返回 `TARGET_IDENTITY_MISMATCH`，两者都发生在任何 input 之前，不自动重试 click；grant TTL 在 fence 之后再次校验。新增不变量 124、125。
- 代价与限制：后台 Tab 在 Linux 上约 1 fps 时，每次 OOPIF Strict Click 多等约 3s；有界面 Chrome 的后台 Tab 是 hidden，OOPIF Strict Click 会直接 fail closed；nested 中间层 renderer 尚未单独 fence（见 `docs/CHILD-FRAME.md`）；E2E 中相关 grant 的 `ttlMs` 因此放宽到 15s，affine 用例同时要求 Runtime 自己的 Verify `verified=true`。

**nested OOPIF：测试层问题（已修测试）**

- 证据（CI run 38777671337）：失败时 Playwright 已经有 3 个 Frame 对象，但 parent OOPIF（有时还有 nested child）的 `frame.url()` 一直是 `""`，继续轮询 10s 仍为空；同一时刻 `frameLocator` 链 68ms 就读到了 `Nested OOPIF Action`。Runtime 的 hybrid Observe 也已证明 child ref 完整。
- 结论：对 Runtime 用 `chrome.tabs.create` 打开的 Tab，Playwright 对 OOPIF 的 URL 记账不可靠，按 URL 查找 Frame 是错误的 readiness / 定位依据（历史上 Agent-owned OOPIF 用例的 “cross-site OOPIF frame missing” 也是同一类问题）。
- 修复：nested 用例改用 owner iframe 的 `frameLocator` 链执行 overlay 注入、移除和文本断言；其余 OOPIF 用例需要 `Frame` 时改用 `oopifContentFrame()`，即按 owner 元素的 content frame 解析，不再按 URL 查找。

**验证**

- CI run 38781151262（首版修复）与 38783159288（最终代码，fence 收窄为仅 OOPIF 目标并对 hidden 文档立即失败）：各为 6 shard × `-g OOPIF --repeat-each 5`，均 150/150 通过，其中 affine 30/30、nested 30/30；
- 本地：typecheck、全部单测（含新增 fence / executor 顺序测试）、workspace build、10/10 Chromium E2E。

## Phase 6.6b-A：取消、撤销与 progress notification

- 新增 trusted RPC `authorization.cancel-strict-click { authorizationId }`：扩展先记有界 tombstone（默认 256 条），拒绝迟到的同 id issue / request / 企业签发；再撤销同 id 的未消费 grant（任意来源，`InMemoryAuthorizationStore.revoke` 改为返回是否删除了仍有效的 grant）；最后把同 id 的 pending approval 记为新状态 `cancelled`，已批准的 approval 仅在 grant 确实被撤销时翻为 `cancelled`；
- `authorization.request-operator-approval` 新增可选 `approvalTtlMs`（1..120000），扩展审批有效期取它与扩展上限的较小值，且不进入 grant 签发输入；
- broker 在 `authorizationId` 生成后，只要 act 未成功返回就尽力撤销一次；降级判断先于撤销 RPC 落定；撤销失败不覆盖原错误；
- MCP `tools/call` 把 `ctx.mcpReq.signal` 与 progress 回调经 adapter 传给 broker：入口已取消时零 RPC、不扣预算；等待审批与批准后、act 前的取消都会撤销；在途 act 不受取消影响；客户端提供 `progressToken` 时每次轮询到 `pending` 后发送只含递增计数与固定文本的 `notifications/progress`；
- 关闭 6.6a 残余风险“approval 超时后遗留 pending request”，SECURITY 中改写为收窄后的条目（cancel 不可达或失败、tombstone 被驱逐后迟到的 request）；
- 新增不变量 126、127。

### 门禁

- TypeScript typecheck ✅
- Unit / integration tests（528 个）✅
- Workspace build ✅
- Real Chromium E2E：本 PR 未改 E2E，由 CI browser-e2e 覆盖
- 方案经 think + check 两轮审查；代码经 check 深度审查与对抗式审查，发现的 LOW 已修复并复审：无 HIGH / MEDIUM ✅

## Phase 6.6b-B：扩展侧审批体验

- `OperatorApprovalStore` 新增 `subscribe`（pending 数量变化在 microtask 中合并通知，覆盖抛错路径，数量不变不通知）与 `nextExpiryAt`；
- 新增 `approvalBadge`：扩展图标角标显示待审批数（全局计数，只含数字）；按最早到期时间调度定时器，到点无条件触发过期清理并重新调度；service worker 启动时先重绘，清掉残留角标；
- 审批页：每张卡片显示请求短码与倒计时；页面派生文本（目标名称、role、页面标题）放在“不可信”虚线框内，删除控制 / 格式字符与变体选择符后加「」引号；origin 单独标注“浏览器提供”；
- 防误点：每 2 秒增量刷新，已有卡片不重排，新卡片追加到末尾并延迟 500 ms 启用，消失的卡片先原位禁用再移除，移除位置之后的卡片延迟启用；本页已处理的请求不再恢复为可点击；
- 带 query / hash 打开审批页时跳回干净地址；
- 新增不变量 128；Real Chromium E2E 覆盖角标增减、审批页渲染、自动追加、取消后原位失效再移除（已有卡片节点不变）与页内批准。

### 门禁

- TypeScript typecheck ✅
- Unit / integration tests（636 个）✅
- Workspace build ✅
- Real Chromium E2E 12/12 ✅（新用例本地连续重复 5 次与 3 次均通过）
- 方案经 think + check 审查（1 条 HIGH、4 条 MEDIUM 均在实现前并入方案）；代码经 check 审查与独立审查，无 HIGH / MEDIUM，LOW 已修复并复审 ✅

## Phase 6.6c：side-effect 集成测试与最终对抗式审查

- **wire 级集成测试**：新增 `sideEffect.wire.test.ts`（11 个用例）与测试 helper `src/testing/mcpWire.ts`、`src/testing/fakeTrustedRuntime.ts`；真实 MCP wire + 真实 CLI 组装 + 真实 HTTP 假 trusted RPC，覆盖暴露面、批准链路与 progress、出境脱敏、错误固定文本与撤销、客户端取消、预算与单次执行、act / frame origin plane、未出境 revision、降级、token 不出境、读路径错误原文；原 MCP 集成测试改用共享 helper；
- **端到端**：MCP 子进程（`apps/mcp-server/dist/cli.js`）经 stdio 驱动真实 native host + 扩展 + Chromium，覆盖 operator 批准后真实点击并 Verify 通过、progress、客户端取消后不点击、stdout 无协议污染；fixture 补充 `/done.html`；
- **最终对抗式审查**（范围 PR #11–#15）：无 CRITICAL / HIGH。修复：
  - M-1：observe / open / wait 等读路径的 trusted 错误原文会直达模型（当前扩展消息都是静态文本，无实际泄露，但无守护）→ `TrustedRuntimeHttpClient` 在所有路径只保留 code、message 固定化；act verification evidence 的 `reason` 也在 client 层丢弃；
  - L-1：frame 有效 origin 推导抽成 `frameOrigin.ts`，出境投影与 act broker 共用；
  - L-4：审批页新增禁止 HTML 解析写入接口的静态测试；
  - 未在本阶段处理、写入 SECURITY 已知限制：L-2 待审批池跨连接共享可被挤出、L-3 读路径无速率限制，以及审查 advisory 中同 tab 并发 act 的降级窗口；
- 新增不变量 129、130。

### 门禁

- TypeScript typecheck ✅
- Unit / integration tests（655 个）✅
- Workspace build ✅
- Real Chromium E2E 13/13 ✅（新用例本地重复运行通过）
- 方案经 think + check 审查；代码经 check 审查与独立审查，无 HIGH / MEDIUM，LOW 已修复并复审 ✅

## Phase 7-0a：决策评测 harness

方案见 `docs/TRACE-EVAL-FOUNDATION.md`（think 编写、check 审查一轮，6 条发现已在实现前并入方案）。

- `packages/eval` 新增 `DecisionFixture` / `validateDecisionFixtures`：kebab-case 唯一名称、有界 microGoal、操作空间限定为 `CLICK / HANDOFF_FORM / HANDOFF_VERIFY / ESCALATE`、CLICK target 必须可见启用可点击、element frame 必须已声明、actionable coverage 非 complete 时必须接受 ESCALATE；
- 参考 `observationOrderCandidateBuilder`：可见、启用、带 click capability 的元素按 observation 顺序，超过上限标 `truncated`，coverage 绝不提升；
- `runDecisionEvaluation`：先校验 fixture 与 ks，串行运行，输入深冻结；builder 输出逐 fixture 校验；报告 Recall@K、complete-action-space rate、conditional accuracy（click / nonClick）、safeFallback、unsafeClickRate 与按 tag 指标，空分母为 `null`；每个 fixture 按第一个失败的层归因；
- 第一批 14 个合成对抗 fixture，覆盖同名元素、替换节点、遮挡、禁用、截断、prompt 注入文本、破坏性相邻按钮、中英混排、child frame、表单与验证 handoff；
- 新增不变量 131～133；纯离线包，不改变任何运行期行为。

### 门禁

- `pnpm install --frozen-lockfile` ✅
- TypeScript typecheck ✅
- Unit / integration tests（692 个）✅
- Workspace build ✅
- Real Chromium E2E：本 PR 未改 E2E，由 CI browser-e2e 覆盖
- 不变量 132 变异验证：把候选集外 ref 改判为合法后，对应 2 个 harness 用例变红 ✅
- 代码经 check 审查与独立对抗式审查：8 条发现（2 MEDIUM：provider 返回值读取抛错会中断整轮评测、不变量 132 依赖未测试的冻结；4 LOW；2 advisory）全部修复，每条修复的回归用例均经变异验证由红转绿 ✅

## 下一步

1. Phase 7-0b：model-facing MCP 脱敏 trace + 有界 JSONL sink + trace 汇总（默认关闭），方案见 `docs/TRACE-EVAL-FOUNDATION.md`，待批准后开工。

## 文档

- `docs/MODEL-FACING-ADAPTER.md`：PR #5 模型信任边界与第一阶段设计；
- `docs/INVARIANTS.md`：新增 model-visible revision / projected verification 等不变量；
- `docs/ROADMAP.md`：Phase 6.5 按可验证子阶段推进；
- `docs/MODEL-FACING-ADAPTER.md`：新增「Act broker」一节；
- `docs/SECURITY.md`：新增「Model act broker 边界」一节。


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


### PR #7 第二小步：session-aware exact mapping

- `ExactFrameMapping` 新增可选 `cdpSessionId`；
- root frame tree 与已登记 iframe child-session frame tree 组成 CDP candidate 集；
- OOPIF mapping 仍只通过 `frameEpoch` exact equality，URL/顺序/名称不参与；
- 同一 frameEpoch 跨多个 CDP session/frame 出现时 fail closed；
- `Accessibility.getFullAXTree` 对 OOPIF 必须发送到 mapping 指定的 child session；
- AX source 保存 `webFrameId → cdpSessionId` provenance；
- backendDOMNodeId → stableId linking 使用同一 exact child session；
- lifecycle binding 同时保留 frameEpoch / cdpFrameId / cdpSessionId / documentEpoch；
- root-session 原有行为保持兼容。


### PR #7 第三小步：Real Chromium OOPIF E2E

新增跨站 fixture：

```text
main:  http://127.0.0.1:4173/oopif-main.html
child: http://localhost:4173/oopif-child.html
Chromium: --site-per-process
```

E2E 要求：

- OOPIF child 元素最终具备 DOM + AX provenance；
- actionable coverage 必须达到 complete；
- OOPIF reload 后 child Persistent Ref 必须变化；
- main frame Persistent Ref 必须保持；
- 测试允许首次 attach/auto-attach 的短暂 partial observation，通过 bounded retry 等待 exact child session 建立。


### PR #7 第三小步：Strict resolver session-aware child revalidation

- `DomLifecycleRegistry` 新增只读 `bindingForFrame(tabId, frameId)`，返回 observation 已证明的 exact frame/session binding 副本；
- `IsolatedWorldDomStableIdInspector` 支持显式 `cdpSessionId`，child DOM inspection 的 Runtime 命令只发送到对应 flat session；
- Strict resolver 不再仅按 `web:0` 入口判断 child target；
- resolver 会同时校验：
  - retained observation 中的 target frame/documentEpoch；
  - 当前 webNavigation catalog 的同 frame documentEpoch；
  - lifecycle 记录的 frameEpoch / cdpFrameId / cdpSessionId / documentEpoch；
  - retained DOM + AX strong identity；
- backendDOMNodeId → stableId、DOM inspection、partial AX tree 都使用同一个 exact child session；
- child live identity 即使全部通过，在 top-level coordinate projection 完成前仍返回 fail-closed，不生成 prepared dispatch target；
- main-frame Strict Click 行为保持不变。


### PR #7 第四小步：child-frame 顶层坐标投影核心

新增独立 `ChildFrameCoordinateProjector`，暂不直接修改 dispatch：

- 沿 retained observation 的 `parentFrameId` 从 target child 逐层走到 `web:0`；
- 每层必须存在 lifecycle 保存的 exact `frameEpoch / cdpFrameId / cdpSessionId / documentEpoch`；
- 每层实时从对应 exact isolated-world context 验证 `frameEpoch`，并读取 `innerWidth / innerHeight`；
- frame owner 只通过父 CDP session 的 `DOM.getFrameOwner(childCdpFrameId)` 获取；
- frame owner 几何只使用 `DOM.getBoxModel().model.content`；
- 支持可证明的 2D affine content quad（平移 / 缩放 / 旋转 / skew）；
- perspective / 非平行四边形 / 退化 quad 直接 fail closed；
- child-local point 必须位于实时 child viewport 内；
- 最终 projected point 必须位于实时 root viewport；
- root 层额外用 `document.elementFromPoint()` 验证 projected point 仍命中最外层 frame owner；
- 任一 document binding stale、session/isolated-world identity 缺失、owner/geometry/hit-test 失败都不返回 projected target。

projector 已接入 Strict resolver 的成功分支；child-frame actuation 已通过后续真实 Chromium E2E 闭环验证。


### PR #7 第五小步：projection → Strict prepare

- `ChromeStrictMainFrameClickResolver` 在 child DOM+AX live identity 复核通过后调用 `ChildFrameCoordinateProjector`；
- projection 失败继续返回 identity mismatch，Strict coordinator 不会产出 prepared target；
- projection 成功后 child target 首次可以产出 `identityMatches=true`；
- child prepared point 使用投影后的 top-level viewport 坐标，不再携带 child-local point；
- `PreparedStrictClickTarget` 新增固定 `coordinateSpace: "top-level-viewport"`；
- main-frame prepared target 同样显式标记为 top-level viewport；
- `ChromeStrictClickDispatcher` 在任何 `Input.dispatchMouseEvent` 前再次检查 coordinate space，非顶层坐标直接 fail closed；
- trusted execution 原有“双 prepare”机制保持不变，因此真正 dispatch 前会重新完成 child identity + projection。


### PR #7 第六小步：真实 OOPIF child Strict Click dispatch E2E

新增 trusted-host Real Chromium 场景：

```text
browser.open(agent-owned OOPIF page)
→ browser.observe(hybrid)
→ child ref has DOM + AX provenance
→ authorization.issue-strict-click
→ browser.act
→ second Strict prepare
→ child local point projected to top-level viewport
→ root Input.dispatchMouseEvent
→ OOPIF child receives real click
→ fresh Observe + Verify(text_present="OOPIF Clicked")
```

Fixture 中 OOPIF child button 只有收到真实 click 后才把文本改成 `OOPIF Clicked`，因此验证结果可以直接证明 root-session mouse dispatch 最终命中了 child target，而不是只证明 prepare 成功。

该 E2E 已在 GitHub Actions Run #130 通过，真实证明 root-session Input.dispatchMouseEvent 可以命中 OOPIF child target。


### PR #7 第七小步：reload / detach fail-closed E2E

继续覆盖授权签发后的结构竞态：

1. 对 OOPIF child ref 签发短期 grant 后立即 reload child document；
2. 使用旧 observedRevision/ref/grant 调用 `browser.act`；
3. 必须在 dispatch 前以 `TARGET_IDENTITY_MISMATCH` 拒绝；
4. 重新 Observe 得到新 child ref 并重新授权；
5. 移除顶层 iframe，使 OOPIF target/session detach；
6. 再用旧 observation/ref/grant 调用 `browser.act`；
7. 必须在 dispatch 前以 `DOCUMENT_CHANGED` 拒绝。

这两条验证 Strict prepare 的 freshness 与 lifecycle grant revocation 是双保险：页面结构改变后既不能复用旧强身份，也不能靠尚未消费的 grant 继续执行。
- `docs/PR7-FINAL-REVIEW.md`：PR #7 OOPIF / child-frame actuation 最终对抗式审查。
