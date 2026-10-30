# Strict 写入类动作：setValue / selectOption / submit / pressKey

状态：方案经独立对抗式审查一轮（S1 3 HIGH、S2 1 HIGH、若干 MEDIUM / LOW，已全部并入下文）；S1 已合并（PR #19）；S2 方案已对照代码细化（含 spike），待审查；S3 待批准
最后更新：2026-10-30

## 为什么做

现在执行面只有 Strict Click。感知层已经给文本框标了 `setValue`、给下拉框标了 `selectOption`（`apps/extension/src/content/domFrameSource.ts` 的 `capabilitiesFor`），`BrowserActionKind` 里也有这些类型，但授权、执行、协议、broker 都只认 click。旧项目（`browser-agent`）的核心价值是表单填写，不补这块，Phase 7 的 `HANDOFF_FORM` 交接出去也没有能执行的路径。

## 目标与不做

做：

- 可信控制面上的 Strict `setValue`（原生单行文本类 `<input>` 与 `<textarea>`）、`selectOption`（原生单选 `<select>`）、`submit`（对目标所属表单 `requestSubmit()`）、`pressKey`（不含提交语义的少量按键）；
- 授权 grant 绑定动作参数；operator 审批页显示将要执行的具体动作与参数；
- 最后一步把这些动作经 Act broker 开放给模型（默认不开放，且写入类动作强制 operator 审批）。

不做（每项都有原因）：

- **自定义组件**（antd / arco 的 Select、DatePicker、Cascader、富文本、contenteditable）：它们的“值”不在原生控件上，需要组件适配器或 recipe，属于 Phase 8 能力层；模型仍可用 click 序列操作它们；
- **凭据与支付字段**：`type=password` 与凭据 / 支付类 `autocomplete` 字段一律拒绝。审批页必须显示要填的值，而这类值不应出现在任何界面上；需要时另立设计；
- **多行文本**：`execCommand("insertText")` 对含换行的文本会拆成多个编辑步骤，页面监听器可以在步骤之间移动焦点，破坏“只写入被识别元素”的保证；S1 只接受单行值（textarea 也只能写入单行），逐行写入并逐行复核焦点的方案以后单独做；
- **跨进程 iframe（OOPIF）中的写入**：输入焦点跨进程路由没有被证明前一律 fail closed；同进程 child frame 支持；
- **enterprise-policy 签发写入动作**：企业 assertion 的签名结构绑定的是 click，扩展它需要改动受管签名格式，不在本次范围；
- **effect 分类器**：写入类动作仍按 `unknown` effect 处理（见“关键决策”）。

## 拆分

三个 PR，按顺序交付，每个合并后系统都完整可用：

| PR | 内容 | 对模型可见 |
|---|---|---|
| S1 | 动作参数模型、grant 参数绑定、独立的 strict-action 协议、可信路径 Strict `setValue`、审批页显示、真实 Chromium E2E | 否 |
| S2 | Strict `selectOption`（原生单选 `<select>`）、`submit`、`pressKey` | 否 |
| S3 | Act broker 与 MCP `browser.act` 开放写入类动作（强制 operator 审批）；结果管线；trace 映射；wire 测试 | 是（默认不暴露） |

---

## S1：参数绑定与 Strict setValue

### 动作参数

`packages/core` 新增：

```ts
export type StrictActionArgs =
  | { kind: "click" }
  | { kind: "setValue"; value: string };   // S2 增加 selectOption / submit / pressKey

export const STRICT_VALUE_MAX_LENGTH = 1_024;

/** 规范化为确定的字符串：固定字段顺序。grant 用它做精确匹配。 */
export function canonicalStrictActionArgs(args: StrictActionArgs): string;

/** 入口校验：exact-key、长度与字符集（见下）；失败抛 BrowserRuntimeError("POLICY_BLOCKED")。 */
export function parseStrictActionArgs(value: unknown): StrictActionArgs;
```

**值的字符集**（目的：审批页显示的就是将要输入的全部内容）。拒绝：

- `Cc` 控制字符（含 `\n`、`\t`——S1 只写单行）；
- `Cf` 格式字符与所有 `Default_Ignorable_Code_Point`（零宽字符、bidi 覆盖与隔离、变体选择符、Hangul filler 等不可见字符）；
- 行 / 段分隔符（`Zl`、`Zp`）与除 U+0020 以外的空格分隔符（`Zs`，如 NBSP——显示上与普通空格无法区分）；
- U+2800 Braille Pattern Blank：类别为 `So`、不是默认可忽略字符，但常见字体中渲染为空白；
- 孤立代理项。

代价：含变体选择符的 emoji 无法通过 setValue 输入，接受。长度上限 1024 个 UTF-16 单元：足够表单单行字段，也让审批页能完整显示。

### 感知：标出敏感字段

`ElementState.state` 增加 `sensitive?: true`，由 DOM 源对以下 `<input>` / `<textarea>` 设置：`type=password`；`autocomplete` 含 `current-password` / `new-password` / `one-time-code` / `cc-*`；计算样式 `-webkit-text-security` 不为 `none`（“显示密码”切换后的输入框或自绘密码框常用它遮盖输入）。semantic merge 的 state 字段以 DOM 优先，AX 不产生这个字段。它只是一个布尔标记，不含值。写入函数在页面内使用同一组判定。

这是按已知形态列举的判定，不是对“敏感”的完备定义：没有任何标记、只靠页面文案说明用途的输入框不会被识别。

capability 按并集合并（AX 会给 password 框加上 `setValue`），因此不能靠“不给 capability”排除敏感字段，必须看这个标记。

### grant 绑定参数

`packages/policy` 的 `InMemoryAuthorizationStore`：

- `AuthorizationGrant`、`IssueAuthorizationInput`、`ConsumeAuthorizationInput` 增加 `actionArgs: string`（`canonicalStrictActionArgs` 的结果）；
- `consume` 要求 `actionKind` 与 `actionArgs` 都与 grant 精确相等，否则 `binding-mismatch`；
- 现有 click 签发路径统一传 `canonicalStrictActionArgs({ kind: "click" })`。

