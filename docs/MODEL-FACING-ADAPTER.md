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

## 后续工作

PR #5 接下来继续：

1. 为上述工具建立 MCP input schema/catalog；
2. 增加真实 MCP stdio transport；
3. 增加 model-facing adapter ↔ trusted Runtime client；
4. 增加 MCP 层集成测试；
5. 设计 browser.act 的内部 scoped authorization broker，确认模型无法直接 mint grant 后再开放副作用工具。
