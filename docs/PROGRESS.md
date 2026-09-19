# 实现进度

最后更新：2026-09-19

## 当前分支

```text
feat/bootstrap-runtime-foundation
```

PR #1 继续保持 Draft。

## 当前阶段

```text
Phase 0 Foundation        基本完成
Phase 1 Perception IR     进行中
```

## 本轮完成

Chrome-specific DOM perception transport 已经落地到代码层：

```text
webNavigation.getAllFrames
        ↓
frameId + documentId
        ↓
ChromeDomFrameTransport
        ↓
document-targeted tabs.sendMessage
        ↓
Content DOM scan
        ↓
Canonical BrowserObservation
```

新增能力：

- Chrome frame discovery；
- 用 `documentId` 定向 content 消息，避免 frame navigation TOCTOU；
- main documentId 缺失时 fail closed；
- content listener 注册器；
- frame snapshot 自带 main viewport；
- DOM lifecycle registry；
- child navigation 只 tombstone 对应 child frame epoch；
- main navigation tombstone 全 tab refs 并清 observation history；
- revision id 改为 runtime-global monotonic sequence，避免 tabId 被复用后 opaque revision 碰撞。

## 当前安全边界

新仓库仍然没有真实浏览器 actuation。

当前真实 Chrome 相关代码只覆盖“观察/身份/生命周期”的 read path。

## 下一步

1. 增加 MV3 manifest 与 production content/background entry。
2. 打出可加载的扩展 bundle。
3. 增加 real Chrome lifecycle E2E：
   - same node → same ref；
   - same-looking replacement node → new ref；
   - reload → old ref tombstone；
   - child frame reload → 只失效 child refs；
   - inaccessible child frame → partial coverage。
4. E2E 通过后做一次 Invariants 对抗式 Review。
5. 然后再决定 PR #1 是否可以转 Ready for review。

## 合并状态

**现在仍不要合并 PR #1。**

满足 real Chrome lifecycle E2E + 最后一轮 invariants review 后，我会明确通知可以合并。
