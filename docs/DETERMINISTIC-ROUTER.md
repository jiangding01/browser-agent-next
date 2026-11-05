# Phase 7-1：Deterministic router（离线）

状态：方案经独立对抗式审查两轮（第一轮 2 HIGH、4 MEDIUM、4 LOW、3 advisory；第二轮 0 HIGH、2 MEDIUM、5 LOW；均已并入下文，见「审查记录」）；已实现，变异验证见「实现记录」
最后更新：2026-11-05

## 为什么做

`docs/ARCHITECTURE.md` 的 intelligence ladder 要求“用能安全解决这一步的最低一层”：

```text
Exact Recipe / Rule → Page semantic capability → Deterministic browser primitive → Jev → Reasoning LLM → Vision
```

现在只有最顶层可用：调用方模型先 observe，再自己挑 ref 调 `browser.act`。Phase 7 后续的 bounded fast_run 与 trajectory-to-recipe 都需要一个能力：**调用方事先描述一步（“点名为『下一步』的按钮”），系统在执行时那一刻的新 observation 上把它解析成 ref**。多步计划里后续步骤的 ref 在计划时还不存在，recipe 回放时 ref 每次会话都不同，因此这一步不能依赖调用方给 ref。

Deterministic router 就是这一层：对结构化的一步做可证明的确定性解析；证明不了就交给下一层（defer），绝不猜。

## 范围

做：

- 新包 `packages/router`（只依赖 core）：`StepIntent` 类型与解析、名称比较键、`routeStep` 纯函数；
- `effectiveFrameUrl` 从 `apps/mcp-server/src/frameOrigin.ts` 移入 core，供 router 与 mcp-server 共用（后续修复中已被 `effectiveFrameOrigin` 取代，见文末「已有缺陷」）；
- `packages/eval`：fixture 增加可选 `intent`，harness 把 intent 传给 provider，新增 router 评测与 router 专用对抗 fixture（带逐条期望路由结果）。

不做：

- 任何运行期接入：MCP 工具、Act broker、扩展都不改；`fast_step` / `fast_run` 属于后续条目；
- 自然语言解析：`microGoal` 不参与 router 判定，没有 intent 一律 defer；
- 点击以外的 intent（setValue 等写入）：写入的参数绑定与审批已在 S3 定型，fast_run 需要时再单独设计；
- 按 description 消歧：线上 observation 不产出 `semantic.description`（DOM 源与 AX 源都没有），加了也走不到；
- tier 链 / 插件框架：现在只有一层，Jev 落地时再决定组合方式；
- confidence：确定性解析不产出置信度，避免被当成已校准的数值；
- `Decision` / `DECISION_OPERATIONS` 迁到 core：router 返回自己的 `RouteResult`，不需要共享这两个类型（`docs/TRACE-EVAL-FOUNDATION.md` 中“由 router PR 负责迁移”的说法同步改为“暂不需要”）；
- 视觉相似字符（confusable，如西里尔字母 а 与拉丁字母 a）检测，见「残余风险」。

## 方案

### 组件关系

```text
StepIntent ──┐
             ├─> routeStep ──> RouteResult (resolved CLICK ref | defer reason)
Observation ─┘                       │
                                     ▼ (仅 eval)
             routedDecisionProvider(fallback) ──> DecisionProvider ──> runDecisionEvaluation
```

没有环；router 不调用 builder、不调用 fallback，组合只在 eval 适配器里发生。

### `StepIntent`（`packages/router/src/stepIntent.ts`）

```ts
export interface StepIntent {
  operation: "click";
  target: {
    /** 与元素 accessible name 的 exactKey 相等（区分大小写）。 */
    name: string;
    /** 与 semantic.role 精确相等。 */
    role?: string;
    /** 元素所在 frame 的有效 origin 必须精确等于它；缺省为 observation.tab.origin。 */
    frameOrigin?: string;
  };
}

export const STEP_INTENT_NAME_MAX_LENGTH = 200;
```

`parseStepIntent(value: unknown): StepIntent` 是唯一入口，非法即抛错：

