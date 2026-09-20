# 实现进度

最后更新：2026-09-20

## 当前分支

```text
feat/model-facing-mcp-adapter
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception        ✅ 已合并
PR #2 Hybrid + Strict Click              ✅ 已合并
PR #3 Child-frame Hybrid                 ✅ 已合并
PR #4 Authorization + High-level API     ✅ 已合并
PR #5 Model-facing Adapter Boundary      🚧 进行中

Model tool exposure allowlist             ✅ baseline
Model read / navigation origin policy     ✅ baseline
Model-visible revision store              ✅ bounded
Egress projection / value redaction       ✅ baseline
Cross-origin child-frame egress filtering ✅ baseline
Projected extract / verify / wait         ✅ baseline
MCP tool schema/catalog                    ✅
MCP stdio transport                        ⏳
Model-facing Runtime client                ⏳
Safe browser.act authorization broker      ⏳
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

## 当前边界

Runtime `browser.wait` 已支持 event-assisted wake-up；但 model-facing `browser.wait` 第一阶段故意只在 projected observation 上做 bounded polling + verify，避免 Runtime 完整 observation 形成模型不可见数据的 verification side channel。

Runtime `browser.act` 仍可在 trusted control plane 内使用；model-facing adapter 当前不暴露它。后续只有在 scoped authorization broker 不能被模型直接调用或自报 assurance 的前提下才开放副作用工具。

child-frame actuation / OOPIF session exact mapping 仍按既有 Roadmap 独立推进，不在 PR #5 第一阶段隐式放宽。

## 下一步

1. 实现真实 MCP stdio transport；
2. 实现 MCP adapter → trusted Runtime 的最小 client，只映射允许的 Runtime 方法；
3. 增加 MCP transport 集成测试与失败路径测试；
4. 最后再设计 `browser.act` 的内部 scoped authorization broker。

## 文档

- `docs/MODEL-FACING-ADAPTER.md`：PR #5 模型信任边界与第一阶段设计；
- `docs/INVARIANTS.md`：新增 model-visible revision / projected verification 等不变量；
- `docs/ROADMAP.md`：Phase 6.5 按可验证子阶段推进。
