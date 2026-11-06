# Phase 7-2：Jev CandidateBuilder（离线）

状态：方案经 check 审查一轮（2 HIGH、4 MEDIUM）与 Fable 5.1 编排评估一轮（1 HIGH、5 MEDIUM，路线保留），发现均已并入下文，见「审查记录」；已实现，变异验证见「实现记录」
最后更新：2026-11-06

## 为什么做

Jev 是有界的语义决策 provider（`docs/DESIGN.md`）：它只在一份**有限的候选列表**上选择 `CLICK <ref>`，或给出 `HANDOFF_FORM` / `HANDOFF_VERIFY` / `ESCALATE`。候选列表决定了 Jev 能不能选对——目标不在列表里，Jev 再聪明也只能升级（不变量 131 把这类失败归因到 candidate layer）。

现在只有参考实现 `observationOrderCandidateBuilder`：可见、启用、可点击的元素按 observation 顺序排，超过上限截断。真实页面动辄几十上百个可点击元素，而 Jev 的输入预算只放得下十几二十个；按 DOM 顺序截断，等于让导航栏、页脚把真正的目标挤出去。

本阶段做一个**确定性、无外部模型**的相关度排序 CandidateBuilder：在不改变“哪些元素有资格当候选”、不提升 coverage 的前提下，把与 `microGoal` 相关的元素排到前面，使 Jev 在小 K 下也能看到目标。排序有固有代价：部分命中的元素可能把与 goal 毫无词面交集的真目标挤出上限（见「最脆弱的假设」），因此候选集同时报告排序信号在哪里断掉。

## 范围

做：

- `CandidateSet` / `CandidateBuilder` 类型从 `packages/eval` 移到 `packages/router`（决策层，只依赖 core），供后续 shadow mode / fast_step 在运行期复用；eval 改为从 router 导入并原样再导出，现有调用不变；
- `packages/router` 新增 `jevCandidateBuilder`：把文本切成 unit（概念或原词二选一，最长匹配、不重叠）+ 固定的中英概念词表 + 字段加权与长度归一化，按分数降序、同分按 observation 顺序；
- `packages/eval` 新增第三批 fixture（候选排序），以及“两个 builder 在三批 fixture 上的对照”测试；fixture 校验改用同一个 `isClickCandidate`。

不做：

- Jev 决策 provider 本身（LLM / 小模型调用、prompt）——下一项；
- 运行期接入（MCP、broker、扩展）——属于 shadow mode / fast_step；
- 向量检索、外部模型、学习到的权重：引入新依赖与非确定性，且当前没有真实数据可学；
- 改变候选资格：仍只收可见、启用、带 `click` capability 的元素；表单字段等 HANDOFF 线索不是 CLICK 候选，由 Jev 的 provider 从 observation 读取；
- 遮挡、视口、origin 过滤：分别属于 decision、Strict preflight 与 origin plane，候选层不做。

## 组件关系

```text
microGoal ──> goalTerms ──┐
                          ├─> score ──> 排序（分数降序，同分按 observation 顺序）──> 截断到 maxCandidates ──> CandidateSet
observation.elements ─────┘   (eligibility 与参考实现相同)
                 ▲
       conceptLexicon（固定数据）
```

无环；builder 不读取 element 的 `value`，不调用任何外部服务。

## 方案

### 类型迁移（`packages/router/src/candidateSet.ts`）

`CandidateSet`、`CandidateBuilder`、`DEFAULT_MAX_CANDIDATES`（50，参考实现沿用）、`MAX_CANDIDATES_LIMIT`（500）与 `isClickCandidate(element)`（可见 + 启用 + click capability，全仓唯一的 CLICK 候选资格定义）移入 router。`packages/eval/src/candidateBuilder.ts` 保留 `observationOrderCandidateBuilder`，类型与常量改为从 router 导入并再导出；`decisionFixture.ts` 中“CLICK target 必须可见、启用、可点击”的校验也改用 `isClickCandidate`。

### Unit 切分（`packages/router/src/goalTerms.ts`）

