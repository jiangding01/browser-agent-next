# PR #7 Final Adversarial Review

更新日期：2026-09-20

## 结论

PR #7 完成了 OOPIF exact mapping 与 child-frame Strict Click 的执行闭环，并保持 fail-closed。

它没有通过 URL、frame 顺序或视觉相似度猜测 frame/session，也没有把 child-local 坐标直接发送给 top-level `Input.dispatchMouseEvent`。

最终执行链：

```text
web frame
→ frameEpoch exact proof
→ CDP frame + exact flat session
→ same-session DOM/AX live identity
→ child-local click point
→ live nested frame-owner projection
→ per-hop owner hit-test
→ top-level viewport point
→ second Strict prepare
→ dispatch
→ fresh observe + verify
```

## 1. OOPIF session identity

- root debugger session 启用 flat auto-attach；
- 只登记 iframe target；
- child session 使用 opaque sessionId/targetId；
- nested iframe 递归 auto-attach；
- Runtime execution context 保留 session provenance；
- detach 会清 session、descendant 与对应 context；
- late event 不能重新污染 detached session registry。

禁止：

- URL mapping；
- frame index mapping；
- name/role/geometry mapping；
- child CDP command 回落 root session。

## 2. Exact mapping

`ExactFrameMapping` 保留：

- webFrameId；
- frameEpoch；
- cdpFrameId；
- cdpSessionId；
- documentEpoch。

同一 frameEpoch 若出现多个 CDP candidate，mapping fail closed。

AX tree、backendDOMNodeId linking、DOM live inspection 都必须使用同一个 exact session。

## 3. Strict live revalidation

child target 在 prepare 阶段重新校验：

- retained documentEpoch；
- current lifecycle binding；
- frameEpoch；
- cdpFrameId；
- cdpSessionId；
- backendDOMNodeId → stableId；
- live DOM semantics/state；
- live AX identity。

任一不一致都不能继续进入 coordinate projection。

## 4. Coordinate projection

child-local point 不直接 dispatch。

每一跳：

1. 在 child exact session 读取 live viewport；
2. 在 parent exact session 调用 `DOM.getFrameOwner`；
3. 读取当前 `DOM.getBoxModel` content quad；
4. 只接受 2D affine quad；
5. 投影 local point；
6. 检查 parent live viewport bounds；
7. 在 parent execution context 对该 frame owner 做 live hit-test。

Nested frame 必须每一跳都通过，不只验证 root owner。

支持 2D translate / scale / rotate / skew。

Perspective / 3D、degenerate quad 或无法解释 geometry 直接 fail closed。

## 5. Fresh geometry

投影不缓存 box model。

scroll、layout shift、transform 改变后，每次 Strict prepare 都重新读取 live viewport 与 frame-owner content quad。

Effect/authorization policy 通过后仍执行第二次 Strict prepare，因此真正 dispatch 前会再次重算 identity 与 geometry。

## 6. Dispatch boundary

prepared target 必须显式声明：

```text
coordinateSpace = top-level-viewport
```

dispatcher 不接受 child-local 或未知 coordinate space。

## 7. Lifecycle adversarial cases

Real Chromium 已验证：

- OOPIF reload 后旧 child ref 不能执行；
- main ref 在仅 child reload 时保持；
- iframe detach 后已有授权不能执行；
- detached child-session late events 不恢复旧 session；
- replacement identity 不按 semantics 重绑。

## 8. Geometry adversarial cases

Real Chromium / unit coverage 包含：

- 正常 OOPIF click；
- scroll / frame movement 后 live re-projection；
- 2D affine transform 正确投影；
- perspective projection fail closed；
- nested OOPIF；
- 中间 parent owner 被 overlay 遮挡时 fail closed；
- overlay 移除后重新 observe/prepare 可恢复执行；
- projected point 越界与 owner hit-test 失败拒绝。

## 9. Authorization / model boundary

PR #7 没有扩大 model-facing MCP surface。

`browser.act` 仍只存在 trusted control plane。

模型仍不能：

- mint authorization；
- 提供 assurance；
- 调用 operator approval；
- 提交 enterprise assertion；
- 调用 raw CDP；
- 直接获得 child-frame actuation。

Phase 6.6 scoped authorization broker 完成前，model-facing `browser.act` 继续不可见。

## 10. Remaining limits

当前明确不支持：

- perspective/3D frame projection；
- 无法证明 exact session 的 OOPIF；
- inaccessible frame；
- browser/renderer 无法提供 live owner box/hit-test 的情况。

这些场景选择拒绝执行，而不是近似点击。

## Merge gate

- [x] frozen-lockfile install
- [x] TypeScript typecheck
- [x] unit / integration tests
- [x] workspace build
- [x] OOPIF exact mapping tests
- [x] session-aware DOM/AX tests
- [x] nested coordinate projection tests
- [x] affine transform / fresh geometry tests
- [x] perspective fail-closed tests
- [x] Real Chromium OOPIF mapping
- [x] Real Chromium child Strict Click
- [x] reload / detach stale-target E2E
- [x] nested owner occlusion / recovery E2E
- [x] docs / invariants synchronized

## 最终判断

PR #7 已达到本阶段合并条件。

合并后优先进入 Phase 6.6：安全 scoped authorization broker 与 model-facing side-effect authorization。
