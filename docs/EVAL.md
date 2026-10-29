# Evaluation strategy

Evaluation is a first-class runtime feature, not a post-release benchmark.

## 当前自动化门禁

CI 现在分为两层：

```text
unit/type/build
      ↓
real Chromium MV3 E2E
```

第二层加载真实构建产物 `apps/extension/dist`，不是 mock transport。

当前 browser E2E 验证：

- 同一 live DOM node 重复观察保持同 ref；
- same-looking replacement node 获得新 ref；
- child document reload 只改变 child identity；
- main document reload 改变 document epoch 和 refs。
- Agent-owned OOPIF Strict Click 以 hybrid Observe 的 complete DOM + AX provenance 作为 readiness；child iframe 延迟导航时不得依赖 Playwright 的 page load 或 frame URL 出现。

## Failure attribution

A task failure must be attributable to a layer:

| Layer | Primary metrics |
|---|---|
| Perception | element recall, field coverage, degraded-frame rate |
| Identity | ref survival, wrong-rebind rate |
| Candidate | Recall@K, complete-action-space rate |
| Decision | conditional target accuracy, confidence calibration |
| Policy | unsafe-action prevention, false-block rate |
| Executor | wrong-target rate, stale refusal rate |
| Effect | no-effect / unexpected-effect rate |
| Verification | false-positive / false-negative rate |
| Task | end-to-end success |
| Performance | p50/p95 observe, decision, preflight and action latency |

Do not collapse these into one "agent success rate".

## Candidate evaluation

Two numbers must be separated:

```text
Candidate Recall@K
=
was an acceptable target included?

Decision Conditional Accuracy
=
given that an acceptable target was included,
did the decision provider choose one?
```

Otherwise a CandidateBuilder failure is incorrectly blamed on the model.

## Fixture format

Phase 7-0a 起由 `packages/eval` 实现（`DecisionFixture` / `validateDecisionFixtures`），设计见 `docs/TRACE-EVAL-FOUNDATION.md`。基本形态：

```ts
interface DecisionFixture {
  name: string;
  observation: BrowserObservation;
  microGoal: string;

  acceptableOperations: string[];
  acceptableTargets?: string[];

  tags: string[];
}
```

Use a set of acceptable targets rather than one exact target where the UI admits multiple valid next steps.

实际实现把 `acceptableOperations` 收窄为 Jev 初始操作空间（`CLICK / HANDOFF_FORM / HANDOFF_VERIFY / ESCALATE`），`tags` 收窄为固定枚举；fixture 校验要求 CLICK target 可见、启用、带 click capability，actionable coverage 非 complete 时必须接受 ESCALATE。

## Decision evaluation harness

`runDecisionEvaluation({ fixtures, builder, provider, ks })`（`packages/eval/src/decisionHarness.ts`）：

- 先校验 fixture 与 ks，再串行运行；provider / builder 收到深冻结的克隆，报告可 JSON 序列化且确定；
- builder 输出逐 fixture 校验（ref 唯一且存在、coverage 不提升、`totalKnown ≥ refs.length`），不合法直接失败；
- 报告 Recall@K、complete-action-space rate、conditional accuracy（含 click / nonClick 子总体）、candidate miss 下的 safeFallback、unsafeClickRate，以及按 tag 的同一组指标；分母为 0 时比例为 `null`；
- 每个 fixture 按第一个失败的层归因：`provider-error / candidate-miss / decision-invalid / decision-wrong / ok`。

参考 builder `observationOrderCandidateBuilder` 表示“模型今天直接看到的 action space”，作为后续 CandidateBuilder 的对照基线。第一批 14 个 fixture 是 harness 正确性与覆盖面检查，不是质量基准。

暂未覆盖的 fixture 家族：SPA navigation 与 disabled→enabled 转换（需要多步序列，归 offline replay）、virtualized lists（需要 scoped / paged observation）、WebMCP tool-description injection（Phase 8）。

## Required adversarial fixture families

- same role/name on multiple elements;
- replacement node with identical visible text;
- iframe reload;
- SPA navigation;
- modal/overlay covering target;
- disabled-to-enabled transitions;
- virtualized lists;
- dynamic forms;
- candidate truncation / incomplete coverage;
- prompt-injection-like element text;
- WebMCP tool-description injection;
- unknown side effects;
- CJK / Latin / mixed-language pages.

## Shadow mode

A shadow decision never causes a side effect.

Record candidate coverage/count, predicted operation/ref, confidence, model/version, latency/tokens/cost, agreement with executed policy, and independent verification when available.

Agreement with another agent is agreement, not ground-truth accuracy.

## Confidence calibration

Never pick a universal threshold such as 0.8 by intuition.

Calibrate per operation/effect, page family, candidate-count bucket, language bucket and model version.

For production auto-act, release against a wrong-action risk target with a statistical confidence bound, not just point accuracy.