- 只接受原型为 `Object.prototype` 或 null 的普通对象；exact-key 按全部自有 key（含不可枚举与 symbol）校验，字段只读自有属性且每个只读一次（原型链上的属性、被污染的 `Object.prototype` 都不会被当作字段）；
- exact-key（顶层与 `target` 都不允许多余 key），`operation` 只能是 `"click"`；
- `name` 必须满足 core 的 `isStrictValueAllowed`（与写入值同一套字符规则：拒绝 Cc / Cf / Default_Ignorable、Zl / Zp、U+0020 以外的空格分隔符、U+2800 与孤立代理项），调用方必须给可见文本；`exactKey(name)` 非空、≤ 200 个 UTF-16 码元。上限低于 DOM 源的名称截断长度 240（`domFrameSource.ts` 的 `textContent.slice(0, 240)`），因此被截断的元素名永远不可能与 intent 精确相等，不会退化为前缀匹配；
- `role` 匹配 `^[a-z][a-z-]{0,63}$`；
- `frameOrigin` 必须满足 `new URL(x).origin === x`、协议为 http / https（因此不接受 path、query、credentials 与 opaque origin `"null"`）。

### 名称比较键（`packages/router/src/nameMatch.ts`）

两把键，都先做 NFKC：

- `exactKey(s)`：NFKC → 所有 `\s` 折叠为单个空格 → trim，不改大小写。含不可见字符的名称照原样保留这些字符，因此不会与 intent（不含不可见字符）相等。
- `looseKey(s)`：NFKC → **先**删除 `\p{Cc}` `\p{Cf}` `\p{Default_Ignorable_Code_Point}` 与 U+2800 → 删除全部 `\s` → `toUpperCase().toLowerCase()`（比单次 `toLowerCase` 更接近完整大小写折叠，如 `straße` 与 `STRASSE`；不依赖 locale）→ NFKC（删除后相邻字符可能重新组合，如 `e\u200B\u0301`；大小写映射也可能产生非规范形式，由末尾这次 NFKC 统一处理）。

元素名缺失（`semantic.name` 为 undefined）或原文长度 ≥ 240 个 UTF-16 码元（DOM 源可能已截断，真实名称比任何 intent 都长；NFKC 会缩短名称，不能只靠 intent 上限排除）时，该元素既不进入匹配集，也不算候选歧义元素。

“可疑同名”：元素的 `looseKey` 与 intent 的 `looseKey` 相等、但 `exactKey` 不相等。它覆盖零宽字符插在词中或首尾（`Con\u200Bfirm`、`Confirm \u200B`）、BOM（`Con\uFEFFfirm`）、DOM 源已经把 U+FEFF 换成空格的形态（`Con firm`）、盲文空白 U+2800（既不属于 `\s` 也不属于 Cf），以及只有大小写不同的名称（CSS `text-transform` 可以让 `confirm` 显示成 `Confirm`，而 DOM 源取的是 `textContent`）。这些写法在页面上可能和 intent 看起来一样，因此一律视为歧义。代价是 `Sign in` 与 `Signin`、`Save` 与 `SAVE` 同时可见时也会 defer，可以接受。

### `routeStep`（`packages/router/src/deterministicRouter.ts`）

```ts
export type DeferReason =
  | "no-intent"
  | "opaque-origin"
  | "coverage-incomplete"
  | "blocking-overlay"
  | "no-match"
  | "ambiguous"
  | "target-disabled"
  | "target-not-clickable"
  | "target-occluded"
  | "target-out-of-viewport"
  | "invalid-observation";

export type RouteResult =
  | { route: "resolved"; operation: "CLICK"; ref: Ref; rule: "unique-exact-name" }
  | { route: "defer"; reason: DeferReason };

export function routeStep(input: {
  observation: BrowserObservation;
  intent?: StepIntent;
}): RouteResult;
```

`routeStep` 不抛错：收到的 intent 在函数内再 parse 一次，失败按 `no-intent` 处理（类型系统之外传入的对象不被信任）；trusted client 不校验 observation 的全部字段形态（如 `semantic.name`、`overlays`），任何形态不符导致的异常都返回 defer `invalid-observation`。

规则按顺序执行，第一条命中即返回：

1. 没有 intent（或 intent 不合法）→ `no-intent`。
2. `observation.tab.origin === "null"` → `opaque-origin`（data: / file: / about:blank 顶层页，`chromeObservationService.ts` 对它们给出 `"null"`，无法作为作用域）。
3. **完整性闸门**，以下全部成立才继续，否则 `coverage-incomplete`。唯一性需要完整 action space 才能证明（不变量 11、12），任一信号缺失都 fail closed：
   - `scope.kind === "page"`；
   - `coverage.actionable.status === "complete"`；
   - `coverage.shadowDom.openRootsCovered === true`（`includeOpenShadowRoots=false` 时 open shadow root 内的同名元素看不见，而 actionable 仍报 complete；与 `observationCoordinator.ts` 做缺席证明时的条件一致）；
   - `coverage.frames.degraded.length === 0`；
   - 每个 `frames[i].accessible === true`（出境投影会把“不可访问且 url 未知”的 frame 从 degraded 中删去，只看 degraded 会在投影上放行）。
