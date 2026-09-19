# AX Perception

## 状态

分支：

```text
feat/hybrid-perception-strict-executor
```

当前已经完成：

- 只读 Chrome Debugger transport；
- main-frame live AX source；
- AX strong identity；
- AX coverage / truncation；
- AX opt-in 接入 canonical observation pipeline。

## 为什么 AX 当前是 opt-in

DOM ↔ AX exact correspondence 还未完成。

如果现在默认同时暴露 DOM 和 AX：

```text
同一个 Save button
→ DOM ref A
→ AX ref B
```

上层会看到两个独立候选。

因此当前协议显式提供：

```text
options.includeAx = true
```

用于开发、评测和 Hybrid Perception 验证；生产默认观察仍保持 DOM-only。

这不是临时偷懒，而是避免在 identity merge 尚未证明正确前制造重复 action space。

## AX Strong Identity

```text
tabId
+ cdpFrameId
+ documentEpoch
+ backendDOMNodeId
```

其中：

- `cdpFrameId` 来自 `Page.getFrameTree`；
- `documentEpoch` 使用 Chrome `documentId` 派生 epoch；
- `backendDOMNodeId` 来自 AX node。

## Child frame coverage

当前 AX 只读取 main frame。

当页面存在 child frame 时：

```text
AX actionable/forms coverage → partial
```

而不是 complete。

这保证 canonical assembler 不会因为 main-frame AX 自身完整，就错误声称全页面 AX 完整。

## 跨源 merge

当前仍禁止通过：

- role；
- name；
- geometry；
- nth/index；

建立 DOM ↔ AX correspondence。

下一步必须建立 browser-level exact bridge。

## 下一步

1. 设计不依赖 semantic similarity 的 exact backend-node correspondence；
2. main-frame DOM ↔ AX linked identity；
3. 默认开启 main-frame Hybrid BrowserState；
4. child frame CDP mapping；
5. Strict Executor coordinator。
