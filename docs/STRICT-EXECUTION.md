# Strict Execution

## 当前状态

PR #2 已经完成：

- stored observation strict coordinator；
- main-frame DOM+AX linked live identity resolver；
- fresh DOM actionability / viewport / hit-test；
- fresh AX role/name/disabled 检查；
- Strict Prepare 真实 Chromium E2E；
- policy-gated click commit 基础设施；
- trusted authorization grant store；
- exact-origin allowlist；
- navigation/tab lifecycle 自动撤销 grant；
- commit 前二次 strict prepare；
- CDP mouse dispatch primitive。

## 授权边界

Generic click 的真实业务副作用，通常无法仅凭 DOM / AX 结构在执行前证明。

因此当前策略是：

```text
generic click
→ effect = unknown
→ 无 hard authorization
→ 不执行
```

只有 trusted control plane 已经对以下完整绑定签发短期 grant：

```text
tabId
+ observedRevision
+ ref
+ actionKind
+ effectClass
```

才允许继续。

Grant source 只能是：

- trusted-ui
- trusted-host

Agent、页面文本、模型 confidence 都不能自己签发 grant。

## Origin Policy

Auto-act origin 使用 exact allowlist：

```text
scheme + host + port
```

不允许 wildcard、suffix 或 substring 匹配。

例如允许：

```text
https://example.com
```

并不允许：

```text
http://example.com
https://example.com:8443
https://evil.example.com
```

默认空 allowlist，即 fail closed。

## 授权生命周期

Grant 不仅有 TTL 和 single-use，还随 browser lifecycle 主动撤销。

当前任何：

- main navigation；
- child-frame navigation；
- tab removal；

都会清除该 tab 尚未消费的授权。

这是刻意保守的：grant 绑定 observedRevision，页面拓扑变化后不应继续有效。

## Prepare / Authorize / Commit

当前执行链路：

```text
stored observation
      ↓
strict prepare #1
      ↓
effect assessment
      ↓
origin policy
      ↓
trusted authorization
      ↓
strict prepare #2
      ↓
mouse dispatch
```

为什么要 prepare 两次：

授权检查不是原子操作。页面可以在第一次 prepare 和最终 dispatch 之间变化。

因此不能复用第一次的 point；commit 前重新：

- 验证 document；
- 验证 strong identity；
- 验证 DOM stableId；
- 验证 AX role/name；
- 验证 visible/enabled；
- 验证 viewport；
- 验证 hit-test。

## 当前还没有公开 execute 命令

Mouse dispatcher 和 policy executor 已经存在，但仍未通过 extension message / MCP 暴露给 Agent。

原因是 trusted authorization 的签发链路还没有实现。

这意味着当前系统已经具备“执行 primitive”，但 Agent 暂时没有直接触发真实 click 的入口。

这是刻意的安全边界。

## 下一步

1. trusted-host authorization ingress；
2. 内部 execute message，只接受有效 grant；
3. post-action Verification；
4. 非幂等结果不明确时禁止自动 retry；
5. 真实 Chromium policy-gated execution E2E。