4. `overlays` 中有 `blocking: true` 或 `dialogs` 中有 `modal: true` → `blocking-overlay`。线上目前不产出这两个字段，这一条是为将来与 7-0a fixture 的语义保持一致。
5. **作用域**：元素的有效 origin = `effectiveFrameOrigin(observation, element.frameId)`（core，与出境投影、act broker 同一实现，不变量 161）：以 frame 自报的 origin 为准，opaque、不合法或子 frame 未自报时记为 unknown（`about:blank` 的真实 origin 来自导航发起方，sandbox frame 是 opaque，URL 都看不出）。作用域 S = 有效 origin 精确等于 `intent.target.frameOrigin ?? observation.tab.origin` 的元素。
6. **匹配集 M**：S 中满足以下全部条件的元素：`provenance.dom === true`、`state.visible === true`、`exactKey(semantic.name) === exactKey(intent.name)`、（给出 role 时）`semantic.role === intent.role`。要求 DOM provenance：AX-only 元素的 `visible` 恒为 true（`axSource.ts`），可见性过滤对它们无效。
7. **歧义** → `ambiguous`，以下任一成立：
   - `|M| ≥ 2`（包括一个启用、一个禁用）；
   - 存在**候选歧义元素**：`state.visible === true`、（给出 role 时）role 相等、不在 M 中，且满足下列之一：在 S 中且可疑同名；有效 origin 为 unknown 且 exactKey 相等或可疑同名；在 S 中、exactKey 相等但没有 DOM provenance。
8. `|M| = 0` → `no-match`。
9. 唯一匹配 e：
   - `!e.state.enabled` → `target-disabled`；
   - 没有 `click` capability → `target-not-clickable`；
   - `e.geometry?.hitTestable === false` → `target-occluded`；
   - `e.geometry?.inViewport === false` → `target-out-of-viewport`；
   - 否则 resolved `{ operation: "CLICK", ref: e.ref, rule: "unique-exact-name" }`。

几何缺失（`geometry` 或 `hitTestable` 为 undefined）不阻止 resolve：线上 observation 不产出 `hitTestable`，遮挡与可见性的最终裁决在 Strict preflight（不变量 150）。router 只把 observation 已明确给出的否定结论转成 defer。

### Eval 接入（`packages/eval`）

- `fixtureObservation` 的 `tab.origin` 改为由 `url` 推导（现在写死为 `https://fixture.test`，不随 `url` 变化）；现有 fixture 都用默认 url，结果不变。
- `DecisionFixture` 增加可选 `intent?: StepIntent`；`validateDecisionFixtures` 对它调用 `parseStepIntent`，非法即 fixture 错误；新增 tag `structured-intent`，有 intent 与有该 tag 必须同时成立。
- `acceptableOperations` / `acceptableTargets` 只按**任务语义**标注（这一步怎样做是对的），不写 router 策略；router 的期望结果另存于下面的 `expectedRoute`。
- `DecisionProviderInput` 增加可选 `intent`，harness 传入深冻结的克隆；现有 provider 不读它，行为不变。
- `routerEvaluation.ts`：
  - `escalateProvider`：恒返回 `ESCALATE`，代表“今天没有 Jev，交还调用方”；
  - `routedDecisionProvider(fallback)`：调用 `routeStep`；resolved 且 ref 在本次候选集内 → `CLICK`；resolved 但 ref 不在候选集内 → 交给 fallback（避免把 builder 的漏召回记成 router 的不安全点击）；defer → 交给 fallback；
  - `evaluateRouter({ fixtures })`：独立于 builder 的 router 报告：`fixtureCount`、`intentCount`、`resolved`（`RateMetric`，分母为 intentCount）、`resolvedCorrect`（分母为 resolved 数）、`resolvedWrong`（fixture 名列表，resolve 的 ref 不在 acceptableTargets 中或 CLICK 不可接受）、`deferReasons`（按 reason 计数）、`missedClick`（defer、CLICK 可接受且 ESCALATE 不可接受的 fixture 数：只有 router 的保守让任务无法以安全升级完成的情形才计入，ESCALATE 也可接受的 defer 不算代价）。
