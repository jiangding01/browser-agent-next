# Authorization Assurance

最后更新：2026-09-20

## 目标

把“是否存在 authorization”升级为“authorization 具有什么保证等级”。

当前等级按最低保证强度排序：

```text
control-plane
      <
operator-approved
      <
enterprise-policy
```

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
