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
Child-frame Hybrid Perception            ✅
Child-frame Hybrid Real E2E              ✅
PR #3 Final Invariants Review            ✅
Child-frame Strict Execution             🚫 本 PR 明确不开放
High-level Browser API                   ⏭
```

## PR #3 完成内容

- frameEpoch-based webNavigation ↔ CDP exact mapping；
- main + child AX collection；
- 多 frame DOM↔AX exact linking；
- Chrome Observation Service integration；
- exact mapping 缺失时 AX coverage=partial；
- frameEpoch collision fail closed；
- child reload linked identity lifecycle；
- 同一 main document 下 child reload 不旋转 main ref；
- child linked target 的 Strict Prepare 继续 fail closed；
- OOPIF/root-session 不可见场景显式降级，不做 URL 猜测。

详细设计见：

- `docs/CHILD-FRAME.md`
- `docs/PR3-FINAL-REVIEW.md`

## 当前边界

PR #3 解决的是：

```text
Child-frame Perception + Identity + Lifecycle
```

没有解决：

```text
Child-frame top-level coordinate projection + Actuation
```

这是为了避免把 frame-local point 错当成 top-level CDP Input point。

## 合并状态

PR #3 最终 Review 已完成；最新实现 CI #57 已全绿。

本次文档/对抗测试收口提交的 CI 再次全绿后，即可合并 PR #3。
