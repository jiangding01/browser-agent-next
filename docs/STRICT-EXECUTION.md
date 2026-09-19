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
- ambiguous dispatch outcome 显式建模；
- observation-based verification engine。

## Verification 不是 DONE

Agent / Model 不能通过输出 `DONE` 证明任务完成。

当前 verification engine 对条件给出：

```text
pass
+ conclusive
```

因此可以区分：

```text
false + conclusive
= 已经有证据证明条件不成立

false + inconclusive
= 当前 observation 不足以证明成立或不成立
```

例如：

- complete action space 中 ref 不存在，可以证明 `ref_absent`；
- partial action space 中 ref 没出现，不能证明它不存在；
- text coverage=unknown 时“没看到文字”不能等价于文字不存在；
- download/network 没有事件源时返回 inconclusive，而不是伪造失败。

URL / title 的 `pattern` 当前使用有界 glob（`*` / `?`），不是任意 RegExp，避免把 Agent 输入直接交给潜在 ReDoS 正则。

## 授权边界

Generic click 的真实业务副作用，通常无法仅凭 DOM / AX 结构在执行前证明。

因此当前策略是：

```text
generic click
→ effect = unknown
→ 无 hard authorization
→ 不执行
```

只有 trusted control plane 已经对完整 tab/revision/ref/action/effect 绑定签发短期 grant，才允许继续。

## Origin / lifecycle

Auto-act origin 使用 exact scheme+host+port allowlist，默认空集合。

Grant 有 TTL、默认 single-use，并在 main/child navigation 或 tab removal 时主动撤销。

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
      ↓
fresh observation
      ↓
verification
```

当前最后两步还没有串成公开 execute 命令；verification engine 已具备纯状态验证能力。

## Ambiguous Outcome

如果 mousePressed 已成功而后续 release 失败，Runtime 返回：

```text
ACTION_OUTCOME_UNKNOWN
```

禁止自动 retry。

## 下一步

1. trusted-host authorization ingress；
2. 内部 execute message，只接受有效 grant；
3. 把 fresh observation + verification 接到 execute pipeline；
4. 真实 Chromium policy-gated execution E2E。