grant 只存在扩展内存中，存规范化后的原文即可，不做摘要：比较简单、确定，摘要不能减少任何暴露面。

### 协议：独立的 strict-action 消息

**不在现有 click 消息上加可选字段**：现有校验器不拒绝多余 key、ingress 只复制已知字段，旧扩展会忽略 `action` 而把写入请求签发 / 审批 / 执行成 click，调用方还会收到 `executed`。因此新增三条消息，旧扩展遇到会以未知类型拒绝：

| 新消息 | 字段 |
|---|---|
| `authorization.issue-strict-action` | `authorizationId, tabId, observedRevision, ref, ttlMs, action` |
| `authorization.request-strict-action-approval` | 同上 + `approvalTtlMs?` |
| `execution.execute-strict-action` | `actionId, authorizationId, tabId, observedRevision, ref, action, verification, verifyTimeoutMs?` |

- 全部 exact-key 校验，`action` 经 `parseStrictActionArgs`；`action.kind === "click"` 也接受（同一入口签发 click），旧的 click 消息保持原样继续可用；
- `browser.act` 的 `action.kind` 接受 `setValue`，并要求 `action.value`；旧扩展的 `isBrowserActAction` 只接受 click，同样 fail closed；
- 状态查询（`authorization.operator-approval-status`）与撤销（`authorization.cancel-strict-click`，按 authorizationId，与动作无关）沿用；
- native host 只校验信封（`type` / `requestId` 为非空字符串）后原样转发，不做类型白名单——无改动；
- `packages/core` `BrowserActInput.action` 增加 `value?: string`；
- `apps/mcp-server/src/trustedRuntimeClient.ts` 在 S3 再接入。

E2E 增加一条版本错配用例：向扩展发送带 `action` 字段的旧 click 消息不会产生写入（证明旧路径不会把写入当 click 执行的前提成立）。

### 签发与审批

`StrictClickAuthorizationIssuanceService`（保留历史名称，避免与本变更无关的重命名）的签发输入增加 `action?: StrictActionArgs`（缺省为 click）：

- control-plane 与 operator-approved 两条路径都接受 setValue；enterprise-policy 路径仍只签发 click；
- **签发前（也是审批请求入队前）按 retained observation 提前拒绝**，在 grant 被消耗或审批页显示任何值之前：
  - 目标没有 `setValue` capability → `TARGET_CAPABILITY_MISSING`；
  - `state.sensitive === true` → `POLICY_BLOCKED`（审批页永远看不到凭据值）；
  - `state.readonly === true`、`state.enabled === false`、role 为 `spinbutton` → `ACTION_NOT_SUPPORTED`；
  - 目标不是 DOM + AX 双源确认的元素（`provenance.dom` 缺失）→ `ACTION_NOT_SUPPORTED`；
- effect 固定 `unknown`，最低 assurance 规则与 click 相同。

`OperatorApprovalStore` 的 pending 记录与 `OperatorApprovalSummary` 增加 `action: StrictActionArgs`；批准时用同一个 `action` 签发。审批页（`apps/extension/src/operator-approval/`）：

- 卡片标题按动作显示“待批准的点击” / “待批准的填写”；
- setValue 显示“将要填写的内容（来自调用方，非页面）”，与不可信页面文本使用不同样式；值**完整显示**在 `white-space: pre-wrap` 的框中，附“共 N 个字符”，首尾空格用可见标记提示；只经 `textContent` 写入；
- 空字符串显示为“（清空该字段）”。

### 执行：`PolicyGatedStrictActionExecutor`

`PolicyGatedStrictClickExecutor` 泛化为按动作分派的执行器，click 路径逐行不变。前置改动：

- `ChromeStrictMainFrameClickResolver.resolve` 目前对非 click 直接返回 identity mismatch，改为接受 `setValue`（身份复核完全相同）；
- `evaluateStrictPreflight` 的几何检查（在视口内、hit-test 命中目标）扩展到 setValue：用户点不到的字段，调用方也不应能写。

setValue 的流程：

1. **第一次 Strict prepare**（与 click 相同）；
2. **授权**：用 `actionKind: "setValue"` 与 `actionArgs` 消费 grant，effect `unknown`，`evaluateEffectPolicy` 同 click；
3. **第二次 Strict prepare**，并且在任何输入之前：
   - 目标位于 OOPIF child session（`prepared.cdpSessionId !== undefined`）→ `ACTION_NOT_SUPPORTED`；
   - grant 到期复核（同 click）；