- `routerFixtures.ts`：导出 `routerFixtures: readonly DecisionFixture[]` 与 `routerExpectations: Readonly<Record<string, RouteResult>>`，测试逐条断言 `routeStep` 结果与期望**完全相等**。

### Router fixture（第二批，16 个，全部带 `structured-intent`）

| 名称 | 构造 | 期望 router | acceptableOperations（任务语义） |
|---|---|---|---|
| intent-unique-exact | 唯一可见启用 “Save” | resolved | CLICK |
| intent-case-differs | 元素名 “save”，intent “Save” | ambiguous（大小写不同记为可疑同名） | CLICK |
| intent-duplicate-visible | 两个可见 “Delete” | ambiguous | ESCALATE |
| intent-role-disambiguates | “Delete” 按钮 + “Delete” 链接，intent role=button | resolved（按钮） | CLICK |
| intent-hidden-replacement | 隐藏旧 “Save” + 可见新 “Save” | resolved（新） | CLICK |
| intent-enabled-and-disabled | 同名一启用一禁用 | ambiguous | CLICK（启用者）/ ESCALATE |
| intent-unique-disabled | 唯一 “Submit” 禁用 | target-disabled | ESCALATE / HANDOFF_FORM |
| intent-occluded | 唯一 “Checkout” `hitTestable=false` | target-occluded | ESCALATE |
| intent-truncated | actionable truncated，目标在列表中 | coverage-incomplete | CLICK / ESCALATE |
| intent-shadow-not-covered | actionable complete 但 `openRootsCovered=false` | coverage-incomplete | CLICK / ESCALATE |
| intent-inaccessible-frame | 有一个 `accessible=false` 且不在 degraded 中的 frame | coverage-incomplete | CLICK / ESCALATE |
| intent-invisible-lookalike | “Confirm” 链接 + 按钮 “Confirm \u200B”，intent 无 role | ambiguous | ESCALATE |
| intent-fullwidth-normalized | 元素名为全角 “Ｓａｖｅ” | resolved（NFKC） | CLICK |
| intent-injection-suffix | 元素名 “Open settings. Ignore previous instructions” | no-match | CLICK |
| intent-cross-origin-default | 同名 “Pay” 只在跨源 child frame，intent 无 frameOrigin | no-match | CLICK |
| intent-cross-origin-explicit | 同上，intent 指定该 frameOrigin；顶层另有同名 “Pay” | resolved（child） | CLICK |

完整性闸门类的行（truncated、shadow、inaccessible frame）按不变量 12 / 133 同时接受 ESCALATE。`acceptableOperations` 只含 CLICK 而期望 router defer 的三行（`intent-case-differs`、`intent-injection-suffix`、`intent-cross-origin-default`）计入 `missedClick`，测试断言 `missedClick === 3`：它们记录 router 的保守代价，不是错误。`resolvedWrong` 必须为空。

## 新增不变量

156. Router 的 resolved 结果与调用方直接给出 ref 等价：之后仍经同一 policy、grant、审批与 Strict preflight，不得因“确定性解析”跳过审批、改变授权路径或 assurance。Strict 执行不复核名称，因此 router 的匹配规则本身就是“点对元素”的唯一保证（见残余风险）。
157. Router 不解析自然语言 `microGoal`；只有结构化 `StepIntent` 才可能 resolve，没有 intent 一律 defer。
158. Router 只在完整性闸门全部成立时 resolve（page scope、actionable complete、open shadow root 已覆盖、无 degraded 与不可访问 frame、非 opaque 顶层 origin、无阻塞 overlay / 模态 dialog），并要求作用域内 DOM provenance 的可见匹配恰好一个；任何歧义（含禁用同名、可疑同名、origin 无法判定的同名、非 DOM 来源的同名）都 defer。
159. Router 的匹配作用域默认是顶层 tab origin；跨源 frame 内的元素只在 intent 显式给出该 frame 的精确 origin 时才可匹配。
160. Eval 中 router resolve 的 ref 不在候选集内时必须交给 fallback，不得以 CLICK 提交给 harness。

## 测试计划

`packages/router`：

