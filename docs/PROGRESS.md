# 实现进度

最后更新：2026-09-19

## 当前分支

```text
feat/hybrid-perception-strict-executor
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception       ✅ 已合并
Hybrid Perception                        ✅ main-frame exact correspondence
Strict Prepare                           ✅ Real Chromium E2E
Policy-gated Dispatch                    ✅ 基础设施
Trusted Authorization ingress            ⏭
Post-action Verification                 ⏭
```

## 本轮完成

- 新增短期 trusted authorization grant store；
- grant 精确绑定 tab/revision/ref/action/effect；
- 默认 single-use + TTL；
- unknown generic click 无授权时 fail closed；
- origin policy 在 dispatch 前执行；
- 新增真实 CDP left-click dispatcher；
- 执行前先 prepare；
- 授权通过后 commit 前再次 prepare，避免复用 stale point；
- 尚未向 Agent 暴露 execute 命令。

## 为什么现在还不暴露真实 click

当前授权 store 只能由进程内 trusted code 写入。

还没有：

- trusted Native Host ingress；
- 用户授权 UI；
- cryptographically/transport-authenticated grant channel。

所以即使 click primitive 已经存在，也不会通过普通 extension message 给 Agent 调用。

## 下一步

1. 设计 trusted-host authorization ingress；
2. origin allowlist；
3. policy-gated execute internal command；
4. post-action verification；
5. real Chromium execute E2E。

## 合并状态

PR #2 继续保持 Draft，当前不要合并。
