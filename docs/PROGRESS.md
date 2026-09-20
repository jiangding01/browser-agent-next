# 实现进度

最后更新：2026-09-20

## 当前分支

```text
main
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception        ✅ 已合并
PR #2 Hybrid + Strict Click              ✅ 已合并
PR #3 Child-frame Hybrid                 ✅ 已合并
Authorization Assurance                  ✅
browser.open + Tab Ownership Registry    ✅
browser.observe                          ✅
browser.verify                           ✅
browser.wait event-assisted + bounded fallback ✅
browser.act / Strict Click               ✅
browser.extract                          ✅ retained projection
Real Chromium High-level API E2E         ✅
event-assisted wait wake-up               ✅
PR #4 Final Adversarial Review            ✅
```

## PR #4 当前完成内容

- AuthorizationAssurance：control-plane / operator-approved / enterprise-policy；
- grant consume 按 minimum assurance 校验；
- trusted-host 只能签发 control-plane，不能由请求自报升级；
- unknown effect 在用户已有 Tab 上提升到 operator-approved，落实“用户已有 Tab 默认更严格”；
- browser.open 通过真实 chrome.tabs.create mint Agent-owned tab；
- Tab Ownership Registry 不提供 caller claim，未知 tab 与 MV3 restart 后均安全降级为 user-existing；
- 高层 browser.observe 默认 Hybrid；
- 高层 API 不接受 caller supplied ownedBySession，ownership 只来自 browser.open；
- browser.extract 只投影指定 retained revision，refs/maxItems 有界且显式返回 missing/truncated；
- browser.verify 只验证指定 retained revision；
- browser.wait 只重复 fresh observation + verification，不执行动作；
- browser.act 第一版只接 Strict Click；
- trusted protocol 对 API 输入做数量、timeout、poll interval 等边界校验；
- 真实 Chromium trusted E2E 已改为通过 browser.open / observe / verify / wait / act 驱动完整主闭环；
- E2E 同时验证用户已有 Tab 仍要求 operator-approved，而 browser.open 创建的 Tab 可由 control-plane grant 驱动 Strict Click。

## 当前边界

`browser.wait` 使用 DOM mutation / navigation signal 提前唤醒，并保留 bounded timeout fallback。signal 只负责 pacing，不是 correctness proof；每次唤醒后仍必须 fresh Observe + Verify。

`browser.act` 只支持 main-frame Strict Click；child-frame actuation 继续 fail closed。

## 本轮已完成

- 新增 DOM mutation + navigation change signal；
- signal 只包含 frameEpoch/sequence，不携带 DOM 文本、属性值或用户输入；
- browser.wait 在 Observe 前记录 signal cursor，避免 observation 窗口丢事件；
- signal 到达后只提前唤醒，仍必须重新 Observe + Verify；
- 没有 signal 时保留 bounded timeout fallback，因此 signal 不是 correctness proof。

## 后续工作

1. 完成模型侧 MCP adapter、model-egress/navigation policy 与显式工具暴露边界；
2. 完成 operator-approved / enterprise-policy 的独立签发 ingress；
3. 实现 child-frame coordinate projection / actuation。

## 最终边界澄清

- `browser.*` 当前是 trusted control-plane 内的 High-level Runtime facade；
- 它不是最终 LLM/MCP trust boundary；
- Future MCP adapter 必须单独实施 model-egress/navigation policy；
- MCP 不能向模型暴露 policy mutation / authorization issuance；
- model-egress policy 与 auto-act policy 继续保持分离。

## 合并状态

PR #4 已合并。当前 main 包含 Authorization Assurance、高层 `browser.*` API、event-assisted wait 与对应的真实 Chromium E2E；后续改动仍需通过项目验证门禁。