- `parseStepIntent`：合法最小 / 完整形态；多余 key（顶层与 target）、未知 operation、空名、超过 200、名称含 Cc / Cf / 零宽 / BOM、role 大写或含空格、frameOrigin 带 path / query / credentials / 非 http(s) / `"null"`，全部抛错；
- `exactKey` / `looseKey`：NFKC 全角、NBSP 与 U+3000 折叠、首尾空白、exactKey 保留大小写而 looseKey 折叠大小写；审查复现的三种绕过写法 `"Confirm \u200B"`、`"\u200B Confirm"`、`"Con\uFEFFfirm"`，DOM 化后的 `"Con firm"`，`"Confirm\u2800"`、`"CONFIRM"`，以及第二轮复现的 `"Cafe\u200B\u0301"` 对 `"Café"`、NFD 韩文夹零宽对 `"한"`、`"straße"` 对 `"STRASSE"`，都必须判为可疑同名；
- `routeStep`：每条规则至少一个单测，另加：intent 为非法对象时 `no-intent`；about:blank child frame 继承父 origin 后可匹配；frame 父链缺失使 origin unknown 时同名元素导致 `ambiguous`；child frame 有效 origin 为 `"null"`（sandbox / data:）时同名元素导致 `ambiguous`；`scope.kind` 为 region 时 `coverage-incomplete`；`coverage.frames.degraded` 非空但所有 frame 都 accessible 时 `coverage-incomplete`（线上 degraded 由各数据源给出，与 accessible 无关）；元素名缺失时不匹配也不制造歧义；原文 240 码元、NFKC 后与 intent 相等的元素（如 `"é"` 的 NFD 形式重复 120 次）不匹配；AX-only 同名元素导致 `ambiguous`；`geometry` 缺失时仍 resolve；规则顺序（禁用 + 遮挡同时成立时报 `target-disabled`）；
- 输入不被修改（传入深冻结 observation 与 intent 不抛错）。

`packages/core`：`effectiveFrameUrl` 测试随文件迁移，`BrowserObservation` 类型改为相对路径导入（core 不能自引用包名，干净构建时会解析到不存在的 dist）；mcp-server 现有出境与 broker 测试不改即全绿，证明迁移无行为变化。

`packages/eval`：

- fixture 校验：非法 intent、有 intent 无 tag、有 tag 无 intent 均报错；
- `fixtureObservation`：给出跨源 url 时 `tab.origin` 随之变化；
- harness：provider 收到的 intent 是冻结克隆；无 intent 的 fixture 不传该字段；
- `routedDecisionProvider`：resolved 在候选集内 → CLICK；resolved 在候选集外 → fallback 被调用；defer → fallback 被调用；
- 第二批 fixture：每条 `routeStep` 结果与 `routerExpectations` 完全相等；`evaluateRouter` 的 `resolvedWrong` 为空、`resolvedCorrect.rate === 1`；
- 在 7-0a 原有 14 个 fixture 上 `intentCount === 0`、`resolved.rate === null`。

变异验证（实现阶段逐条执行并记录）：去掉闸门中的任一条件（逐个）、M 计入不可见元素、M 不要求 DOM provenance、歧义判断忽略禁用同名、去掉可疑同名检查、looseKey 先折叠空白再删不可见字符、looseKey 不做大小写折叠、looseKey 不删 U+2800、looseKey 去掉末尾 NFKC、大小写折叠只用 `toLowerCase`、去掉 ≥ 240 码元排除、作用域改为全部 frame、`"null"` origin 当作已知、NFKC 去掉、大小写不敏感比较、`hitTestable === false` 放行、候选集外 resolve 直接返回 CLICK。每种变异都必须让至少一个测试变红；`expectedRoute` 逐条断言保证只改变 resolve 数量的变异也能被抓到。

## 改动清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/state/frameOrigin.ts`（+ test） | 从 mcp-server 迁入 `effectiveFrameUrl`，测试改相对导入，core index 导出 |
| `apps/mcp-server/src/frameOrigin.ts`（+ test） | 删除 |
| `apps/mcp-server/src/modelEgress.ts`、`modelActBroker.ts` | import 改为 core |
| `packages/router/package.json`、`tsconfig.json` | 新包，只依赖 core |
| `packages/router/src/{index,stepIntent,nameMatch,deterministicRouter}.ts`（+ 3 个 test） | 本方案主体 |
| `vitest.config.ts`、`tsconfig.json`、`pnpm-lock.yaml` | 新包别名与 workspace 链接 |
| `packages/eval/package.json` | 依赖 router |
| `packages/eval/src/foundationFixtures.ts` | `tab.origin` 由 url 推导；`scope`、`openRootsCovered`、degraded 与 accessible 不一致等形态在 `routerFixtures.ts` 内对 `fixtureObservation` 的结果局部覆盖，不扩大公共选项 |
| `packages/eval/src/decisionFixture.ts`、`decisionHarness.ts` | intent 字段、校验、tag、传参 |
| `packages/eval/src/{routerEvaluation,routerFixtures}.ts`（+ test）、`index.ts` | 适配器、报告、第二批 fixture 与期望 |
| `docs/INVARIANTS.md`、`EVAL.md`、`ROADMAP.md`、`PROGRESS.md`、`ARCHITECTURE.md`、`TRACE-EVAL-FOUNDATION.md` | 不变量 156～160、评测说明、阶段状态、router 位置、类型迁移说明更正 |