`unitsOf(text: string): Set<string>` 把文本切成 unit。**一个词或短语要么归入一个概念（`c:<id>`），要么保留为原词（`w:<词>`），不会同时算两份**：

1. NFKC → 截断到 500 个码点（在 NFKC 之后截断，NFKC 可能使字符串变长；运行期元素字段已被 DOM 源截断到 240 个 UTF-16 单元，这一步只对 goal 与合成数据起防御作用）→ 删除 Cc / Cf / Default_Ignorable 与 U+2800（与 `nameMatch.ts` 同一字符集）→ `toLowerCase()`；
2. 按 script 切成段：汉字 / 平假名 / 片假名 / 谚文以及片假名长音符 U+30FC（其 script 属性是 Common，不并入会把 “コーヒー” 切碎）的连续段为 CJK 段；**不属于这些 script 的** `\p{L}\p{M}\p{N}` 连续段为拉丁词（`Settings设置` 切成拉丁词 `settings` 与 CJK 段 `设置`；含组合附加符，天城文等文字不会被切碎）；
3. 拉丁词序列（相邻的 CJK 段与句末 / 分句标点 `. ! ? ; :` 及其全角形式打断序列，连字符不打断）从左到右：
   - 先试两词短语（`sign in`、`log out` 等），命中则产出概念并吃掉这两个词——**在去停用词之前**匹配，否则 `in` 会先被删掉；
   - 再用**原词**查单词概念表，命中则产出概念；概念表显式列出复数写法（`settings`、`details`），复数归一后的结果**不**查概念表（否则 `news` 会归一成 `new` 而命中 create）；
   - 英文停用词（固定 24 个：the、a、an、of、to、for、in、on、with、and、or、my、your、this、that、is、are、be、please、now、it、at、by、from）丢弃；
   - 其余词做最小复数归一（长度 > 4 的 `ies→y`；长度 > 3、以 `s` 结尾且不以 `ss` 结尾的去掉 `s`），产出原词 unit；
4. CJK 段从左到右按**最长匹配**查中文概念写法（`退出登录` 优先于 `登录`），命中则产出概念；再按最长匹配删除中文停用短语（固定 5 个：点击、我的、页面、按钮、一下；不收“的”“请”这类单字，否则会拆开“目的地”“申请”）；剩下的连续字符切成相邻二字组，孤立的单字保留为单字。概念写法优先于停用短语（`我的订单` 中的 `订单` 仍是概念）。

### 概念词表（`packages/router/src/conceptLexicon.ts`）

固定、只读的数据表，20 个界面高频概念（实现时以此表为准，单测逐条校验每个写法都能被 `unitsOf` 切成对应概念）：

| concept | 写法 |
|---|---|
| settings | settings、setting、preferences、设置、偏好设置 |
| create | create、new、add、新建、创建、添加、新增 |
| delete | delete、remove、删除、移除 |
| open | open、打开 |
| view | view、查看、浏览 |
| sign-in | sign in、log in、login、登录、登入 |
| sign-out | sign out、log out、logout、退出登录、退出账号、登出、注销 |
| submit | submit、提交 |
| save | save、保存 |
| cancel | cancel、取消 |
| pay | pay、payment、支付、付款 |
| search | search、搜索 |
| next | next、下一步、下一页 |
| back | back、返回、上一步 |
| confirm | confirm、确认、确定 |
| detail | detail、details、详情 |
| ticket | ticket、tickets、工单 |
| order | order、orders、订单 |
| account | account、accounts、账户、账号 |
| close | close、关闭 |

词表是**同义归并**而不是翻译：它只让“打开设置”和“Settings”产生相同的 unit。`open` 与 `view` 分成两个概念，避免“查看详情”被普通的 “Open” 抢先。

### 打分（`packages/router/src/jevCandidateBuilder.ts`）

对每个候选 e，字段 f ∈ {name（权重 3）、description（2）、text（1）}，`U(x)` 为 `unitsOf(x)`：

