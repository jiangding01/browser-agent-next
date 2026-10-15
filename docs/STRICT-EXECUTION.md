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
presentation fence（仅当目标位于 OOPIF）
      ↓
strict prepare #3（identity 与 top-level 点必须与 #2 一致）
      ↓
grant TTL 复核
      ↓
mouse dispatch
      ↓
fresh observation
      ↓
verification
```

当前最后两步还没有串成公开 execute 命令；verification engine 已具备纯状态验证能力。

Presentation fence 的原因：浏览器按 root renderer 已 present 的 compositor hit-test 数据把输入路由到 OOPIF process，而 prepare 读取的是 main-thread 实时 layout。后台 Tab 的 root renderer 在 Linux Chromium 上可能只有约 1 fps，scroll 后若立即 dispatch，输入会落到 root frame 的 iframe owner 上。目标位于 OOPIF 时，executor 会在 root frame 的独立 isolated world 中等待 3 个 animation frame，再重新 prepare 确认几何不变；root 文档 hidden（有界面 Chrome 的后台 Tab）时立即失败。fence 失败（`TARGET_NOT_VISIBLE`）或几何变化（`TARGET_IDENTITY_MISMATCH`）都发生在任何 input 之前，不自动重试。main-frame 与同 process child frame 的输入由 root renderer 用实时 layout hit-test，不经过 fence。见不变量 124、125。

## Ambiguous Outcome

如果 mousePressed 请求发出后发生 transport failure（包括 press response 或后续 release 丢失），Runtime 返回：

```text
ACTION_OUTCOME_UNKNOWN
```

禁止自动 retry。

## 下一步

1. trusted-host authorization ingress；
2. 内部 execute message，只接受有效 grant；
3. 把 fresh observation + verification 接到 execute pipeline；
4. 真实 Chromium policy-gated execution E2E。