4. **确定唯一的写入上下文**：在目标帧的执行上下文中只选 `auxData.type === "isolated"` 且 `origin === "chrome-extension://" + 本扩展 id` 的那一个；不是恰好一个 → `TARGET_IDENTITY_MISMATCH`（尚未调用任何页面函数）。**不复用只读检查器“逐个上下文尝试”的循环**：写入函数一旦在某个上下文运行过，就不能再换一个上下文重试；
5. **单一 isolated-world task 完成写入**：在该上下文中取 DOM identity bridge（`globalThis[DOM_IDENTITY_BRIDGE_KEY]`），校验 `version` 与 `frameEpoch`，然后调用一个固定的 `functionDeclaration`（不接受任何调用方 JS），在同一个 JS task 内依次：
   1. `this.resolve(stableId)` 得到元素，确认仍连接在文档中；
   2. **字段检查**（`checkField`，任一不满足即返回 `rejected`，此时尚未触碰页面）：
      - `HTMLTextAreaElement`，或 `type` ∈ {`text`, `search`, `email`, `url`, `tel`} 的 `HTMLInputElement`（缺省 type 视为 text）；
      - 非 `readOnly`、非 `:disabled`、无 `aria-disabled="true"`、不在 `[inert]` 内、可见；
      - 非敏感字段（password、凭据 / 支付 `autocomplete`）；
   3. `element.focus({ preventScroll: true })`——**从这里开始，页面回调可能已经运行，之后的任何异常都是 outcome unknown**；
   4. 确认 `element.getRootNode().activeElement === element`（覆盖 shadow root），否则返回 `focus-lost`；
   5. **再次执行 `checkField`**：页面的 focus / focusin 回调可能已把字段改成 password、只读或改了 type，不通过返回 `changed-during-focus`；
   6. 若 `value === ""` 且字段已为空，直接返回 `{ status: "written", accepted: true, valueMatched: true }`（`execCommand("delete")` 在空字段上返回 false，不应被当成失败）；
   7. `element.select()`，然后 `document.execCommand("insertText", false, value)`（`value === ""` 时用 `"delete"`）；
   8. 返回 `{ status: "written", accepted, valueMatched: element.value === value }`。

   焦点确认、复核与插入在同一个 task 内完成，单行文本只产生一次编辑步骤，页面脚本没有机会在两者之间移动焦点：**文字要么进入被识别的那个元素，要么不进入任何元素**。`execCommand("insertText")` 产生浏览器生成的 `input` 事件（`isTrusted === true`，`inputType === "insertText"`），受控组件（React 等）能正常收到；Chrome 的 `execCommand` 不派发 `beforeinput`。
6. **结果映射**（只有 `rejected` 是安全的“什么都没发生”）：

| 情形 | 结果 |
|---|---|
| 写入上下文不唯一、bridge 缺失或 `frameEpoch` 不符（调用写入函数之前） | `TARGET_IDENTITY_MISMATCH` |
| `rejected`（敏感字段） | `POLICY_BLOCKED` |
| `rejected`（其它） | `ACTION_NOT_SUPPORTED` |
| `focus-lost`、`changed-during-focus` | `ACTION_OUTCOME_UNKNOWN` |
| 调用写入函数的 CDP 请求失败、返回 `exceptionDetails` 或返回值结构不符 | `ACTION_OUTCOME_UNKNOWN` |
| `written` 且 `accepted === false` | `ACTION_OUTCOME_UNKNOWN` |
| `written` 且 `accepted === true` | 执行成功，结果带 `valueMatched` |

   `ACTION_OUTCOME_UNKNOWN` 是唯一会让上层（trusted host 与 Act broker）禁止自动重试、并让 broker 降级该 tab 的错误码；focus 已经发生时一律用它，不用 `TARGET_*` 这类看起来可重试的码。
7. 不 blur、不按 Tab：离开字段的行为（可能触发校验或自动保存）由调用方用后续动作显式决定。

执行结果只带 `valueMatched` 布尔值，**从不回显值本身**；错误为固定文本。

动作后验证是一次普通的 observation，遵循 trusted 路径与 model-facing 路径既有的划分：trusted 路径的 observation 本来就含字段当前值（`includeValues` 决定 DOM 源是否读取值，但 AX 源总会给出文本框的 value；model egress 层再按 `includeValues` 去掉 `value`），调用方若在 verification 中写 `field_value` 条件，evidence 的 `observed` 会是字段写入后的实际值——这与它直接调用 `browser.observe` 能读到的内容相同，不构成新的出口。model-facing 路径的 `sanitizedVerification` 去掉 `observed`、`sanitizedElement` 按 `includeValues` 去掉 `value`，S3 开放时沿用。（方案初稿写“不打开 includeValues 即 inconclusive”，代码审查证明不成立，已更正。）

### 背景标签页与 Playwright 的局限

`element.focus()` 在后台页面中仍会改变 `activeElement`，`execCommand` 作用于 `activeElement`，理论上不依赖窗口焦点。但 Playwright 会对它接管的页面开启焦点模拟（`document.hasFocus()` 恒为 true），因此 **E2E 不能证明“真实浏览器后台标签页”下的行为**，只能证明扩展 isolated world 中的写入链路；这一点在 E2E 与 PROGRESS 中写明。

### 新增不变量（S1，含实现阶段新增的 146）

138. Strict 动作的 grant 必须精确绑定规范化的动作参数（`actionKind` + `actionArgs`）；消费时参数不完全相同即 `binding-mismatch`，为一个值签发的 grant 不能用于输入另一个值。
139. 写入类动作必须使用独立的 strict-action 协议消息；不得在既有 click 消息上以可选字段承载写入参数（旧实现会忽略未知字段而执行 click）。
140. setValue 的焦点确认、字段复核与插入必须在同一个 isolated-world task 内完成，只作用于由强身份解析出的元素，只在唯一确定的本扩展 isolated world 中运行；绝不向“当前恰好有焦点的元素”发送输入，也不在另一个上下文中重试。
141. 敏感字段（`type=password`、`<input>` / `<textarea>` 上的凭据 / 支付类 `autocomplete`、`-webkit-text-security` 遮盖）的写入必须在签发与审批请求阶段就被拒绝，审批页永远不显示这类字段的待写入值；执行时在 focus 前后各复核一次，页面内复核与感知层使用同一组判定。
142. 动作参数在所有入口拒绝控制字符、格式字符与所有默认可忽略字符、行 / 段分隔符、非 U+0020 的空格分隔符、U+2800 与孤立代理项；operator 审批页必须完整显示将要输入的值（不截断、不设高度上限），并与页面派生文本分开标注来源；清空字段的说明显示在值框之外，不能与任何字面量值混淆。
143. 写入类动作的 effect 保持 `unknown`，最低 assurance 与 click 相同；在 effect 分类器能证明更窄的 effect 之前不得降级。
144. 写入类动作的执行结果与错误不得回显输入值；只允许返回 `valueMatched` 这样的布尔执行证据。动作后验证的 evidence 属于 observation，按既有 trusted / model-facing 划分处理：model-facing 出口必须去掉 `observed` 与未获允许的 `value`。
145. focus 一旦执行，之后的任何失败都必须报告为 `ACTION_OUTCOME_UNKNOWN`；目标位于 OOPIF child session 的写入在任何输入之前 fail closed（`ACTION_NOT_SUPPORTED`）。
146. Strict 命中测试必须在目标自身所在的 tree scope（`getRootNode()`，document 或 shadow root）上进行：`document.elementFromPoint` 会把 shadow tree 内的命中重定向为 shadow host，使 shadow root 内的目标永远判为遮挡；按 tree scope 测试时，覆盖在目标之上的同一 shadow root、外层 tree 或其它 shadow host 中的元素仍然不等于、也不包含目标，照样判为 `TARGET_OCCLUDED`。该规则同时适用于 click 与 setValue。