```text
score(e) = Σ_{u ∈ U(microGoal)} max_f [ u ∈ U(e.f) ] · w_f / sqrt(|U(e.f)|)
```

- 每个目标 unit 只按命中它的最佳字段计一次；总分量化到 1e-9，避免数学上同分（如 3/√27 与 1/√3）因浮点误差打破“同分按 observation 顺序”；
- 除以字段 unit 数的平方根：短而准的名称（“Settings”）优先于把目标词塞进长句的名称；概念算一个 unit（“退出登录”是 1 个 unit，不是 3 个二字组）；
- `role`、`value`、frame、geometry 不参与打分。

运行期字段说明：DOM 源的 `name` 取 aria-label 或 textContent，`text` 取 textContent；当前 DOM 与 AX 源都不产出 `description`。description 权重保留给将来的数据源，本阶段只在合成 fixture 中起作用。

排序：分数降序，同分按 observation 中的原始下标升序；全部为 0 分时结果与参考实现完全相同。

截断与 coverage：与参考实现同一规则——候选数超过 `maxCandidates` 时截断并把 coverage 置为 `truncated`，否则继承 observation 的 actionable coverage；`totalKnown` 为截断前的候选总数（不变量 133）。默认上限与参考实现相同（`DEFAULT_MAX_CANDIDATES = 50`，1..500）：仓库里没有 Jev 输入预算的定义，而上限越小，部分命中挤出 0 分目标的问题越严重；更小的上限由 Jev provider 方案按其预算显式传入。

### 排序说明（`CandidateSet.ranking`，可选字段）

`CandidateSet` 增加可选字段 `ranking?: { builder: string; lexiconVersion: string; scoredCount: number }`：`scoredCount` 是截断后候选中分数大于 0 的个数（它们都排在最前面），让 Jev 与 offline replay 区分“前 N 个有词面信号”与“其余只是按页面顺序的填充”；`lexiconVersion` 是概念词表与停用词表的固定版本号，词表改动必须同时改版本，保证 replay 可复现。参考实现不填这个字段。分数本身不出现在候选集里，`scoredCount` 也不是置信度（不变量 164）。harness 的候选集快照校验对该字段做形状校验（`builder` 必须等于产出它的 CandidateBuilder 名，`lexiconVersion` 非空，`scoredCount` 为不超过 `refs.length` 的非负整数）。

### 对 Jev provider 的约束（下一项的输入）

排序把相关元素放到前面，但排第一不代表它就是目标（见残余风险中的回声诱饵与 aria-label 塞词）。Jev provider 方案必须决定：如何抵消 LLM 的位置偏好（例如把 top-K 按 observation 顺序呈现，或不暴露名次）；自己的输入预算与上限；以及如何使用 `ranking.scoredCount`（例如 `scoredCount = 0` 时不应把排序当作信号）。本方案不替它决定；`CandidateSet.refs` 保持按分数排序，以便离线评测 Recall@K。

官方文档的依据（2026-11-06 阅读，见 https://docs.typesafe.ai/model-jaggedness.md 与 https://docs.typesafe.ai/api/system-one.md）：Jev 是 typesafe.ai 的 System One 托管模型，用 Choice 从 1～255 个选项中选一个并返回各选项概率；文档明确写到 Jev **倾向排在前面的选项**，建议打乱顺序重复验证；Jev **默认不把输入当作敌对内容**，输入中注入的指令会改变答案。因此 provider 方案至少要做到：不按本方案的分数顺序直接呈现选项（打乱或双序复核），选项必须限定在候选集内，confidence 只表示分布集中度、不是正确率，高风险动作仍走交接或审批。

### Eval（`packages/eval`）

- `foundationFixtures.ts`：`fixtureButton` 增加 `text` 选项（与运行期 DOM 源的 name / text 同源形态对齐）。
- `candidateFixtures.ts`：第三批 14 个 fixture，新 tag `candidate-ranking`。期望排序均按上文公式推算（推演脚本见审查记录），实现时逐条断言 `targetRank`：

