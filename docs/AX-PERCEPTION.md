# AX Perception

## 状态

下一阶段分支：

```text
feat/hybrid-perception-strict-executor
```

已经完成第一步：

- 增加只读 Chrome Debugger transport；
- Extension manifest 增加 `debugger` 权限；
- 读取 `Page.getFrameTree`；
- 读取 main frame `Accessibility.getFullAXTree`；
- 使用 `backendDOMNodeId` 构建 document-scoped AX strong identity；
- 对 AX actionable space 做显式 coverage / truncation；
- 暂不进行 DOM ↔ AX 猜测式 merge。

## 当前 AX Strong Identity

```text
tabId
+ cdpFrameId
+ documentEpoch
+ backendDOMNodeId
```

其中：

- `cdpFrameId` 来自 `Page.getFrameTree`；
- `documentEpoch` 继续使用 Chrome `documentId` 派生的 epoch；
- `backendDOMNodeId` 来自 AX node。

`backendDOMNodeId` 不被视为跨导航永久 identity。

## 为什么暂时只做 main frame

`webNavigation.frameId` 与 CDP `Page.FrameId` 不是同一命名空间。

在没有建立可靠映射前，不能通过：

- URL 相同；
- frame 顺序；
- parent index；

来猜 child frame 的 CDP frame identity。

因此第一版 AX source 只读取 main CDP frame，并明确在 warning 中声明 child-frame AX 尚未覆盖。

## 为什么现在不合并 DOM + AX

即使 DOM 与 AX 的：

```text
role
name
geometry
```

完全一样，也不能证明它们是同一个 live object。

下一步必须建立精确 correspondence bridge，例如让一个 DOM strong identity 能被 CDP 解析成确定的 backend node，再用：

```text
same backendDOMNodeId
+ same document
```

生成 mergeKey。

在此之前两个 source 保持独立，避免 semantic similarity rebind。

## Debugger 权限

AX 读取需要 Chrome `debugger` permission。

当前 transport 只启用并读取：

- DOM
- Accessibility
- Page

不包含 Input、Network mutation 或 Runtime arbitrary eval。

Strict Executor 后续会复用同一 transport，但执行命令会放在独立受 Policy 控制的模块中，避免“获得 debugger 权限 = 自动获得任意执行权”。

## 下一步

1. 把 AX source 接入 observation service，但先作为独立 expected source；
2. 设计 DOM stableId → backendDOMNodeId 的强关联 bridge；
3. 对主 frame 建立 exact merge；
4. 再解决 child webNavigation frame ↔ CDP frame mapping；
5. Hybrid BrowserState 稳定后进入 Strict Executor coordinator。
