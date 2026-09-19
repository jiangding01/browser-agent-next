# Strict Executor

## 当前状态

PR #2 已进入 Strict Executor 第一阶段。

当前已经完成：

- browser-independent `StoredObservationStrictCoordinator`；
- trusted expected semantics 仅从 `TabStateStore` 读取；
- main-frame linked DOM+AX strict click live resolver；
- current document epoch 校验；
- current CDP frame identity 校验；
- backendDOMNodeId → stableId exact identity re-check；
- live DOM visibility / enabled / viewport / hit-test；
- fresh AX role/name/disabled re-check；
- 生成 ephemeral prepared click target。

当前 **尚未 dispatch mouse input**。

## prepare 流程

```text
BrowserAction
  observedRevision + ref
        ↓
TabStateStore
        ↓
可信 expected ElementState
        ↓
当前 Chrome document catalog
        ↓
PersistentRef strong identities
        ↓
backendDOMNodeId ↔ stableId 再证明
        ↓
live DOM inspection
        ↓
fresh AX semantics
        ↓
Strict Preflight
        ↓
PreparedStrictClickTarget
```

## 为什么 prepared target 是 ephemeral

`point`、`hitTestable` 等条件都是瞬时状态。

因此后续真正 dispatch 时必须：

1. prepare 与 dispatch 紧邻；
2. 不把 prepared target 持久化或排队；
3. 在 Policy authorization 之后执行；
4. 非幂等动作不能在结果不明时自动重试。

## Live hit-test

当前 hit-test 在 Extension isolated world 中使用固定内部函数：

```text
document.elementFromPoint(x, y)
```

允许：

- hit node 就是 target；
- hit node 是 target 的 descendant。

不允许：

- unrelated overlay；
- pointer-events 导致命中其它节点；
- target 完全在 viewport 外。

## 当前限制

V1 strict resolver 只支持：

- `click`；
- main frame；
- 已经 linked 的 DOM + AX strong identity。

以下情况 fail closed：

- DOM-only ref；
- AX-only ref；
- child frame；
- document epoch 变化；
- CDP frame identity 变化；
- backend node 与 stableId 不再一致；
- live semantics 变化；
- target 不可见 / disabled / viewport 外 / 被遮挡。

## 下一步

1. 把 Strict Coordinator 接到 background runtime command，但保持无 dispatch dry-run；
2. 加真实 Chromium strict prepare E2E；
3. 加 Policy Engine / effect gate；
4. 再加入真正的 mouse dispatch；
5. dispatch 后必须进入 Verification。