| 名称 | 构造 | 期望（上限 20） |
|---|---|---|
| ranking-deep-target | 40 个导航链接，目标 “Billing history” 排第 37，goal “Open billing history” | 参考实现截断后漏召回；jev 排第 1 |
| ranking-generic-verb | goal “Open billing history”，候选 “Open” / “Billing history” | jev 排第 1（4.24 > 3.00） |
| ranking-lexicon-sign-out | goal “Sign out”，候选 “Sign in” / “Sign up” / “Account” / “退出登录” | jev 排第 1 |
| ranking-cjk-goal-sign-out | goal “退出登录”，候选 “Log in” / “Log out” | jev 排第 1，“Log in” 为 0 分 |
| ranking-view-details-cjk | goal “查看详情”，候选 “Open” / “View details” | jev 排第 1 |
| ranking-plural | goal “View invoices”，候选 “View profile” / “Invoice”（invoice 不在词表中，只靠复数归一命中） | jev 排第 1（3.00 > 2.12） |
| ranking-description | 3 个 “Delete”，goal 指名 description 中的行（合成数据） | jev 排第 1 |
| ranking-number | goal “Open page 12”，候选 Page 1 / Page 2 / Page 12 | jev 排第 1 |
| ranking-cjk-both | goal “提交订单”，候选 “取消订单” / “提交订单” | jev 排第 1 |
| ranking-no-overlap | goal “Proceed”，候选都不含相关词 | 与参考实现顺序完全相同 |
| ranking-decoy-flood | 25 个 “Pay” 排在 “Pay invoice” 之前，goal “Pay the invoice” | 参考实现截断后漏召回；jev 排第 1（4.24 > 3.00） |
| ranking-echo-decoy | goal “Open the account settings”，候选 “Open account settings now” / “Settings”，目标为 “Settings” | jev 把诱饵排第 1、目标排第 2（固定已知残余风险） |
| ranking-cjk-stopword | goal “点击我的订单”，候选 “我的” / “全部订单” | jev 排第 1（“我的”被停用，不再得分） |
| ranking-partial-overlap-pushout | goal “Pay the invoice”，目标 “Proceed” 排第 2，其后 25 个 “Invoice #n” | 参考实现排第 2；jev 在上限 20 下漏召回，`ranking.scoredCount = 20`（固定排序的固有代价） |

- `candidateBuilderComparison.test.ts`（provider 复用 `routerEvaluation.ts` 的 `escalateProvider`，只看 candidate 指标）：
  - **只重排**：上限都设为 500 时，三批每个 fixture 上 jev 的 `refs` 是参考实现 `refs` 的置换，`coverage` 与 `totalKnown` 完全相同；
  - **小上限对照**：两个 builder 都显式设 `maxCandidates = 20`，逐条断言第三批每个 fixture 的 `targetRank`（参考实现在 deep-target、decoy-flood 上为 `null`；jev 在 partial-overlap-pushout 上为 `null`），以及 jev 的 `ranking.scoredCount`，并断言两者的 `missCount`；
  - 第一批 `prompt-injection-label`、`cjk-goal-latin-label`、`latin-goal-cjk-label`、`destructive-neighbor` 的 `targetRank` 由 jev 排到 1；第一、二批其余 CLICK fixture 的 `targetRank` 不变差。

## 新增不变量

163. CandidateBuilder 只能重排与截断，不得改变候选资格：所有 CandidateBuilder 与 fixture 校验共用 `isClickCandidate`（可见、启用、带 click capability），coverage 规则同不变量 133。deterministic router 为给出分原因的 defer 而单独检查 click capability，不属于候选资格定义。
164. 相关度只来自 `microGoal` 与元素 `semantic`（name / description / text）的 unit 匹配及固定概念词表；不读取 `value`，不使用页面声明的能力或任何外部服务。排序、分数与 `scoredCount` 不构成授权或置信度。
165. 排序是确定的：同一输入得到同一输出，同分按 observation 顺序；没有任何 unit 命中时，结果与参考实现相同。有命中时排序可能把 0 分元素挤出上限——这是排序的固有代价，不得声称“不劣于参考实现”；候选集必须报告 `ranking.scoredCount` 与 `lexiconVersion`。

