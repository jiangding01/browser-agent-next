# Perception IR

## 当前 read path

webNavigation.getAllFrames → documentId-targeted frame message → content DOM scan → post-collection frame catalog revalidation → semantic normalization → Persistent Ref → BrowserObservation → StateStore / Delta。

## 采集窗口竞态

只在采集前读取一次 documentId 仍不够：旧文档可能完成响应后立刻发生导航，而 background 随后把旧快照提交成当前状态。

现在的提交协议是：

1. 读取 frame/document catalog；
2. 所有 content request 绑定对应 documentId；
3. 收齐 content response；
4. 再次读取 frame/document catalog；
5. frame set、documentId 或 main URL 任一变化，则丢弃整次 observation；
6. 只有稳定窗口才 mint revision、分配 refs、写 StateStore。

## Canonical URL

BrowserObservation 的 URL/origin 使用 main frame catalog URL，与 documentId 同源。tabs.get(tabId).url 可能处于另一个导航时刻，不能作为 canonical document URL。

## Coverage 语义

coverage.complete 表示声明的 expectedSources/profile 已完整执行，不表示发现网页中所有由 JavaScript 事件形成的隐式可点击像素。

当 open Shadow Roots 未纳入本次 observation 时，即使某个 actionable ref 没有出现在结果中，也不能据此证明它已从页面消失；disappearance tombstone 只允许在声明的 scope、同一文档、actionable coverage complete 且 open Shadow Roots 已覆盖时产生。

AX identity 还必须保留对应的 frameEpoch、CDP frame id 和 documentEpoch。迟到的 navigation event 如果已经对应当前 observation 的 document，不得反过来清理当前文档的 refs 或 state。

因此未来 FastPath 仍必须叠加 source-profile eligibility、origin/page allowlist、candidate policy 和 Strict Executor。

## Runtime restart

Persistent Ref continuity 当前保证在同一 runtime stateEpoch 内。MV3 service worker 重启后，内存 StateStore 不包含旧 observedRevision；Strict Action 必须拒绝旧 observation，不能只凭裸 ref 字符串继续执行。