### 威胁模型（S1）

| # | 威胁 | 对策 |
|---|---|---|
| W1 | 批准“填 A”的 grant 被用来填 B | grant 绑定 `actionArgs`，精确匹配（138） |
| W2 | 旧扩展把写入请求当 click 签发 / 审批 / 执行 | 独立消息类型，旧扩展以未知类型拒绝（139）；E2E 覆盖 |
| W3 | 页面在检查后、插入前把焦点移到别的字段 | 焦点确认、复核与插入在同一 task；只写单行；不用 CDP 输入（140） |
| W4 | 页面在 focus 回调里把字段变成 password 或只读 | focus 后在同一 task 内复核字段，不通过报 outcome unknown（140、145） |
| W5 | 审批页显示的内容与实际输入不同（不可见字符、相似空格、截断） | 入口拒绝不可见 / 相似字符；完整显示 + 字符数 + 首尾空格标记（142） |
| W6 | 凭据值出现在审批页或被写进密码框 | 感知标记 `sensitive`（password、input / textarea 的凭据 autocomplete、`-webkit-text-security`），签发与审批请求阶段拒绝；执行时双重复核（141） |
| W7 | 写入函数在一个上下文运行后又在另一个上下文重试 | 只选唯一的本扩展 isolated world，不循环（140） |
| W8 | focus 副作用后被当成可重试的失败 | focus 之后一律 `ACTION_OUTCOME_UNKNOWN`（145） |
| W9 | 动作被重放或迟到执行 | 沿用 grant 单次消费、TTL、navigation / tab 关闭撤销、二次 prepare |
| W10 | 写入触发自动保存等外部副作用 | effect 保持 `unknown`，需要与 click 相同的授权（143）；执行后不自动 blur / Tab |
| W11 | 执行结果、错误或验证证据把值带回 | 结果只有 `valueMatched`；错误为固定文本；动作后验证不打开 includeValues（144） |
| W12 | OOPIF 中输入路由未经证明 | fail closed（145） |

已接受的残余：`element.focus()` 会触发页面的 focus / blur 回调（之前有焦点的字段的 blur 处理可能做任何事）——这正是 focus 之后的失败一律为 outcome unknown 的原因；页面可以在 `input` 事件里改写值，`valueMatched` 会如实反映；页面在 prepare 之后、写入 task 之前把字段设为 `inert` / 隐藏，由 task 内的字段检查拒绝。

### 测试计划（S1）

单元：

- `parseStrictActionArgs` / `canonicalStrictActionArgs`：合法 click / setValue；拒绝未知 kind、多余 key、超长值、每一类被拒字符（含 `\n`、NBSP、U+2028、Hangul filler、零宽字符、bidi、孤立代理项）；规范化结果确定；
- `InMemoryAuthorizationStore`：参数不同、kind 不同时 `binding-mismatch`；click grant 不能用于 setValue，反之亦然；
- 感知：password / 凭据 / 支付 autocomplete 输入框带 `state.sensitive`；普通输入框不带；merge 后保留；
- 签发服务：缺 capability、sensitive、readonly、disabled、spinbutton、缺 DOM provenance 各自在签发前拒绝；enterprise 路径拒绝非 click；
- `OperatorApprovalStore`：summary 带 action；批准用同一 action 签发；sensitive 目标在入队前被拒绝；
- 协议：三条新消息 exact-key 校验、`action` 的各种非法形状被拒绝；旧 click 消息不受影响；`browser.act` 的 setValue 需要 value；
- 执行器：授权消费参数、两次 prepare、OOPIF 拒绝、写入上下文选择（零个 / 多个 / 其它扩展的 isolated world）、每一种写入函数返回值与 CDP 失败到错误码的映射、结果不含值；click 路径既有测试全部不变；
- 审批页：动作标题、值完整显示、字符数、首尾空格标记、空值文案、只经 `textContent`。

Real Chromium E2E（新 fixture `strict-write.html`）：

- 文本框写入成功：页面收到的 `input` 事件 `isTrusted === true`、`inputType === "insertText"`，`valueMatched === true`；
- textarea 单行写入；覆盖已有内容；空值清空非空字段；已为空的字段写空值成功；
- 同进程 child frame 中的输入框写入成功；open shadow root 内的输入框写入成功；
- focus 回调把焦点移到另一个输入框：另一个输入框保持为空，`ACTION_OUTCOME_UNKNOWN`；
- focus 回调把 type 改成 password：字段保持原值，`ACTION_OUTCOME_UNKNOWN`；
- password 字段、`autocomplete="one-time-code"` 的 textarea、`-webkit-text-security` 遮盖的输入框：签发即被拒绝（`POLICY_BLOCKED`），字段从未获得焦点（`focusin` 记录，以确实写入过的字段作对照）；
- focus 回调给字段加上 `-webkit-text-security`：字段保持为空，`ACTION_OUTCOME_UNKNOWN`；
- open shadow root 内的字段被光照 DOM 遮罩或同一 shadow root 内的遮罩覆盖：`TARGET_OCCLUDED`；shadow root 内的按钮经新消息（`action: { kind: "click" }`）Strict click 成功；
- readonly / number 字段：签发即被拒绝；被遮罩覆盖的字段：`TARGET_OCCLUDED`，无输入；
- 用“A”的 grant 执行“B” → `AUTHORIZATION_REQUIRED`，字段不变；
- 带 maxlength 的字段：执行成功，`valueMatched === false`；
- 版本错配：带 `action` 字段的旧 click 消息不产生写入；
- operator 审批页：显示“待批准的填写”与完整值，页内批准后执行成功。