## 测试计划

`packages/router`：

- `unitsOf`：NFKC 全角、NFKC 之后截断、不可见字符删除、大小写；英文停用词与中文停用短语（`点击我的订单` 只剩 order 概念；`我的订单` 中的 `订单` 仍是概念）；`Settings设置` 按 script 分段；短语在去停用词之前匹配（`sign in`）；原词查概念、复数归一不查概念（`news` 不命中 create）；`ies→y` 与复数 `s`（`class`、`bus` 不被截断）；CJK 最长匹配（`退出登录` 只产出 sign-out，不产出 sign-in）；剩余汉字二字组与单字；中英混排串分段；
- 概念词表：每个写法都被 `unitsOf` 切成且只切成对应概念（数据自检）；
- `jevCandidateBuilder`，每条对应一种变异：
  - 字段权重：同一词分别在 name / description / text 命中时得分严格递减（杀“字段权重相等”）；
  - 长度归一：注入长句排在短名称之后（杀“去掉长度归一”）；
  - goal 重复同一词时得分不变（杀“目标 unit 重复累加”）；
  - “提交订单”与“取消订单”可区分（杀“汉字改为单字切分”）；
  - 同分保持 observation 顺序（杀“同分倒序”）；全 0 分时输出与参考实现相等；
  - eligibility 与参考实现逐元素一致（杀“加入禁用元素”）；截断与 coverage（`partial` 不提升、超上限变 `truncated`、`totalKnown` 为截断前总数；杀“超上限不标 truncated”）；`maxCandidates` 越界抛错；
  - 带值与不带值的元素得分相同；输入不被修改；
  - `ranking`：`builder`、`lexiconVersion` 固定值，`scoredCount` 等于截断后正分候选数（全 0 分时为 0）。

`packages/eval`：第三批 fixture 通过校验；对照测试（见上）；fixture 校验改用 `isClickCandidate` 后既有用例全绿；`ranking` 形状校验（`scoredCount` 超过 `refs.length` 或为负数时 builder 输出被拒）；`FIXTURE_TAGS` 新增的 `candidate-ranking` 由第三批覆盖（既有“每个 tag 都有覆盖”的测试合并三批）。

变异验证（实现阶段逐条执行并记录）：上列各项，加上去掉概念归并、去掉复数归一、短语改为去停用词之后匹配、复数归一结果查概念表、CJK 改为不做最长匹配、去掉中文停用短语、`scoredCount` 按截断前计数，每种都必须让至少一个测试变红。

## 改动清单

| 文件 | 改动 |
|---|---|
| `packages/router/src/candidateSet.ts` | 类型、常量与 `isClickCandidate`（由 builder 与 eval 的测试覆盖） |
| `packages/router/src/goalTerms.ts`（+ test） | unit 切分 |
| `packages/router/src/conceptLexicon.ts` | 概念词表数据（自检在 `goalTerms.test.ts`） |
| `packages/router/src/jevCandidateBuilder.ts`（+ test） | 打分、排序、截断 |
| `packages/router/src/index.ts` | 导出 |
| `packages/eval/src/candidateBuilder.ts` | 改为从 router 导入类型、常量与 eligibility 并再导出（`decisionHarness.ts` 的导入路径不变） |
| `packages/eval/src/decisionHarness.ts` | 候选集快照校验增加 `ranking` 形状校验 |
| `packages/eval/src/decisionFixture.ts` | target 校验改用 `isClickCandidate`；新 tag `candidate-ranking` |
| `packages/eval/src/foundationFixtures.ts` | `fixtureButton` 增加 `text` 选项 |
| `packages/eval/src/candidateFixtures.ts`（+ test）、`index.ts` | 第三批 fixture 与导出 |
| `packages/eval/src/candidateBuilderComparison.test.ts` | 两个 builder 的对照 |
| `packages/eval/src/decisionFixtures.test.ts` | tag 覆盖测试合并三批 fixture |
| `docs/INVARIANTS.md`、`EVAL.md`、`ROADMAP.md`、`PROGRESS.md`、`ARCHITECTURE.md`、`TRACE-EVAL-FOUNDATION.md`、`README.md` | 不变量 163～165、评测说明、阶段状态、候选类型的新位置 |

