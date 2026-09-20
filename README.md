# browser-agent-next

面向 Agent 的真实 Chrome 浏览器运行时。

项目围绕五个长期稳定抽象构建：

1. **State** — typed、scoped、带明确 coverage 的浏览器观察；
2. **Identity** — 基于强浏览器身份的 Persistent Ref；
3. **Action** — 引用已观察状态的 typed action；
4. **Effect** — 副作用与授权独立于模型 confidence；
5. **Verification** — 完成状态必须有独立证据。

## 当前状态

PR #1、#2、#3 已合并；PR #4 正在推进 **Authorization Assurance + High-level Browser API**。

已经完成：

- BrowserState / Coverage / Revision；
- PersistentRefStore；
- TabStateStore / Delta；
- Strict Preflight；
- Effect Policy；
- Evaluation fixtures / trace schema；
- DOM frame-local perception；
- Chrome `documentId` 定向 frame messaging；
- webNavigation frame discovery；
- main/child navigation identity invalidation；
- 可加载的 MV3 Extension；
- 真实 Chromium lifecycle E2E；
- 采集期间导航竞态防护；
- complete observation 下 actionable ref 消失后的 tombstone。

真实 Chromium 已验证：

```text
same live node
→ same ref

same-looking replacement node
→ new ref

child frame reload
→ main ref 保持 / child ref 变化

main document reload
→ document epoch 变化 / refs 失效
```

当前已完成：

```text
DOM Perception
→ main-frame Hybrid
→ Strict Click closed loop
→ child-frame exact CDP mapping
→ child-frame Hybrid Perception
```

child-frame 目前只开放 Perception/Identity；真实点击仍保持 fail closed，等待 top-level coordinate projection 与 projected hit-test。

## 核心原则

> **AI 决策。代码授权。Executor 证明身份。Browser 执行。Verifier 证明结果。**

## 开发

- Node.js 20.19+
- pnpm 10.34.5

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
```

## 文档

- [设计](./docs/DESIGN.md)
- [架构](./docs/ARCHITECTURE.md)
- [Perception IR](./docs/PERCEPTION.md)
- [不变量](./docs/INVARIANTS.md)
- [评测](./docs/EVAL.md)
- [Roadmap](./docs/ROADMAP.md)
- [当前进度](./docs/PROGRESS.md)
- [PR #1 最终审查](./docs/PR1-FINAL-REVIEW.md)
- [安全模型](./docs/SECURITY.md)
- [PR #2 最终审查](./docs/PR2-FINAL-REVIEW.md)
- [Child-frame Exact Mapping](./docs/CHILD-FRAME.md)
- [PR #3 最终审查](./docs/PR3-FINAL-REVIEW.md)
- [Authorization Assurance](./docs/AUTHORIZATION-ASSURANCE.md)
- [High-level Browser API](./docs/HIGH-LEVEL-API.md)
- [PR #4 最终审查](./docs/PR4-FINAL-REVIEW.md)