### 验证命令

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
```

### 回滚

S1 不改变任何现有 click 消息的行为；revert PR 即可，无数据迁移。

### S1 实现记录

- E2E 证实了最脆弱的假设：扩展 isolated world 中 `execCommand("insertText")` 产生 `isTrusted` 的 `insertText` 输入事件，焦点抢夺与 focus 回调改类型都在同一 task 内被拒绝。
- E2E 暴露一处既有缺陷：Strict 命中测试用 `document.elementFromPoint`，shadow root 内的目标一律判为遮挡（click 同样受影响）。改为在目标自身的 tree scope 上测试（不变量 146），并补了光照 DOM 遮罩、同一 shadow root 内遮罩两条反例；这同时让 Strict click 可以作用于 open shadow root 内的元素。
- 代码审查（check + 独立对抗式审查）：0 HIGH；1 MEDIUM（方案中“验证不回显值”的说法与 trusted 路径 AX 值不符——经核实是文档错误而非新出口，已更正说明与不变量 144）；3 LOW 已修复：U+2800 可伪装成空格、清空说明与字面量值同框、值框高度上限导致需滚动才能看全；textarea 的凭据 autocomplete 与 `-webkit-text-security` 遮盖未被识别为敏感；命中测试修正缺少遮挡反例。
- 已知且接受：签发阶段无法预知的拒绝（`contenteditable`、OOPIF）发生在 grant 消费之后，浪费一次授权但 fail closed。

---

## S2：selectOption、submit 与 pressKey

S2 只在 trusted 路径开放，沿用 S1 的协议消息（`authorization.issue-strict-action` 等三条）、grant 参数绑定、两次 prepare、OOPIF fail closed 与结果不回显参数的规则。动作名与 `BrowserActionKind` 一致（`selectOption` / `submit` / `pressKey`），grant 的 `actionKind` 直接取参数的 `kind`，不做映射。

### 参数

```ts
export type StrictActionArgs =
  | { kind: "click" }
  | { kind: "setValue"; value: string }
  | { kind: "selectOption"; label: string }      // 非空，字符集同 setValue
  | { kind: "submit" }
  | { kind: "pressKey"; key: "Escape" | "Tab" | "ArrowUp" | "ArrowDown" };