源码文件超过 8 个；全部为离线代码，不新增依赖（不改 `package.json` 与 lockfile），运行期行为不变。

## 验证命令

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Real Chromium E2E 不受影响（无运行期变化），由 CI browser-e2e 覆盖。

## 回滚

纯新增离线代码加一次类型迁移，revert 单个 PR 即可。

## 关键决策

1. **只重排、不增删资格**：candidate layer 的失败最难发现（Jev 看不到就永远选不到），所以资格规则保持与参考实现逐字一致，相关度只决定顺序；没有任何命中时退化为参考实现。部分命中时排序可能把 0 分的真目标挤出上限，这一代价如实写入不变量 165，由 `ranking.scoredCount` 暴露给下游。
2. **确定性 unit 匹配 + 小型概念词表，不引入模型**：项目是单一 TS 栈、没有外部模型依赖；排序需要可复现才能做离线评测与变异验证。词表只覆盖界面高频概念，解决中英混排这一已知 fixture 家族。
3. **长度归一化**：把目标词塞进长句是 prompt 注入与 SEO 式诱饵的常见形态，按字段 unit 数归一能让短而准的名称排前；它降低而不是消除操纵（见残余风险）。
4. **默认上限 50，与参考实现相同**：仓库没有 Jev 输入预算的定义，上限越小挤出问题越严重，所以不擅自收紧；更小的上限由 Jev provider 按预算显式传入。评测在上限 500 时逐 fixture 断言 jev 的结果是参考实现的置换，证明差异只来自排序；在相同上限 20 下对照两者的召回。
5. **类型放进 router**：运行期（shadow mode / fast_step）需要 CandidateBuilder，而 eval 依赖 runtime、不能被运行期依赖；router 是已有的决策层包，只依赖 core。
6. **概念与原词二选一、最长匹配不重叠**：同一个词既算原词又算概念会让通用动词压过有区分度的名词，二字组切开“退出登录”会同时命中相反的“登录”；unit 模型从源头排除这两类重复。

## 最脆弱的假设

本方案假设：**`microGoal` 与目标元素的可见名称在词面上有交集（直接、复数归一或概念词表）**。更糟的情形是**部分命中挤出**：goal 与真目标毫无交集，却与页面上大量其它元素部分相交（goal “Pay the invoice”，目标 “Proceed”，页面有 25 个 “Invoice #n”），排序会把真目标挤出上限，而参考实现本来能看到它（`ranking-partial-overlap-pushout` 固定这一行为）。如果真实目标的措辞与 goal 完全不同（goal “去付钱”，按钮 “Proceed”），排序退化为 observation 顺序；当可点击元素多于上限时，目标可能被截掉（candidate-miss + `truncated`，Jev 只能升级）。这不放行任何动作，但会降低有用性。对策：评测里保留 `ranking-no-overlap` 与 `ranking-deep-target` 两个对照，offline replay 用真实数据量化这种失败的比例，再决定是否扩充词表或调整上限。

## 残余风险

