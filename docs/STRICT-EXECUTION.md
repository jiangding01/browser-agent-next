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
- CDP mouse dispatch primitive；
- ambiguous dispatch outcome 显式建模。

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

Agent、页面文本、模型 confidence 都不能自己签发 grant。

## Origin Policy

Auto-act origin 使用 exact allowlist：

```text
scheme + host + port
```

不允许 wildcard、suffix 或 substring 匹配。

默认空 allowlist，即 fail closed。

## 授权生命周期

Grant 有 TTL、默认 single-use，并会在 main/child navigation 或 tab removal 时主动撤销。

## Prepare / Authorize / Commit

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

commit 前的第二次 prepare 用于重新验证 document、strong identity、DOM stableId、AX semantics、actionability、viewport 和 hit-test。

## Ambiguous Outcome

浏览器输入不是事务。

如果：

```text
mouseMoved  ✅
mousePressed ✅
mouseReleased ❌
```

就不能断言“动作没发生”。

页面可能已经处理 `pointerdown/mousedown`，也可能在 release 失败前触发其他副作用。

因此 Runtime 返回：

```text
ACTION_OUTCOME_UNKNOWN
```

并明确禁止自动 retry。

只有明确证明输入尚未进入可能影响页面的阶段，失败才可以由更高层决定是否重新 prepare。

## 当前还没有公开 execute 命令

Mouse dispatcher 和 policy executor 已经存在，但仍未通过 extension message / MCP 暴露给 Agent。

原因是 trusted authorization 的签发链路还没有实现。

## 下一步

1. trusted-host authorization ingress；
2. 内部 execute message，只接受有效 grant；
3. post-action Verification；
4. 真实 Chromium policy-gated execution E2E。
