# Perception IR

## 状态

Phase 1 正在推进。

已实现：

- source-neutral perception candidate contract；
- expected-source 完整性契约；
- 保守 coverage 聚合；
- 仅允许强证据的跨源语义合并；
- 多 strong identity 绑定一个 canonical ref；
- canonical BrowserObservation assembler；
- frame-local DOM source；
- typed Content ↔ Background 消息协议；
- Chrome `documentId` 定向消息 transport；
- `webNavigation.getAllFrames` frame discovery；
- 多 frame DOM collector；
- Background canonical observation coordinator；
- BrowserObservation → StateStore → Delta 链路；
- DOM frame 生命周期失效注册表。

仍未完成：

- MV3 manifest / bundle entry；
- real Chrome E2E；
- AX source；
- DOM ↔ AX backend-node 强对应；
- component adapters。

## Chrome 文档身份

DOM transport 不只按 frameId 发消息。

Chrome 106+ 提供 `documentId`，它在 frame 内发生真正文档导航时变化，而 frameId 可以跨导航保持不变。因此当前实现：

```text
webNavigation.getAllFrames()
        ↓
frameId + documentId
        ↓
tabs.sendMessage(..., { documentId })
```

这样 discovery 与 content response 之间若发生导航，消息不会静默命中新文档。

main frame 缺少 `documentId` 时直接 fail closed。

## 两种身份各司其职

```text
Chrome documentId
→ BrowserObservation / revision 的 document identity

content frameEpoch
→ DOM stableId 的实例作用域

WeakMap<Element, stableId>
→ 同一 content 实例内的 live DOM object identity
```

这三者不能互相替代。

## 生命周期

Background 记录：

```text
(tabId, canonical frameId) → last observed frameEpoch
```

收到 child frame `onCommitted`：

- tombstone 该 child frame 上一 content epoch 的 refs；
- 不影响 main frame refs。

收到 main frame `onCommitted`：

- tombstone 整个 tab 的旧 refs；
- 清空该 tab 的 observation history；
- 等下一次 observation 建立新文档身份。

## Coverage

frame 失败不会消失：

```text
frame message failed / inaccessible
→ coverage.partial
→ degradedFrames
→ warning
```

因此 FastPath 后续不能把缺 frame 的页面误当作完整 action space。

## 下一步

1. 增加真实 MV3 manifest / content/background bundle。
2. 用 Chrome 真实页面做 lifecycle E2E。
3. 验证 same node / replacement node / reload / iframe 四类身份行为。
4. 之后再接 AX source。