- **排序操纵**：页面可以放大量与 goal 同名的短元素（`ranking-decoy-flood`），把真正的目标挤出上限。结果是 candidate-miss 且 coverage 为 `truncated`，Jev 应当升级；不会产生错误点击。排序不是授权，执行仍经 policy、grant、审批与 Strict preflight。
- **回声诱饵**：页面放一个复述 goal 的元素（goal “Open the account settings”，诱饵 “Open account settings now”）会排在真正的 “Settings” 之前（`ranking-echo-decoy` 固定了这一行为）。目标仍在候选内，由 Jev 判断；Jev provider 必须抵消位置偏好（见「对 Jev provider 的约束」）。
- **textContent 通道**：`name` / `text` 来自 textContent，可以包含肉眼不可见的子节点文本，页面能借此塞词；text 权重最低，name 中的塞词受长度归一化约束。
- **aria-label 通道**：DOM 源的 `name` 优先取 aria-label（`domFrameSource.ts`），它对用户不可见却拿最高权重；可见文本 “Sponsored”、aria-label “Account settings” 的元素在 goal “Open the account settings” 下得 4.24，高于真正的 “Settings” 3.00。打分公式无法区分 aria-label 与可见文本，目标仍在候选内，由 Jev 判断。
- **长文本卡片**：可见文本很长的卡片链接（例如 10 个 unit）即使命中也只得约 1.9 分，会被短导航名压到后面；是部分命中挤出在运行期的常见形态。
- **同分并列**：goal 含两个概念、各命中一个候选时同分（goal “Sign out of the account” 下 “Account” 与 “退出登录”），只能按页面顺序决出先后。
- **概念词表覆盖面**：只覆盖 20 个高频概念，其余跨语言场景退化为参考实现顺序。
- **Unicode 版本**：NFKC 与 script 属性依赖运行时 ICU 版本，与 router 名称比较键相同。

## 审查记录

check 审查一轮（方案初稿；推演脚本按公式实算），发现均已核实并并入：

- HIGH：登出概念跨语言排序倒置——多词短语命中后组成词仍各自计分，二字组把“退出登录”切出“登录”而命中相反的 sign-in，字段词项数被撑大 → 改为 unit 模型：概念与原词二选一，短语与 CJK 写法最长匹配、不重叠，概念算一个 unit，词表加入“退出登录”；修订后 “退出登录” 下 Log out 3.00、Log in 0；
- HIGH：对照测试前提错误——参考实现默认上限是 50，deep-target 与 decoy-flood 都不会被截断；ESCALATE 可接受时归因为 ok 而非 candidate-miss → 对照时两者显式设上限 20，断言 `targetRank` 与 `missCount`，不断言 attribution；decoy-flood 改为可区分的 “Pay invoice”；
- MEDIUM：原词与概念重复计分，通用动词压过名词，`news` 复数归一后命中 create → unit 二选一；复数归一结果不查概念表；`open` 与 `view` 拆开；新增 `ranking-generic-verb`、`ranking-view-details-cjk`；
- MEDIUM：运行期不产出 description，`text` 来自 textContent，`fixtureButton` 没有 text 选项 → 写明运行期字段来源，`foundationFixtures.ts` 加入改动清单，textContent 塞词写入残余风险；
- MEDIUM：“上限 50 时 Recall@all 相等”几乎恒真 → 改为上限 500 时逐 fixture 断言置换、coverage 与 totalKnown 相同；
- MEDIUM：回声诱饵能排到第一，叠加 LLM 位置偏好 → 新增 `ranking-echo-decoy` 固定行为，写入残余风险，并把“抵消位置偏好”列为 Jev provider 方案的约束；
- LOW：NFKC 后再截断；三种在 fixture 层会存活的变异指定由哪条单测杀死；复用 `escalateProvider`；fixture 校验改用 `isClickCandidate`；jev 默认上限用独立常量；词表数量与表格对齐为 20 个概念；
- 已核实成立：类型迁移无环（router 只依赖 core，eval 已依赖 router）；163 是下一个空号；第一、二批 21 个 CLICK fixture 在 jev 下没有一个变差。

Fable 5.1 编排评估一轮（修订稿；子代理用脚本复算 fixture、核对接口与改动清单、做对抗分析），结论“路线保留、方案调整”，发现均已并入：

