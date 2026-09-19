# Extension

当前已经可以构建为真实 MV3 扩展。

## 构建

```bash
pnpm --filter @browser-agent-next/extension build
```

产物：

```text
apps/extension/dist/
├── manifest.json
├── background/index.js
├── background/index.js.map
├── content/index.js
└── content/index.js.map
```

## 当前 Manifest

- Manifest V3；
- minimum Chrome 106；
- `webNavigation` + `tabs`；
- `<all_urls>` content script；
- all_frames；
- background service worker。

Chrome 106 是有意设定的最低版本，因为 runtime 使用 `documentId` 作为文档级消息目标和 revision document identity。

## 当前运行链路

```text
extension internal caller
        ↓ runtime.sendMessage
background perception.observe-tab
        ↓
webNavigation.getAllFrames
        ↓
tabs.sendMessage({ documentId })
        ↓
content frame DOM source
        ↓
BrowserObservation
```

当前 background 的 observe-tab 消息只接受 `sender.id === chrome.runtime.id` 的扩展内部消息。

它仍然是只读 perception path，没有真实浏览器动作执行能力。
