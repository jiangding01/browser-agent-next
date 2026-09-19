# 实现进度

最后更新：2026-09-19

## 当前分支

```text
feat/hybrid-perception-strict-executor
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception       ✅ 已合并
AX Perception                            ✅ main-frame 基线
AX → canonical pipeline                 ✅ opt-in
DOM ↔ AX Strong Correspondence          🚧 下一步
Hybrid BrowserState                     ⏭
Stored Observation Strict Executor      ⏭
```

## 本轮新增

- AX `includeAx` opt-in observation；
- AX source 可以进入 canonical assembler / state / delta pipeline；
- 默认仍 DOM-only，避免 identity 未合并时重复暴露同一 control；
- child frame 存在时 AX coverage 自动降级为 partial；
- production background 已实例化只读 debugger transport。

## 当前安全边界

AX 与 DOM 仍保持独立 strong identity。

不使用 role/name/geometry 相似度做 merge。

## 下一步

1. exact DOM↔AX backend-node correspondence；
2. linked Persistent Ref；
3. main-frame Hybrid BrowserState；
4. child-frame CDP mapping；
5. Stored Observation Strict Executor。

## 合并状态

PR #2 仍为 Draft，当前不需要合并。