- HIGH：“最差不比今天差”不成立——部分命中的元素会把 0 分的真目标挤出上限 → 改写决策 1 与不变量 165，新增 `ranking-partial-overlap-pushout` 固定行为，候选集新增 `ranking.scoredCount` 与 `lexiconVersion`；
- MEDIUM：默认上限 20 无依据 → 改为与参考实现相同的 50，更小的上限由 Jev provider 显式传入；中文无停用词（“点击我的订单”下 “我的” 抢先）→ 新增 7 个中文停用短语与 `ranking-cjk-stopword`；候选集缺少 replay / shadow mode 需要的排序信号 → `ranking` 可选字段；aria-label 塞词 → 写入残余风险；拉丁段正则会吞汉字 → 明确按 script 分段；
- LOW：改动清单补 `TRACE-EVAL-FOUNDATION.md`、`README.md`、`decisionHarness.ts`、`decisionFixtures.test.ts`；`ranking-plural` 原本测的是词表，改用不在词表中的 invoice；500 码点截断在运行期不生效，注明为防御；长文本卡片写入残余风险；英文停用词定为 24 个；
- advisory（未采纳删减）：复数归一、二字组、字段权重等机制在 fixture 层不会被杀死，但测试计划已为每个机制配了能杀死它的单测，因此保留；description 权重保留给将来的数据源；
- 已核实成立：12 个 fixture 与第一批 4 个点名 fixture 由公式复算一致，第一、二批 21 个 CLICK fixture 无一变差，69 个词表写法自检通过，eligibility 迁移等价，依赖无环。

## 实现记录

- 第三批 14 个 fixture 的名次与上表预期逐条一致，`candidateBuilderComparison.test.ts` 逐条断言；第一批 4 个点名 fixture 由 jev 排到 1，第一、二批 CLICK fixture 名次无一变差；
- `nameMatch.ts` 导出 `INVISIBLE_CHARACTERS`，unit 切分与名称比较键共用同一不可见字符集；
- `checkedMaxCandidates` 由两个 builder 共用，上限校验只有一处实现。

变异验证（`packages/router` + `packages/eval` 测试，25 种）：

| 变异 | 结果 |
|---|---|
| 去掉长度归一、字段权重相等、各字段累加而非取最佳、同分倒序、去掉分数量化、超上限不标 `truncated`、`scoredCount` 按截断前计数、资格放行禁用元素 | 全部抓到 |
| 汉字单字切分、去掉英文概念、去掉中文概念、去掉复数归一、去掉短语匹配、复数归一结果查概念表、去掉中文停用短语、去掉英文停用词、拉丁段吞汉字、拉丁词不含组合附加符、长音符不并入 CJK、句末标点不打断短语、在 NFKC 之前截断、去掉 NFKC | 全部抓到 |
| harness 放行超过候选数的 `scoredCount`、harness 不校验 `ranking.builder` | 全部抓到 |
| 中文写法不做最长匹配 | **等价变异**：当前词表没有任何中文写法是另一写法的前缀，排序与否结果相同；排序保留为词表演进的防线，新增前缀写法时由“每个写法都切成它自己的概念”的自检兜底 |

### 代码审查（check）

一路独立审查（正确性 + 对抗 + 架构），0 HIGH，发现均已核实并处理：

- MEDIUM：片假名长音符 U+30FC 的 script 是 Common，“コーヒー” 被切碎，所有带长音的片假名词共享 `w:ー` → 并入 CJK 字符类，新增用例；
- LOW：数学上同分因浮点误差排反 → 分数量化到 1e-9；CJK 段切分是二次复杂度（反复对剩余串 `Array.from`）→ 按 UTF-16 偏移线性推进，name 与 text 相同时只切分一次；拉丁词不含组合附加符，天城文与 `İ` 被切碎 → 字符类加入 `\p{M}`；“NFKC 之后截断”的用例是空测 → 改用会被 NFKC 展开的 U+337F；
- advisory（采纳）：句末标点打断英文短语；去掉“的”“请”两个单字停用词（词表版本升到 `2026-11-06.2`）；不变量 163 收窄措辞，注明 deterministic router 的例外；harness 校验 `ranking.builder` 与 builder 名一致、`lexiconVersion` 非空；
- 修复中发现：ranking 形状用例同时违反两条规则，“scoredCount 过大”的校验被 builder 名校验遮住而未被测到 → 每条用例只违反一条规则。