源码文件超过 8 个，并新增 1 个 workspace 包；全部为离线代码，运行期行为只有 `effectiveFrameUrl` 的 import 位置变化。`pnpm -r build` 按 workspace 依赖拓扑排序，router 在 core 之后、eval 之前构建，无需改 CI。

## 验证命令

```bash
pnpm install
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Real Chromium E2E 不受影响（无运行期行为变化），由 CI browser-e2e 覆盖。

## 回滚

全部是新增的离线代码加一次纯移动的重构，revert 单个 PR 即可，不涉及任何持久化数据或 operator 配置。

## 关键决策

1. **只认结构化 intent，不碰自然语言**：自然语言匹配在同名、中英混排、注入文本上无法给出可证明的结果，那是 Jev 与 LLM 的层；router 的价值在于“可证明”，宁可 defer。
2. **独立包而非放进 `packages/runtime`**：架构把 Decision Router 与 Policy / Executor 分层；runtime 被扩展与 trusted 路径使用，不应依赖决策逻辑，后续 Jev provider 也不应进入 runtime。代价是多一套 package 配置。
3. **defer 不是 ESCALATE**：defer 表示“本层无法证明”，由下一层决定；fixture 的 ground truth 按任务语义标注，router 的保守代价以 `missedClick` 单列，而不是在 harness 指标里显示成正确答案。
4. **完整性闸门全部 fail closed**：唯一性证明依赖“看全了”，observation 上每一个表示可能没看全的信号都单独成为 defer 条件，不从某一个字段推断整体完整。
5. **origin 作用域默认收窄到顶层**：跨源 frame（广告、第三方组件）最容易制造同名按钮；显式给出 frameOrigin 才放宽，与 act origin plane 的思路一致。

## 最脆弱的假设

本方案假设：**调用方能用 (role, name, origin) 精确描述一步，且这些可见名称在执行那一刻保持不变。** 另一个同类风险在接入阶段：MCP 出境投影会把未放行 origin 的 frame 标为不可访问、actionable 降为 partial，并删除 overlays / dialogs；router 若跑在投影上，带第三方 iframe 的页面会一律 `coverage-incomplete`，规则 4 也不生效。fast_step 方案需要决定 router 跑在投影还是 trusted observation 上，并重新论证这两点。 如果真实页面的名称普遍带动态内容（计数、时间、用户名），router 会大量 defer `no-match`，resolve 率很低。这一失败模式只影响有用性，不影响安全（defer 交给下一层）。`deferReasons` 与 `missedClick` 正是为此保留，offline replay 阶段用真实数据检验；若 resolve 率过低，再评估前缀匹配等放宽规则，届时必须在同一 fixture 集上证明 `resolvedWrong` 仍为 0。

## 残余风险

- **同 origin 内的完全同名攻击**：页面（例如同源的用户生成内容）放置一个与 intent 码点完全相同、且唯一可见的元素时，router 会 resolve 到它。Strict 执行不复核名称；operator 审批模式下由人看审批卡片兜底，但 `agent-owned-auto` 下 click 自动签发，没有人工兜底。这与模型按名称自己选 ref 的风险相同，但 router 接入后调用方不再看到 observation，风险更隐蔽。**fast_step 方案必须决定 router 解析出的 click 是否允许走 `agent-owned-auto`**（负责人：fast_step 方案；默认倾向不允许）。
- **视觉相似字符**：只按码点比较，西里尔字母等构造的看起来相同但码点不同的名称不会被判为可疑同名。真按钮与 intent 码点一致时，攻击者元素只会让结果变成 resolve 真按钮（攻击者元素不在 M 中）；攻击者元素与 intent 码点一致时属于上一条。
- **closed shadow root**：`coverage.shadowDom.closedRootsUnknown` 线上恒为 true，closed shadow root 内的同名元素看不见，唯一性证明在这一点上与模型看到的 action space 等价，不更强。
- **Unicode 版本**：NFKC 与 `\p{…}` 的结果依赖 Node 内置 ICU 的 Unicode 版本，“确定性”只在固定运行时版本下成立；fixture 中的 Unicode 用例会在版本漂移时暴露差异。
- **接入阶段的前提**：router 必须在与执行授权绑定的同一份 observation（MCP 侧为模型可见投影）上运行；完整性闸门已覆盖投影删除 degraded frame 的情形，其余投影差异留给 fast_step 方案逐项核对。

## 审查记录

独立对抗式审查一轮（初稿），发现均已核对代码并并入：

- H1：闸门漏 `openRootsCovered` 与 `scope.kind` → 并入规则 3，新增 fixture `intent-shadow-not-covered`；
- H2：可疑同名检测先折叠空白再删不可见字符，留下的空格使检测失效（已复现）→ 改为 exactKey / looseKey 两把键，looseKey 先删不可见字符再删全部空白；
- M1：opaque origin `"null"` 不会使 `new URL` 抛错 → 新增规则 2，有效 origin 为 `"null"` 记为 unknown；
- M2：出境投影删除不可访问 frame 的 degraded 记录 → 闸门要求全部 frame `accessible`，新增 fixture `intent-inaccessible-frame`；
- M3：fixture 把 router 策略写进 ground truth，且只改变 resolve 数量的变异抓不到 → ground truth 改按任务语义标注，新增 `routerExpectations` 逐条断言；
- M4：`agent-owned-auto` 下审批不兜底 → 改写不变量 156 与残余风险，接入时的决定交给 fast_step 方案；
- L1：线上不产出 description → 从 intent 中删除，fixture 改为按 role 消歧；
- L2：DOM 名称在 240 处截断 → intent 名称上限降为 200；
- L3：忽略阻塞 overlay / 模态 dialog → 新增规则 4；
- L4：迁移测试的自引用导入、`TRACE-EVAL-FOUNDATION.md` 的过期说法、`fixtureObservation` 写死 origin → 并入改动清单；
- advisory：Unicode 版本依赖写入残余风险；AX-only 元素可见性无效 → 规则 6 要求 DOM provenance；`missedClick` 的解读说明写入报告字段定义。

复核（作者自查，对照代码与 Node 实测）：

- U+2800 既不属于 `\s` 也不属于 Cf / Default_Ignorable，会绕过可疑同名 → looseKey 与 intent 校验都加入 U+2800；
- CSS `text-transform` 使大小写不同的名称看起来相同：真按钮 `textContent` 为 `confirm`、攻击者放一个码点与 intent 一致的 `Confirm`，就会唯一匹配攻击者 → looseKey 做大小写折叠，`intent-case-differs` 期望改为 `ambiguous`；
- 文档中的零宽字符统一写为 `\uXXXX` 转义。

第二轮独立审查（修订稿），发现均已核对（M1 经 Node 复现）并并入：

- M1：删除不可见字符后未再做 NFKC（`e\u200B\u0301`、NFD 韩文）、`toLowerCase` 不是完整大小写折叠（`straße`）→ looseKey 改为 NFKC → 删不可见 → NFKC → 删空白 → upper→lower → NFKC；
- M2：`missedClick` 定义前后矛盾、shadow 行未接受 ESCALATE → `missedClick` 只计 ESCALATE 不可接受的行，测试断言为 3；shadow 行加 ESCALATE；
- L1：NFKC 会缩短名称，“截断名不可能与 intent 相等”不成立 → 原文 ≥ 240 码元的元素既不匹配也不算歧义；
- L2：intent 字符集与 strictArgs 的说法不一致、`semantic.name` 可缺失 → 直接复用 `isStrictValueAllowed`，名称缺失的元素不参与；
- L3：fixture 的 degraded 由 accessible 推导，“去掉 degraded 条件”的变异抓不到 → 补“degraded 非空但全部 accessible”的单测；
- L4：改动清单中 `fixtureButton` 的 provenance 选项无 fixture 使用 → 删除；AX-only 情形由 router 单测自行构造（router 不能依赖 eval，否则成环）；
- L5：出境投影使 router 在第三方 iframe 页面上一律 defer → 写入「最脆弱的假设」，留给 fast_step 方案。

## 实现记录

- looseKey 实现时去掉了第二轮审查建议的“删除不可见字符后立即再做一次 NFKC”：变异验证中它是等价变异，末尾的 NFKC 已能把 `Cafe\u200B\u0301` 组合为 `café`；保留末尾 NFKC 并以“去掉末尾 NFKC”的变异验证其必要性；
- 截断排除的单测最初用了 100 个 `é` 的 intent，与 120 个 `e\u0301` 的元素名在 NFKC 后并不相等，变异“去掉 ≥ 240 排除”因此存活；改为 120 个 `é` 后被抓到；
- 源码与测试中的不可见字符一律写作 `\uXXXX` 转义（编辑工具会把转义写成真实字符，已统一替换）。

变异验证（`packages/router` + `packages/eval` 测试，23 种，全部变红）：

| 变异 | 结果 |
|---|---|
| 闸门：去掉 opaque origin / scope.kind / actionable complete / openRootsCovered / degraded / 全部 frame accessible / 阻塞 overlay（7 种，逐个） | 全部抓到 |
| M 计入不可见元素、M 不要求 DOM provenance、歧义判断忽略禁用同名 | 全部抓到 |
| 去掉可疑同名检查、作用域改为全部 frame、`"null"` origin 当作已知、去掉 ≥ 240 码元排除、`hitTestable === false` 放行 | 全部抓到 |
| exactKey 去掉 NFKC、exactKey 大小写不敏感 | 全部抓到 |
| looseKey 先折叠空白再删不可见字符、不做大小写折叠、不删 U+2800、去掉末尾 NFKC、大小写折叠只用 `toLowerCase` | 全部抓到 |
| 候选集外 resolve 直接返回 CLICK | 抓到 |

### 代码审查（check，Deep）

两路独立审查（安全 + 对抗、架构 + 评测正确性），发现均已核对：

- HIGH（安全）：`effectiveFrameUrl` 让 `about:blank` 继承父 frame，但它的真实 origin 来自发起导航的一方；跨源广告 frame 把同源兄弟导航到 `about:blank` 后写入的按钮会被当作顶层元素唯一 resolve（违反不变量 159）→ router 把推导链经过 `about:blank` 的 frame 记为 origin unknown（同名即歧义、永不匹配），`about:srcdoc` 仍继承；单测覆盖兄弟劫持、`about:blank` 下的 srcdoc 与顶层同名并存三种形态；
- LOW（安全）：observation 形态不符时 `routeStep` 抛错 → 包一层，返回 defer `invalid-observation`；
- LOW（安全）：`parseStepIntent` 的 key 检查用 `Object.keys` 而读取走解构，原型链上的 `frameOrigin` 能改写作用域 → 只接受普通对象，按 `Reflect.ownKeys` 校验，只读自有属性且每个字段读一次；
- MEDIUM（评测）：`resolved` 与 `missedClick` 容易被误读为覆盖率 / 质量指标 → 字段注释写明它们是对抗集上的回归信号及 `missedClick` 的口径；
- LOW（架构）：`rate` 与 harness 重复 → harness 导出 `rateMetric` 复用；router 的 `export *` 带出内部符号 → 改为显式导出 `routeStep` / `RouteResult` / `DeferReason` / `parseStepIntent` / `StepIntent` / `STEP_INTENT_NAME_MAX_LENGTH`；tag 覆盖测试写死例外 → 改为两批 fixture 合并后覆盖全部 tag；
- 未采纳：AX-only 唯一同名报 `ambiguous` 的原因标签（方案已决定非 DOM 来源的同名一律按歧义处理）；`resolvedCorrect` 与 `fixtures` 字段（前者便于直接读比例，后者供 offline replay 定位）。

**已有缺陷（非本 PR 引入）**：mcp-server 的出境投影（`modelEgress.ts`）与 act broker（`modelActBroker.ts`）同样经 `effectiveFrameUrl` 让 `about:blank` 继承父 frame。被跨源 frame 劫持的 `about:blank` 因此可能通过 read / act origin plane 检查。已在后续分支 `fix/frame-security-origin` 修复：frame 自报真实 origin，三处共用 `effectiveFrameOrigin`（不变量 161），子 frame 未自报即视为无法判定；上文 HIGH 修复中 router 自己的 `about:blank` 特判随之移除。

修复后的变异验证追加 5 种：`about:blank` 继承父 frame、去掉异常兜底、intent 接受任意原型、intent 读取继承属性、key 检查改回 `Object.keys`，全部被抓到；合计 28 种。
