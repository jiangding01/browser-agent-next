# Authorization Assurance

最后更新：2026-09-20

## 目标

把“是否存在 authorization”升级为“authorization 具有什么保证等级”。

当前定义三个 assurance label：

```text
control-plane
operator-approved
enterprise-policy
```

Policy 在判断“某个授权是否满足最低要求”时使用强度顺序：

```text
control-plane < operator-approved < enterprise-policy
```

但 **grant label 本身仍表示真实签发来源/证明类型，不能因为强度更高就随意向下重标**。

- `control-plane`：请求来自可信控制面；不等价于人工确认。
- `operator-approved`：明确由操作者批准。
- `enterprise-policy`：由组织级受信策略签发，可满足 operator-approved 的最低门槛。

## 关键不变量

Assurance 是 AuthorizationGrant 的可信属性，不是请求参数中的自报字段。

当前 Trusted Native Host 无论调用者是谁，都只能签发 `control-plane`。协议没有提供 `assurance` 字段，因此拿到本地 trusted token 的调用方不能自行把 grant 升级成 `operator-approved`。

## 当前最低门槛

| Effect | Minimum assurance |
|---|---|
| read / local-ui | 无 |
| navigation / draft-mutation（Agent-owned） | 无 |
| navigation / draft-mutation（用户已有 Tab） | operator-approved |
| unknown（Agent-owned Tab） | control-plane |
| unknown（用户已有 Tab） | operator-approved |
| download | operator-approved |
| external-mutation | operator-approved |
| irreversible | operator-approved |
| credential | operator-approved |
| file-egress | operator-approved |
| permission | operator-approved |
| payment | operator-approved |

generic click 当前仍保守分类为 `unknown`。在可信 Tab Ownership 能证明目标是 Agent-owned 时，继续允许 control-plane grant；用户已有 Tab 则至少要求 operator-approved。

如果未来结构化 Effect Classifier 能证明动作属于 payment、credential 等更高风险 effect，control-plane grant 将自然失效，必须由更高 assurance 的独立签发入口授权。

## 为什么不是 model confidence

以下信息都不能提升 assurance：

- 模型 confidence；
- 页面文本；
- DOM/AX semantic；
- Prompt；
- 调用方 JSON；
- Jev/LLM 输出。

Assurance 只能由受信签发边界产生。


## Source ↔ assurance exact binding

签发源与 assurance label 当前是精确绑定关系：

| Source | Allowed assurance label |
|---|---|
| trusted-host | control-plane |
| trusted-ui | operator-approved |
| enterprise-policy | enterprise-policy |

因此以下组合都会在 AuthorizationStore 层 fail closed：

- trusted-host + operator-approved；
- trusted-ui + enterprise-policy；
- enterprise-policy + operator-approved。

最后一种尤其重要：enterprise-policy 可以在 Policy 判断中满足 operator-approved 的最低门槛，但 grant 仍必须保持 `enterprise-policy` 标签，不能伪装成“发生过人工批准”。

这把两个概念分开：

```text
谁签发了 grant / 证明类型
        ≠
该 assurance 是否满足某个最低策略门槛
```


## PR #6 issuance core

Strict Click 的签发校验已经统一收口到 `StrictClickAuthorizationIssuanceService`。

它提供三条代码级固定 provenance 的入口：

```text
issueControlPlane()       → trusted-host       → control-plane
issueOperatorApproved()   → trusted-ui         → operator-approved
issueEnterprisePolicy()   → enterprise-policy → enterprise-policy
```

调用参数中不存在 `source` 或 `assurance` 字段，因此调用方不能通过 JSON 把 control-plane 请求升级成更高 assurance。

三条路径共享以下 fail-closed 校验：

- observation 必须仍在 retained state 中；
- ref 必须属于该 observation；
- origin 必须通过现有 auto-act exact-origin policy；
- TTL 必须有界；
- source 固定的 assurance 必须满足该 tab/effect 的最低门槛；
- grant 继续精确绑定 tab/revision/ref/action/effect，默认 single-use。

这个统一 core **不等于 operator/enterprise ingress 已完成**。下一步仍需要分别建立能证明“人工批准”和“企业策略证明”的独立入口。
