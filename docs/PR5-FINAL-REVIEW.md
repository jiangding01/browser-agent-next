# PR #5 Final Adversarial Review

更新日期：2026-09-20

## 结论

PR #5 的目标是建立真正独立的 **Model-facing Adapter Boundary**，而不是把 trusted native-host RPC 包装成 MCP tools。

最终审查未发现需要阻止本阶段合并的设计或实现 blocker。

本 PR 已经形成如下安全边界：

```text
LLM / MCP client
      ↓
explicit MCP tool catalog
      ↓
bounded input validation
      ↓
Model-facing Browser Adapter
      ├─ model navigation policy
      ├─ model read / egress policy
      ├─ projected revision store
      └─ projected extract / verify / wait
      ↓
minimal Trusted Runtime client
      ├─ browser.open
      └─ browser.observe
      ↓
loopback trusted RPC
      ↓
Native Host / Extension Runtime
```

`browser.act`、authorization issuance、auto-act policy mutation、raw CDP 与 generic trusted RPC 均不属于本 PR 的 model-facing surface。

---

## 1. Tool exposure

### 审查问题

- 新增 trusted RPC 是否可能自动成为 MCP tool？
- 客户端能否绕过 `tools/list` 手工调用隐藏 tool？
- model tool catalog 是否可在运行时被篡改？

### 结果

通过。

- tool catalog 是显式静态定义；
- 最终仍由 `ModelToolExposurePolicy` 过滤；
- definitions 深度冻结；
- `tools/call` 会再次检查当前 catalog allowlist；
- wire-level integration 已验证未暴露 tool 返回 `POLICY_BLOCKED`，不会进入 invoker。

不存在“扫描内部 RPC 自动注册”的路径。

---

## 2. Model-egress 与 hidden-state side channel

### 审查问题

模型是否可以通过以下方式读取未允许出境的数据：

- internal retained revision；
- cross-origin child frame；
- `browser.verify` true/false probing；
- `browser.wait` 在隐藏 frame 上提前满足；
- verification evidence 中的 observed value；
- Runtime delta / page-declared capabilities。

### 结果

通过。

只有成功完成 model-egress projection 的 observation 才能进入 model-visible revision store。

`browser.extract / browser.verify / browser.wait` 都在 projected observation 上执行，不直接访问 trusted Runtime 的完整 retained state。

未 allowlist 的 child frame：

- URL 不出境；
- elements 不出境；
- coverage 降级为 partial；
- “模型没看到”不能被解释为“不存在”。

values 默认关闭；verification evidence 会去除 `observed` 字段。

Runtime delta 与 page-declared capabilities 当前也不进入模型。

---

## 3. Policy plane separation

以下三个策略面保持独立：

```text
Model Read / Egress Policy
Model Navigation Policy
Runtime Auto-act Policy
```

审查确认：

- read allow 不推导 navigation allow；
- navigation allow 不推导 read allow；
- 两者都不推导 auto-act allow；
- operator 配置只能在进程启动控制面注入；
- model tool arguments 不能修改 policy；
- origin 使用 exact-origin 语义，拒绝 path/query/fragment/credentials 配置扩大。

默认 read/navigation origin 集合为空，保持 fail closed。

---

## 4. Trusted Runtime client

### Public surface

当前只有：

```text
open()
observe()
```

没有 public generic `callTrusted(type, payload)`。

因此 MCP adapter 无法借 client 调用：

- authorization.issue-*；
- policy mutation；
- execution internal RPC；
- future trusted control-plane methods。

### Transport

通过：

- endpoint 只允许 loopback；
- HTTP redirect 禁止；
- Bearer token 不进入 URL；
- token file 拒绝 symlink、错误 owner 与过宽 POSIX 权限；
- MCP 侧只读取现有 token，不负责创建/轮换；
- response requestId 必须精确匹配；
- response body 有显式字节预算；
- response 有结构验证；
- unknown Runtime error code 不直接透传为可信语义。

### Ambiguous outcome

`browser.open` 是有副作用操作。

请求发出后如果 transport 失败，client 返回：

```text
ACTION_OUTCOME_UNKNOWN
```

上层不能把它当作安全可重试操作。

`browser.observe` 的同类失败使用 `STATE_INCOMPLETE`。

---

## 5. MCP stdio transport

当前使用官方 MCP TypeScript SDK v2：

```text
@modelcontextprotocol/server@2.0.0
serveStdio(factory)
```

connection factory 每个连接创建独立 adapter/invoker，因此 model-visible revision store 不跨连接共享。

stdout 只作为 MCP protocol channel；startup failure 写 stderr。

Tool result 默认限制为 256 KiB，配置最大 1 MiB。

错误出境只包含 bounded code/message：

- 不返回 BrowserRuntimeError.details；
- 不返回 stack；
- 未知异常不返回原始 message。

真实 stdio pipe integration 已覆盖：

- initialize；
- notifications/initialized；
- tools/list；
- tools/call；
- hidden tool rejection；
- connection-pinned factory instance。

---

## 6. Input / output bounds

模型输入同时经过：

1. MCP JSON Schema；
2. runtime validator。

两层共享 `MODEL_INPUT_LIMITS`。

当前包括：

- strings；
- refs；
- element count；
- verification condition count；
- timeout；
- polling interval；
- bounded JSON recursion；
- object additionalProperties。

MCP response、trusted Runtime response 与 model observation candidate count 也都有独立预算。

---

## 7. Dependency reproducibility

最终收口时发现 `package.json` 已加入 MCP SDK，但 lockfile 尚未同步。

已使用 CI 实际 pnpm resolution 生成准确 lockfile 差异，并写回：

- `@modelcontextprotocol/server@2.0.0`
- `@modelcontextprotocol/core@2.0.0`
- `zod@4.6.5`

随后 CI 从：

```text
pnpm install --no-frozen-lockfile
```

升级为：

```text
pnpm install --frozen-lockfile
```

最终 frozen install 已通过。

---

## 8. browser.act 为什么不在 PR #5

这不是功能遗漏。

当前 Strict Click 依赖 authorization grant，而模型不能直接：

- mint authorizationId；
- 声明 assurance；
- 调用 authorization issuance。

如果现在直接把 `browser.act` 注册为 MCP tool，要么工具不可用，要么必须错误地把 grant 能力暴露给模型。

因此本 PR 保持：

```text
browser.act → model-facing invisible
```

后续单独进入 **Model-facing side-effect authorization** 阶段，先实现不可由模型直接 mint 的 scoped authorization broker，再讨论 MCP side-effect tool。

---

## 9. Merge gate

最终 HEAD 必须同时满足：

- [x] pnpm frozen-lockfile install
- [x] TypeScript typecheck
- [x] unit tests
- [x] MCP catalog / adapter tests
- [x] trusted Runtime client tests
- [x] MCP stdio wire integration
- [x] workspace build
- [x] Real Chromium E2E
- [x] docs / roadmap / invariants synchronized
- [x] no generic trusted RPC model surface
- [x] browser.act remains fail closed at model boundary

## 最终判断

PR #5 已达到本阶段合并条件。

合并后建议下一阶段优先处理：

1. operator-approved / enterprise-policy 独立签发 ingress；
2. 再独立设计 model-facing scoped authorization broker；
3. OOPIF / child-frame actuation；
4. Intelligence Layer（deterministic router / Jev / shadow / fast path）。
