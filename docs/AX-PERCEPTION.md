# AX Perception 与 DOM↔AX 强身份关联

## 当前状态

分支：

```text
feat/hybrid-perception-strict-executor
```

已经完成：

- 只读 Chrome Debugger transport；
- main-frame live AX source；
- AX opt-in canonical pipeline；
- content isolated-world DOM identity bridge；
- backendDOMNodeId → exact content Element → stableId 关联；
- mergeKey 只由 browser-level strong identity 生成。

## Exact correspondence 原理

Content script 在自己的 isolated world 中维护：

```text
WeakMap<Element, stableId>
Map<stableId, WeakRef<Element>>
```

并安装一个不可枚举 bridge：

```text
__BROWSER_AGENT_NEXT_IDENTITY_BRIDGE_V1__
```

这个对象存在于 Extension isolated world，不写入页面 DOM attribute，也不依赖页面 main-world JS。

Background 通过 CDP：

```text
Runtime execution context
        ↓
定位本扩展 isolated world
        ↓
AX backendDOMNodeId
        ↓ DOM.resolveNode(executionContextId)
同一个 live Element object
        ↓ bridge.stableIdOf(element)
DOM stableId
```

最终 merge 的充分条件是：

```text
同一 document
+ 同一 CDP frame
+ 同一 backendDOMNodeId
+ isolated-world bridge 返回当前 DOM scan 已知 stableId
```

role/name/text/geometry **均不参与身份证明**。

## 为什么这比临时 data-* attribute 更合适

没有：

- DOM attribute mutation；
- MutationObserver side effect；
- CSS selector re-find；
- role/name 猜测；
- nth/index fallback。

因此 perception 本身仍保持页面 DOM 只读。

## Race 行为

如果 DOM scan 后节点被同文档替换：

- 旧 Element `isConnected=false`；
- bridge 不返回旧 stableId；
- correspondence 失败；
- DOM 与 AX 保持独立，而不是错误 merge。

如果 correspondence 完成后节点才被替换，后续 Strict Executor 仍必须重新解析 strong identity 并做 live preflight；observation 本身不被当作执行 freshness proof。

## 当前默认模式

AX 仍然是：

```text
options.includeAx = true
```

显式启用。

原因是 browser-level E2E 还没有覆盖 isolated-world correspondence。完成 E2E 后才考虑把 main-frame Hybrid Perception 默认开启。

## 下一步

1. 增加真实 Chromium exact correspondence E2E；
2. 验证同一 live node 合并成单 ref；
3. 验证 same-looking replacement 不会继承旧 backend correspondence；
4. 默认开启 main-frame Hybrid BrowserState；
5. 解决 child-frame CDP frame mapping；
6. 开始 Stored Observation Strict Executor。
