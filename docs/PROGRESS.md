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
Child-frame Exact Mapping                🚧
Child-frame Hybrid Perception            🚧
Child-frame Strict Execution             ⏭ 后续独立阶段
High-level Browser API                   ⏭
```

## 本轮开始实现

- 新增 webNavigation frame ↔ CDP Page.Frame exact correspondence；
- 映射依据仅为 content isolated-world 的随机 `frameEpoch`；
- 不使用 URL、frame 顺序、parent index 等弱信号；
- AX collector 支持按 exact mapping 采集 main + child frame；
- 任一 accessible frame 无法 exact mapping 时，AX coverage 明确降级为 partial；
- DOM↔AX exact linking 从 main-frame-only 泛化为多 frame；
- child-frame Strict Click 暂不开放，继续 fail closed。

## 当前安全边界

```text
frameEpoch equality
      ↓
web frame ↔ CDP frame
      ↓
backendDOMNodeId
      ↓
stableId
      ↓
linked Persistent Ref
```

两个层级都必须 exact，对 URL/name/geometry 相似度零依赖。

## 下一步

1. 把 multi-frame AX exact mapping 接入 Chrome observation service；
2. 增加真实 Chromium child-frame Hybrid E2E；
3. child reload 后验证旧 AX identity/ref 失效、新 identity 建立；
4. 更新最终 coverage/invariants；
5. 本 PR 先不扩展 child-frame click 坐标投影。
