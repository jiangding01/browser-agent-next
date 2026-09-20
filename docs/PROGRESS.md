# 实现进度

最后更新：2026-09-20

## 当前分支

```text
feat/child-frame-exact-mapping
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception        ✅ 已合并
PR #2 Hybrid + Strict Click              ✅ 已合并
Child-frame Exact Mapping                ✅
Child-frame Hybrid Perception            ✅ 已接入 pipeline
Child-frame Hybrid Real E2E              🚧 CI 验证中
Child-frame Strict Execution             🚫 本 PR 明确不开放
High-level Browser API                   ⏭
```

## 本轮完成

- webNavigation frame ↔ CDP Page.Frame 使用随机 `frameEpoch` exact mapping；
- 不依赖 URL、顺序、parent index 等弱关联；
- Chrome Observation Service 改为先采集 DOM，再根据真实 frameEpoch 建立 CDP correspondence；
- main + child frame AX 统一进入 canonical BrowserObservation；
- DOM↔AX exact linking 泛化到多 frame；
- 默认 linking 覆盖全部已收集 AX candidate，不再叠加隐式 200 条截断；
- E2E 增加 child Hybrid provenance；
- child reload 后：main ref 保持，child linked ref 必须变化；
- child target 即使已具有 DOM+AX linked identity，Strict Prepare 仍继续 fail closed。

## 当前安全边界

```text
DOM frameEpoch
   ↓ exact
CDP FrameId
   ↓
AX backendDOMNodeId
   ↓ exact
DOM stableId
   ↓
Persistent Ref
```

Perception 已扩展到 child frame，但 Actuation 没有同步放宽。

原因：child-local DOM point 不能直接作为 top-level `Input.dispatchMouseEvent` 坐标。必须另行实现 frame viewport coordinate projection 与 top-level hit-test。

## 下一步

1. 等待/修复最新 CI；
2. 对 child-frame coverage 与 lifecycle 做对抗式 Review；
3. 如真实 Chromium E2E 全绿，收口 PR #3；
4. 下一 PR 再设计 child-frame coordinate projection 或先进入高层 Browser API。
