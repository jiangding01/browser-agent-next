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
- 🚧 第十一小步：nested OOPIF 中间 owner overlay fail-closed / 解除遮挡后真实点击 E2E 已实现，等待 CI；
- 🚧 Real Chromium OOPIF / child-frame actuation 最终对抗式 Review 收口中。

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

1. 第二小步通过完整 CI 后补 Real Chromium OOPIF exact-mapping 场景；
2. 固化 frame-owner exact identity；
3. 设计 nested frame viewport → root viewport 坐标投影；
4. 接入 child-frame Strict Click prepare/dispatch；
5. model-facing `browser.act` 继续保持不可见，Phase 6.6 独立推进。

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

当前仍未将 projector 接入 Strict resolver 的成功分支，所以 child-frame actuation 尚未开放。


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