```

`parseStrictActionArgs` 对每种 kind 做 exact-key 校验；`canonicalStrictActionArgs` 固定字段顺序。S1 扩展收到 S2 的 kind 时，`parseStrictActionArgs` 以未知 kind 拒绝（`INVALID_TRUSTED_HOST_REQUEST`），不会把新动作误解为别的动作。trusted `browser.act` 的 `action` 增加 `label?` / `key?`，`isBrowserActAction` 把 `kind` 与这三个可选字段拼成参数后交给同一个 `parseStrictActionArgs`，因此 click 带 `label`、selectOption 带 `value` 等组合都会被拒绝。

### 感知

- **`submit` capability**：DOM 源对拥有 form owner（`element.form !== null`）的提交按钮（`<button type=submit>`、`<input type=submit|image>`）与表单字段（已有 setValue / selectOption / check capability 的元素）增加 `{ kind: "submit" }`。目前没有任何感知源产生这个 capability，而 preflight 的 `requiredCapability("submit")` 要求它；补上它也让签发阶段能在不消耗 grant 的情况下拒绝不在表单里的目标。AX 源不产生，merge 按并集保留 DOM 的结果。
- **敏感 `<select>`**：`isSensitiveField` 对 `HTMLSelectElement` 同样检查凭据 / 支付类 autocomplete（`cc-exp-month` 等常见于下拉框）。

### 签发前的早期拒绝（`assertStrictActionTarget`）

| 动作 | 拒绝条件 |
|---|---|
| selectOption | 缺 `selectOption` capability（`TARGET_CAPABILITY_MISSING`）；`sensitive`（`POLICY_BLOCKED`）；禁用或非 DOM 来源（`ACTION_NOT_SUPPORTED`） |
| submit | 缺 `submit` capability；禁用或非 DOM 来源 |
| pressKey | 禁用或非 DOM 来源 |

retained observation 不含 `<option>` 列表、不区分原生 `<select>` 与 ARIA combobox，所以“选项不存在”和“自定义组件”只能在执行时发现，此时 grant 已消耗——与 S1 中 `contenteditable` 相同的已接受代价。

### preflight 几何检查

S1 只对 click / setValue 检查 in-viewport 与 hit-test。S2 改为对所有 strict 动作检查：用户看不到、点不到的目标，调用方也不应能选择、提交或按键（不变量 150）。

### selectOption（原生单选 `<select>`）

单一 isolated-world task，不 focus（设置选中项不需要焦点，省掉 focus 回调这一页面代码执行点；isolated world 有自己的 DOM 包装对象，页面改写 `HTMLSelectElement.prototype` 影响不到这里）：

1. 解析元素；必须是已连接的 `HTMLSelectElement`、非 `multiple`，否则 `unsupported`；
2. 敏感 autocomplete → `sensitive`；`:disabled`、`aria-disabled`、`inert`、不可见 → `unsupported`；
3. 候选选项：未禁用（`option.matches(":disabled")`，覆盖禁用的 `optgroup`）、无 `hidden` 属性、计算样式 `display` 不为 `none`，且若带 `label` 属性则其值与 `option.text` 完全相等（Chrome 下拉列表显示 `label` 属性，与文本内容不一致的选项可能让审批页与实际含义脱节）；
4. 在候选中按 `option.label === label` 精确匹配：零个 → `option-not-found`，多个 → `option-ambiguous`，两者都在任何修改之前返回；
5. 匹配项已选中 → 直接返回 `written`、`valueMatched: true`，不派发事件（与用户重新选择同一项时浏览器不派发 `change` 一致）；
6. `select.selectedIndex = option.index`，再派发冒泡的 `input`（`composed: true`）与 `change`；
7. 返回 `valueMatched`：`selectedOptions` 恰为该选项（页面的 `change` 处理器可能改回，如实反映）。

`input` / `change` 事件的 `isTrusted` 为 false：原生 `<select>` 没有可信的编辑命令（spike 证实），这是已知限制，React 等框架照常接收。`option-not-found` / `option-ambiguous` 映射为 `TARGET_CAPABILITY_MISSING`，`details.reason` 区分两者，消息为固定文本、不含 label。

### submit

不提供 Enter 键：确认焦点与 CDP 按键之间页面可以移动焦点，把 Enter 送进另一个表单。显式的 `submit` 动作在单一 isolated-world task 内完成，不 focus：

1. 解析元素；必须是已连接、未禁用、不在 `inert` 中、可见、拥有 `form` 的 `HTMLButtonElement` / `HTMLInputElement` / `HTMLSelectElement` / `HTMLTextAreaElement`，否则 `unsupported`；
2. submitter：目标本身是提交按钮时用目标；否则用表单的默认按钮（`form.elements` 中第一个提交按钮），没有默认按钮则不带 submitter；默认按钮被禁用 → `unsupported`（用户按 Enter 时浏览器也不会提交）；
3. 有效性预检：除非 `form.noValidate` 或 submitter 带 `formNoValidate`，只要有 `willValidate && !validity.valid` 的元素就返回 `form-invalid`——纯读取，不派发 `invalid` 事件，此时页面代码尚未运行；
4. `form.requestSubmit(submitter)`：浏览器派发可信的 `submit` 事件（spike 证实，`submitter` 正确）并按表单行为导航或交给页面处理；
5. 返回 `submitted`。

`form-invalid` 映射为 `NO_EFFECT`（`details.reason: "form-invalid"`），发生在任何页面代码运行之前，可安全重试；`requestSubmit` 抛出或之后的任何失败都是 `ACTION_OUTCOME_UNKNOWN`。页面在 submit 处理器中 `preventDefault` 属于正常的 SPA 提交，仍是 `executed`。动作后的导航由 verification 观察。

### pressKey

按键只能用 CDP `Input.dispatchKeyEvent`（合成的 `KeyboardEvent` 不触发 Tab 移动焦点等默认动作），因此无法与焦点确认放进同一个 task。改为**由页面内的监听器证明按键落在目标上**：

1. isolated-world 调用 A（单 task）：解析元素；必须已连接、未禁用、不在 `inert` 中、可见、可聚焦（`tabIndex >= 0`、显式 `tabindex` 或 `isContentEditable`），否则 `unsupported`——此时尚未 focus，可安全拒绝；在元素所属窗口上以捕获方式注册 `keydown` 监听器，记录每个 `isTrusted` 且 `key` 相符的事件的 `composedPath()[0] === element`；`element.focus({ preventScroll: true })`；确认 `getRootNode().activeElement === element`；监听器以随机 token 存在 isolated world 的全局表中，并设 5 秒自清理定时器；
2. CDP `Input.dispatchKeyEvent`：`keyDown` 后 `keyUp`，带 `key` / `code` / `windowsVirtualKeyCode`（Escape 27、Tab 9、ArrowUp 38、ArrowDown 40），不带 `text`；
3. isolated-world 调用 B：按 token 取出记录并移除监听器；恰有一条相符记录且其目标是元素 → `executed`；否则（没有记录、目标不符、多条记录）→ `ACTION_OUTCOME_UNKNOWN`。

A 中 focus 之后的任何失败、CDP 派发失败、B 的任何失败都是 `ACTION_OUTCOME_UNKNOWN`。spike 证实：Tab 的默认动作照常把焦点移到下一个字段；页面在 A 与按键之间移走焦点时，监听器记录到的目标不是元素，判定为 unknown。页面若在更早注册的窗口捕获监听器中 `stopImmediatePropagation`，记录为空，同样 fail closed。

### 审批页

| 动作 | 标题 | 来自调用方的内容（单独成区，只经 `textContent`） |
|---|---|---|
| selectOption | 待批准的选择 | “将要选择的选项（来自调用方，非页面）”+ 值框（同 setValue 的完整显示与空格提示） |
| submit | 待批准的表单提交 | 固定说明：“将提交该元素所在的表单；目标是提交按钮时以它提交，否则使用表单的默认提交按钮” |
| pressKey | 待批准的按键 | “将要按下的键”：Esc / Tab / ↑ / ↓（固定映射，不显示调用方字符串） |

### 执行器与写入器

- `PolicyGatedStrictClickExecutor` 的 setValue 分支泛化为所有非 click 动作共用的一条路径：prepare → 以参数的 `kind` 与规范参数消费 grant → effect policy → 二次 prepare → OOPIF 拒绝 → 过期检查 → 交给 isolated-world 执行器；
- `chromeStrictValueWriter.ts` 改名为 `chromeStrictIsolatedActions.ts`，`IsolatedWorldStrictValueWriter` 改名为 `IsolatedWorldStrictActionRunner`：保留“唯一的本扩展 isolated world + bridge 元数据校验”的前置步骤，每种动作一个页面函数与一个结果映射；pressKey 在同一个 object group 内完成 A → 按键 → B；
- 结果：setValue / selectOption 带 `valueMatched`；submit 与 pressKey 只有 `executed`；都不回显参数；
- 所有动作的 effect 仍为 `unknown`，最低 assurance 与 click 相同。

### 新增不变量（S2）

147. selectOption 只作用于原生单选 `<select>`，只按 `option.label` 在未禁用、未隐藏、`label` 属性与文本一致的选项中精确匹配；不存在或不唯一时在任何修改之前拒绝；设置与事件派发在同一个 isolated-world task 内完成，不 focus。
148. 表单提交只能通过 `submit` 动作（`requestSubmit`）进行，submitter 是目标提交按钮或表单的默认按钮；有效性预检在任何页面代码运行之前完成；不提供 Enter 键。
149. pressKey 只接受 Escape / Tab / ArrowUp / ArrowDown；只有当 isolated world 中预先注册的捕获监听器记录到恰好一个可信且 key 相符、目标为该元素的 `keydown` 时才算执行成功，否则报告 `ACTION_OUTCOME_UNKNOWN`；focus 之后的任何失败都是 `ACTION_OUTCOME_UNKNOWN`。
150. Strict preflight 的可见、in-viewport 与 hit-test 检查适用于所有 strict 动作。

### 威胁模型（S2）

| # | 威胁 | 对策 |
|---|---|---|
| X1 | 批准选择 A 的 grant 被用来选 B、或用来按键 / 提交 | 参数绑定（138），kind 不同即 binding-mismatch |
| X2 | 选项文本与 Chrome 显示的 `label` 属性不同，审批与实际不符 | 只匹配 `label` 属性与文本一致的选项（147） |
| X3 | 同名选项（一个隐藏或禁用），选中用户看不到或不能选的那个 | 候选只含未禁用、未隐藏的选项；同名可选项多于一个即拒绝（147） |
| X4 | Enter 被页面重定向到另一个表单 | 不提供 Enter；submit 在单 task 内对目标的 form owner 调用 `requestSubmit`（148） |
| X5 | 提交时页面借 `invalid` 事件运行代码后再报告“未提交” | 纯读取的有效性预检，失败时页面代码尚未运行（148） |
| X6 | 页面在 focus 与按键之间移走焦点，按键落到别处 | 页面内监听器记录 keydown 的实际目标，不符即 outcome unknown，不重试（149） |
| X7 | 对看不到的元素按键或提交 | 几何检查扩展到所有动作（150） |
| X8 | 信用卡有效期等支付类下拉框被选择 | `<select>` 也按 autocomplete 标记 `sensitive`，签发前拒绝 |
| X9 | 版本错配：旧扩展把 S2 动作当成别的动作 | S1 扩展以未知 kind 拒绝；旧 click 消息带 `action` 拒绝（139） |

已接受的残余：select 的 `input` / `change` 不可信；按键与提交触发的页面处理器可以做任何事（effect 保持 `unknown`）；真实后台标签页中 CDP 按键可能不送达，此时 fail closed 为 outcome unknown，E2E 无法覆盖；执行时才能发现的拒绝（选项不存在、自定义组件、无表单）会浪费一次 grant。

### 测试计划（S2）

单元：

- 参数：三种新 kind 的合法形状；空 label、多余 key、未知 key 名、`key: "Enter"`、label 含被拒字符；规范化结果确定、kind 之间互不相等；
- 授权：selectOption 的 label 不同、kind 不同时 `binding-mismatch`；
- 感知：表单内的字段与提交按钮带 `submit` capability，表单外的不带，非提交按钮不带；敏感 autocomplete 的 `<select>` 带 `sensitive`；
- preflight：selectOption / submit / pressKey 的 out-of-viewport 与 occluded 被拒绝；
- 签发服务与审批入队：上表每一条拒绝；
- 协议：新 kind 通过 strict-action 消息；`browser.act` 的 label / key 组合校验；
- 执行器：每种 kind 以自己的 kind 与规范参数消费 grant、OOPIF 拒绝；
- 执行器（isolated world）：每个页面函数返回值到错误码的映射；pressKey 在 A 失败、派发失败、B 无记录 / 目标不符 / 多条时的映射，A 在派发前、B 在派发后的调用顺序，结果与错误不含参数；
- 审批页：三种标题、选项值框、提交说明、按键的固定映射。

Real Chromium E2E（fixture 扩展 `strict-write.html`，新增 `strict-actions` 区域）：

- selectOption：按 label 选中，页面收到 `change`、`valueMatched === true`；已选中项不派发事件；选项不存在 / 同名两项可选 / `label` 属性与文本不同 / 禁用 / `hidden` → 拒绝且值不变；`multiple` 下拉框 → `ACTION_NOT_SUPPORTED`；`autocomplete="cc-exp-month"` → 签发即拒；
- submit：从文本框提交无按钮的表单（页面 submit 处理器记录 `isTrusted` 且无 submitter）；从字段提交有默认按钮的表单（submitter 为默认按钮）；目标为第二个提交按钮时 submitter 是它；必填字段为空 → `NO_EFFECT` 且页面没有收到 `invalid` 事件；默认按钮被禁用 → 拒绝；表单外的输入框 → 签发即拒；
- pressKey：Tab 把焦点移到下一个字段；Escape 让页面的 keydown 处理器关闭一个弹层；ArrowDown 到达自定义 listbox；focus 回调把焦点移到别处 → `ACTION_OUTCOME_UNKNOWN`，另一个元素收到的 Escape 不会被报告为成功；不可聚焦的 div → 拒绝且从未获得焦点；
- 几何：被遮罩覆盖的 select / 提交按钮 → `TARGET_OCCLUDED`；
- 审批页：选择、提交、按键三种卡片的标题与内容，批准后执行成功。

### 回滚

S2 不改变 click 与 setValue 的行为；新增的 `submit` capability 只是观测里多一项。revert PR 即可，无数据迁移。

---

## S3：向模型开放

- `ModelActInput` 的 `kind` 接受 `setValue` / `selectOption` / `submit` / `pressKey`，参数按 `parseStrictActionArgs` 校验；`MODEL_INPUT_LIMITS` 中写入值的上限与 `STRICT_VALUE_MAX_LENGTH`（1024）一致，JSON Schema 同源；
- **写入类动作强制 operator 审批**：`agent-owned-auto` 只适用于 click。否则模型可以把在别处读到的数据（最多 1024 字符）写进 act origin 的字段而无人审查；
- Act broker 用 `authorization.request-strict-action-approval` 请求审批；审批页对模型发起的请求标注“将要填写的内容（来自模型，非页面）”；
- 单次执行账本仍为 `(tab, revision, ref)` 至多一次，**不把参数纳入键**：否则模型可以在同一 revision 上用不同值反复探测；
- `valueMatched` 是对模型不可见值的等值预言机，因此**只在 operator 配置 `includeValues=true` 时返回给模型**，否则丢弃；trusted client 需要新增对执行结果中 `valueMatched` 的解析（现有 `pickActResult` 会丢弃执行细节）；
- trace：`browser.act` 事件增加 `actionKind` 枚举字段，不记录参数；`validateTraceEvent` 同步；
- `docs/MODEL-FACING-ADAPTER.md` 与 SECURITY 的 broker 边界更新；
- wire 测试：setValue 全链路（operator 批准，审批请求带参数），`agent-owned-auto` 下写入仍走 operator，参数不同不能复用 grant，结果与 trace 中不含值，`includeValues=false` 时不返回 `valueMatched`。

---

## 关键决策

1. **用 `execCommand("insertText")` 而不是 CDP `Input.insertText`**：CDP 输入发往“当前有焦点的元素”，检查焦点与发送输入之间页面可以移动焦点；isolated world 中的 `execCommand` 让焦点确认、复核与插入处在同一个 task，且仍产生浏览器生成的可信 input 事件。拒绝的替代：直接设置 `element.value` 并派发合成事件——受控组件常常不认，且事件不可信。
2. **独立协议消息而不是给 click 消息加字段**：旧实现会静默忽略未知字段，版本错配时把写入执行成 click，且调用方以为写入成功。
3. **grant 绑定参数原文而不是摘要**：grant 只在扩展内存中，原文精确比较最简单。
4. **effect 保持 unknown**：字段的 onChange / 自动保存可以产生外部副作用，从页面结构无法证明不存在。
5. **凭据字段整体不做、敏感标记在感知阶段产生**：审批页必须显示值，与凭据值不应出现在界面上直接冲突；拒绝必须早于审批页显示。
6. **单行值、OOPIF fail closed、Enter 改为 submit 动作**：三处都是“无法在一个 task 内证明只作用于被识别目标”的场景，宁可不支持。

## 方案前验证（spike）

2026-10-30 在本仓库预装的 Playwright Chromium 上，用 CDP `Page.createIsolatedWorld` 建立 isolated world（与扩展 content script 的 isolated world 同一机制），执行写入逻辑：

| 场景 | 结果 |
|---|---|
| 带原值的 `<input>` 写入 `hello 世界` | `accepted: true`，值被完整替换，页面收到 `input`（`isTrusted: true`，`inputType: insertText`） |
| `<textarea>` 写入含换行的文本 | 成功，但按段落产生多次 `input`——这是 S1 不支持换行的依据 |
| 非空字段写入空值（`execCommand("delete")`） | 成功清空 |
| `maxlength=3` 写入 `abcdef` | `accepted: true`，值为 `abc`（`valueMatched` 应为 false） |
| `type=email` | `select()` 可用，写入成功 |
| focus 回调把焦点移到另一个输入框 | 返回 `focus-lost`，另一个输入框保持为空 |
| `beforeinput` | 不派发 |

该 spike 运行在 Playwright 接管的页面上（焦点模拟开启），S1 的 E2E 在真实扩展 isolated world 中复验，同样受焦点模拟影响（见上）。

## 最脆弱的假设

本方案假设“扩展 isolated world 中调用 `document.execCommand('insertText')` 会编辑当前聚焦的原生输入框，并产生 `isTrusted` 的 input 事件”。如果某个 Chromium 版本在 isolated world 中禁用或改变 `execCommand` 行为，setValue 会以 `accepted === false` 返回 `ACTION_OUTCOME_UNKNOWN`，不会退化成向别处输入；S1 的 E2E 第一条用例在真实扩展上验证这一点，失败则 S1 不合并，改用“CDP `Input.insertText` + 插入后校验目标值并在不符时报告 outcome unknown”的退路方案重新审查。

## S2 方案前验证（spike）

2026-10-30 在本仓库预装的 Playwright Chromium 上，用 CDP `Page.createIsolatedWorld` 建立 isolated world：

| 场景 | 结果 |
|---|---|
| isolated world 中 focus 输入框并注册窗口捕获 `keydown` 监听器，CDP 发 Tab（`keyDown` + `keyUp`，不带 text） | 监听器记录一条 `isTrusted`、目标为该元素的 keydown；默认动作把焦点移到下一个字段 |
| 同上，ArrowDown / Escape 发到 `tabindex=0` 的 div | 页面处理器收到可信 keydown |
| 布防并 focus 后、按键前页面把焦点移到另一个输入框 | 监听器记录的目标不是元素——可据此判定 outcome unknown |
| isolated world 中设置 `selectedIndex` 并派发 `input` / `change` | 值改变，页面收到的 `change` 为 `isTrusted: false` |
| 有空必填字段的表单上读 `validity.valid` | 识别为无效，页面没有收到 `invalid` 事件 |
| `form.requestSubmit(button)` | 页面收到 `isTrusted: true` 的 submit 事件，`submitter` 为该按钮 |

最脆弱的假设：pressKey 依赖“CDP 键盘事件送到当前聚焦的帧与元素，且 isolated world 的窗口捕获监听器先于页面目标阶段处理器观察到它”。spike 在主帧证实了这一点；同进程 child frame 与 shadow root 内的目标由 E2E 复验。若某一形态下不成立，监听器记录为空或目标不符，结果是 fail closed 的 outcome unknown，不会误报成功。
