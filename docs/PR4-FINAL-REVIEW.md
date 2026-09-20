# PR #4 最终对抗式审查

审查日期：2026-09-20

## 结论

PR #4 已形成两个清晰的阶段成果：

1. **Authorization Assurance**：把“有无授权”升级为有来源约束的 assurance；
2. **High-level Browser Runtime API**：把底层 Perception / State / Strict Executor / Verification 收敛为稳定的高层原语。

在当前明确边界内，未发现需要阻止该阶段合并的设计 blocker。最新 HEAD 仍必须以 CI + Real Chromium E2E 全绿作为最终合并门禁。

## 1. Authorization Assurance

当前 assurance：

```text
control-plane
operator-approved
enterprise-policy
```

Policy 可用强度关系：

```text
control-plane < operator-approved < enterprise-policy
```

但 grant 的实际 label 不能被重新标记。

Source 与 label 精确绑定：

```text
trusted-host       → control-plane
trusted-ui         → operator-approved
enterprise-policy  → enterprise-policy
```

这避免了“enterprise-policy 虽然足以满足 operator-approved 最低门槛，就伪装成人工点过确认”的语义污染。

## 2. 用户已有 Tab 更严格

generic click 仍分类为 `unknown`。

```text
Agent-owned tab   → minimum control-plane
user-existing tab → minimum operator-approved
```

Trusted Host 当前只能签发 control-plane，因此无法在用户已有 Tab 上为 unknown click 自行升级授权。

## 3. Ownership 不能由调用方声明

`browser.open` 是当前唯一可 mint Agent-owned Tab 的高层入口。

ownership 来自真实 `chrome.tabs.create` 返回的 tabId。

不存在：

- `ownedBySession=true` caller 参数；
- `claim(tabId)`；
- 根据 URL / tab title 推断 ownership。

MV3 service worker restart 后内存 registry 消失，已有 Tab 自动降级为 user-existing。

## 4. browser.observe

默认 Hybrid profile。

高层调用方不能注入 ownership。

candidate 上限显式受限，超过 observation profile 的页面通过 coverage/truncated 暴露，而不是假装完整。

## 5. browser.extract

只投影指定 retained observation：

```text
tabId + observedRevision
```

不接受 CSS/XPath/任意 JS，也不绕过 BrowserState 重新扫描 live DOM。

missing ref 不是页面 absence proof；是否能证明 absence 仍取决于 observation coverage。

## 6. browser.verify

只验证指定 retained revision，不偷偷 fresh observe。

这使：

```text
Verify stored state
```

和：

```text
Wait for future live state
```

成为两个不同操作。

## 7. browser.wait

当前已从纯 polling baseline 升级为 event-assisted wait：

```text
DOM mutation / navigation signal
          ↓
        wake-up
          ↓
    Fresh Observe
          ↓
        Verify
```

关键约束：

- signal 不携带页面文本、attribute value 或用户输入；
- signal 仅负责 pacing；
- signal 不能证明任务完成；
- cursor 在 Observe 前记录，降低 observe-window lost wake-up；
- waiter 注册后再次检查 version，关闭 check→subscribe race；
- signal 丢失时仍有 bounded timeout fallback；
- wait 永远不执行 action。

## 8. browser.act

第一版只支持已经经过 Strict Executor 对抗测试的 click。

必须提供 retained revision/ref、authorization 和独立 VerificationSpec。

非 click 不会降级到 compatible/raw CDP 路径。

## 9. Trusted Control Plane 与最终 Model Boundary

这是本轮审查中最重要的边界澄清。

当前 `browser.*` 通过 trusted Native Host 暴露，它是 high-level Runtime facade，不是最终 LLM/MCP trust boundary。

现有 trusted RPC 同一 control-plane 还拥有：

- auto-act origin policy mutation；
- control-plane grant issuance；
- strict dispatch。

因此未来 MCP adapter **不能把整个 trusted RPC surface 原样暴露给模型**。

正确结构：

```text
LLM / Agent
    ↓
MCP Adapter
    ├─ tool exposure policy
    ├─ model-egress policy
    └─ navigation/data policy
    ↓
browser.* Runtime facade
    ↓
Trusted control plane
```

MCP adapter 必须明确隐藏 policy mutation / authorization minting，并在 observation/extract 数据进入模型前执行独立 egress policy。

## 10. model-egress 与 auto-act 必须分离

当前 `browser.open` 在 trusted control plane 内可以打开 credential-free http/https URL。

这不是最终模型导航授权。

未来模型层至少需要两个独立 policy plane：

```text
Model Egress / Read Policy
Auto-act / Side-effect Policy
```

“模型可以读取页面”绝不意味着“模型可以在该页面自动点击并产生副作用”。

## 11. 真实 Chromium 验证

PR #4 已覆盖：

- user-existing Tab 默认非 owned；
- control-plane grant 无法满足 user-existing unknown click；
- browser.open 创建 Agent-owned Tab；
- browser.observe Hybrid；
- browser.extract retained projection；
- browser.verify retained revision；
- browser.wait；
- browser.act Strict Click；
- same-looking replacement 仍 fail closed；
- DOM mutation signal 提前唤醒 browser.wait 后仍重新 Observe + Verify。

## 非 blocker / 后续工作

- operator-approved 真实 UI 签发入口；
- enterprise-policy 签发入口；
- MCP server / model-egress policy；
- OOPIF exact session mapping；
- child-frame coordinate projection / actuation；
- Jev shadow / fast_step。

这些能力未实现时不能被宣传为已具备；当前路径保持 fail closed 或根本不暴露。

## 合并门槛

PR #4 可合并前必须同时满足：

- typecheck ✅
- unit tests ✅
- build ✅
- Real Chromium E2E ✅
- event-assisted wait E2E ✅
- no merge conflicts ✅
- 最新 HEAD CI 全绿
- 本文档与 INVARIANTS / PROGRESS / ROADMAP 同步
