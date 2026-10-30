# Strict 写入类动作：setValue / selectOption / pressKey

状态：方案草稿，待审查
最后更新：2026-10-30

## 为什么做

现在执行面只有 Strict Click。感知层已经给文本框标了 `setValue`、给下拉框标了 `selectOption`（`apps/extension/src/content/domFrameSource.ts` 的 `capabilitiesFor`），`BrowserActionKind` 里也有这些类型，但授权、执行、协议、broker 都只认 click。旧项目（`browser-agent`）的核心价值是表单填写，不补这块，Phase 7 的 `HANDOFF_FORM` 交接出去也没有能执行的路径。

## 目标与不做

做：

- 可信控制面上的 Strict `setValue`（原生文本类 `<input>` 与 `<textarea>`）、`selectOption`（原生 `<select>`，单选）、`pressKey`（固定的少量按键）；
- 授权 grant 绑定动作参数；operator 审批页显示将要执行的具体动作与参数；
- 最后一步把这三种动作经 Act broker 开放给模型（默认不开放，与 click 相同的 operator 显式配置）。

不做（每项都有原因）：

- **自定义组件**（antd / arco 的 Select、DatePicker、Cascader、富文本、contenteditable）：它们的“值”不在原生控件上，需要组件适配器或 recipe，属于 Phase 8 能力层；模型仍可用 click 序列操作它们；
- **凭据与支付字段**：`type=password` 与凭据 / 支付类 `autocomplete` 字段一律拒绝。审批页必须显示要填的值，而这类值不应出现在任何界面上；需要时另立设计；
- **跨进程 iframe（OOPIF）中的写入**：输入焦点跨进程路由没有被证明前一律 fail closed（click 的 OOPIF 支持是另一条已验证的路径）；同进程 child frame 支持；
- **enterprise-policy 签发写入动作**：企业 assertion 的签名结构绑定的是 click，扩展它需要改动受管签名格式，不在本次范围；
- **effect 分类器**：写入类动作仍按 `unknown` effect 处理（见“关键决策”）。

## 拆分

三个 PR，按顺序交付，每个合并后系统都完整可用：

| PR | 内容 | 对模型可见 |
|---|---|---|
| S1 | 动作参数模型、grant 参数绑定、可信路径 Strict `setValue`、审批页显示、真实 Chromium E2E | 否 |
| S2 | Strict `selectOption`（原生单选 `<select>`）与 `pressKey` | 否 |
| S3 | Act broker 与 MCP `browser.act` 开放 setValue / selectOption / pressKey；trace 映射；wire 测试 | 是（默认不暴露） |

---

## S1：参数绑定与 Strict setValue

### 动作参数

`packages/core` 新增：

```ts
export type StrictActionArgs =
  | { kind: "click" }
  | { kind: "setValue"; value: string };   // S2 增加 selectOption / pressKey

export const STRICT_VALUE_MAX_LENGTH = 4_096;

/** 规范化为确定的字符串：exact-key、固定字段顺序。grant 用它做精确匹配。 */
export function canonicalStrictActionArgs(args: StrictActionArgs): string;

/** 入口校验：结构、长度与字符集（见下）；失败抛 BrowserRuntimeError("POLICY_BLOCKED")。 */
export function parseStrictActionArgs(value: unknown): StrictActionArgs;
```

**值的字符集**：拒绝 Unicode 类别 `Cc`（控制字符，`\n` 除外——它只允许用于 textarea，见执行检查）、`Cf`（格式字符：零宽字符、bidi 覆盖与隔离等）、变体选择符（U+FE00–U+FE0F、U+E0100–U+E01EF）与孤立代理项。这样审批页显示的就是将要输入的全部内容，不存在“显示一套、实际输入另一套”。代价：含变体选择符的 emoji 无法通过 setValue 输入，接受。

### grant 绑定参数

`packages/policy` 的 `InMemoryAuthorizationStore`：

- `AuthorizationGrant`、`IssueAuthorizationInput`、`ConsumeAuthorizationInput` 增加 `actionArgs: string`（`canonicalStrictActionArgs` 的结果）；
- `consume` 要求 `actionKind` 与 `actionArgs` 都与 grant 精确相等，否则 `binding-mismatch`；
- 现有 click 签发路径统一传 `canonicalStrictActionArgs({ kind: "click" })`。

grant 只存在扩展内存中，存规范化后的原文即可，不做摘要：比较简单、确定，且没有新的密钥或哈希依赖。

### 签发与审批

`StrictClickAuthorizationIssuanceService` 改名为 `StrictActionAuthorizationIssuanceService`（文件同名迁移），签发输入增加可选 `action?: StrictActionArgs`（缺省为 click）：

- control-plane 与 operator-approved 两条路径都接受 setValue；
- enterprise-policy 路径仍只签发 click（传入非 click 时 `AUTHORIZATION_REQUIRED`）；
- 签发前检查 retained observation 中的目标带有与动作对应的 capability（setValue ↔ `setValue`），否则 `TARGET_CAPABILITY_MISSING`——提前拒绝明显无效的授权请求；
- effect 固定 `unknown`，最低 assurance 规则与 click 相同。

`OperatorApprovalStore` 的 pending 记录与 `OperatorApprovalSummary` 增加 `action: StrictActionArgs`；批准时用同一个 `action` 签发。审批页（`apps/extension/src/operator-approval/`）：

- 卡片顶部显示动作类型：“点击” / “填写”；
- setValue 显示“将要填写的内容（来自调用方，非页面）”，用与不可信页面文本不同的样式区分来源，**完整显示**（可滚动区域，不截断——截断会让超出部分逃过人工审查），仅经 `textContent` 写入；
- 空字符串显示为“（清空该字段）”。

### 协议

所有请求都增加可选 `action`（缺省为 click），旧请求逐字节兼容：

| 层 | 变化 |
|---|---|
| `apps/extension/src/protocol/trustedHost.ts` | `authorization.issue-strict-click`、`authorization.request-operator-approval`、`execution.execute-strict-click` 增加 `action?`；`browser.act` 的 `action.kind` 接受 `setValue` 并要求 `action.value`。消息名保留历史上的 `strict-click`，文档注明它们现在签发 / 执行任意 strict 动作 |
| `packages/core` `BrowserActInput.action` | 增加 `value?: string`（仅 setValue） |
| native host | 只透传 `type` 已知的消息，不解析载荷——无改动 |
| `apps/mcp-server/src/trustedRuntimeClient.ts` | S1 不改（模型侧在 S3） |

校验沿用 exact-key：`action` 只能是 `{ kind: "click" }` 或 `{ kind: "setValue", value }`，`value` 过 `parseStrictActionArgs`。

### 执行：`PolicyGatedStrictActionExecutor`

`PolicyGatedStrictClickExecutor` 泛化为按动作分派的执行器（click 路径逐行不变）。setValue 的流程：

1. **第一次 Strict prepare**（与 click 相同）：retained observation → 强身份 → live DOM + AX 复核 → `evaluateStrictPreflight`。preflight 对 setValue 增加与 click 相同的几何要求（在视口内、hit-test 命中目标）：用户无法点到的字段，模型也不应能写；
2. **授权**：用 `actionKind: "setValue"` 与 `actionArgs` 消费 grant，effect `unknown`，`evaluateEffectPolicy` 同 click；
3. **第二次 Strict prepare**，并且：
   - 目标位于 OOPIF child session（`prepared.cdpSessionId !== undefined`）→ `ACTION_NOT_SUPPORTED`，在任何输入之前；
   - grant 到期复核（同 click）；
4. **单一 isolated-world task 完成写入**：通过已有的 DOM identity bridge（`globalThis[DOM_IDENTITY_BRIDGE_KEY]`，固定函数、不接受模型 JS）调用一个固定的 `functionDeclaration`，在同一个 JS task 内依次：
   1. `this.resolve(stableId)` 得到元素，确认仍连接在文档中；
   2. **控件检查**（任一不满足即返回 `unsupported`，此时尚未触碰页面）：
      - 元素是 `HTMLTextAreaElement`，或 `type` ∈ {`text`, `search`, `email`, `url`, `tel`} 的 `HTMLInputElement`（缺省 type 视为 text）；
      - 非 `readOnly`、非 `:disabled`；
      - `type=password` 或 `autocomplete` 含凭据 / 支付 token（`current-password`、`new-password`、`one-time-code`、`cc-*`）→ 返回 `credential`；
      - 值含 `\n` 而元素不是 textarea → 返回 `unsupported`；
   3. `element.focus({ preventScroll: true })`；
   4. 确认 `element.getRootNode().activeElement === element`（覆盖 shadow root），否则返回 `focus-lost`（页面在 focus 回调里把焦点移走等情况）；
   5. `element.select()`；
   6. `document.execCommand("insertText", false, value)`，`value === ""` 时用 `document.execCommand("delete")`；
   7. 返回 `{ status: "inserted", accepted: <execCommand 返回值>, valueMatched: element.value === value }`。

   在同一个 task 内完成焦点确认与插入，页面脚本没有机会在两者之间把焦点移到别的元素：**文字要么进入被识别的那个元素，要么不进入任何元素**。`execCommand("insertText")` 产生浏览器生成的 `input` 事件（`isTrusted === true`，`inputType === "insertText"`），受控组件（React 等）能正常收到；Chrome 的 `execCommand` 不派发 `beforeinput`，依赖 `beforeinput` 的编辑器不在支持范围内（它们本来就是自定义组件）；
5. **结果映射**：
   - `unsupported` → `ACTION_NOT_SUPPORTED`，`credential` → `POLICY_BLOCKED`；这两种都发生在 focus 之前，`outcomeMayHaveChanged = false`；
   - `focus-lost` → `TARGET_OCCLUDED`；`focus()` 已经执行过（页面 focus / blur 回调可能已运行），因此这一种 `outcomeMayHaveChanged = true`，按 `ACTION_OUTCOME_UNKNOWN` 的语义不自动重试；
   - CDP 调用失败或 isolated world / bridge 不可用：发生在 `callFunctionOn` 发出之前 → `TARGET_IDENTITY_MISMATCH`；发出之后（无法知道函数是否运行）→ `ACTION_OUTCOME_UNKNOWN`；
   - `inserted` 且 `accepted === false` → `ACTION_OUTCOME_UNKNOWN`（浏览器拒绝了编辑命令，但 focus 已发生）；
   - `inserted` 且 `accepted === true` → 执行成功，结果带 `valueMatched`（页面的 maxlength、格式化、掩码会让它为 false；这是执行证据，不是错误）。
6. 不 blur、不按 Tab：离开字段的行为（可能触发校验或自动保存）由调用方用后续动作显式决定。

执行结果只带 `valueMatched` 布尔值，**从不回显值本身**。

### 背景标签页的焦点

E2E 与真实使用中的 agent 标签页通常在后台，`element.focus()` 在后台页面里仍会改变 `activeElement`，`execCommand` 作用于 `activeElement`，不依赖窗口焦点；因此不需要 `Emulation.setFocusEmulationEnabled`。E2E 在后台标签页上覆盖这一点。

### 新增不变量（S1）

138. Strict 动作的 grant 必须精确绑定规范化的动作参数（`actionKind` + `actionArgs`）；消费时参数不完全相同即 `binding-mismatch`，为一个值签发的 grant 不能用于输入另一个值。
139. setValue 的焦点确认、选区与插入必须在同一个 isolated-world task 内完成，只作用于由强身份解析出的元素；绝不向“当前恰好有焦点的元素”发送输入。
140. setValue 在任何焦点或输入之前拒绝凭据与支付字段（`type=password`、凭据 / 支付类 `autocomplete`）。
141. 动作参数在所有入口拒绝控制字符（textarea 的 `\n` 除外）、格式字符、变体选择符与孤立代理项；operator 审批页必须完整显示将要输入的值，并与页面派生文本分开标注来源。
142. 写入类动作的 effect 保持 `unknown`，最低 assurance 与 click 相同；在 effect 分类器能证明更窄的 effect 之前不得降级。
143. 写入类动作的执行结果与错误不得回显输入值；只允许返回 `valueMatched` 这样的布尔执行证据。
144. 目标位于 OOPIF child session 的写入类动作在任何输入之前 fail closed（`ACTION_NOT_SUPPORTED`）。

### 威胁模型（S1）

| # | 威胁 | 对策 |
|---|---|---|
| W1 | 批准“填 A”的 grant 被用来填 B | grant 绑定 `actionArgs`，精确匹配（138） |
| W2 | 页面在检查焦点后、插入前把焦点移到别的字段（例如把文字引到隐藏的凭据框或别的表单） | 焦点确认与插入在同一 task（139）；只用 `execCommand`，不用 CDP `Input.insertText` |
| W3 | 审批页显示的内容与实际输入不同（零宽字符、bidi 覆盖、截断） | 入口拒绝不可见字符；审批页完整显示（141） |
| W4 | 把调用方的值写进密码框，或让审批页显示密码 | 凭据 / 支付字段在任何输入前拒绝（140） |
| W5 | 动作被重放或迟到执行 | 沿用 grant 单次消费、TTL、navigation / tab 关闭撤销、二次 prepare |
| W6 | 写入触发自动保存等外部副作用 | effect 保持 `unknown`，需要与 click 相同的授权（142）；执行后不自动 blur / Tab |
| W7 | 执行结果或错误把值带回调用方 / 日志 | 结果只有 `valueMatched`（143）；错误消息为固定文本 |
| W8 | OOPIF 中输入路由未经证明 | fail closed（144） |
| W9 | 页面替换了同外观的输入框 | 沿用强身份与两次 prepare；身份不符在任何输入之前拒绝 |

已接受的残余：`element.focus()` 会触发页面的 focus / blur 回调（之前有焦点的字段的 blur 处理可能做任何事）——这正是 `focus-lost` 与执行失败被归为 outcome unknown 的原因；页面可以在 `input` 事件里把值改写，`valueMatched` 会如实反映。

### 测试计划（S1）

单元：

- `parseStrictActionArgs` / `canonicalStrictActionArgs`：合法 click / setValue；拒绝未知 kind、多余 key、超长值、各类不可见字符；规范化结果确定；
- `InMemoryAuthorizationStore`：参数不同、kind 不同时 `binding-mismatch`；click grant 不能用于 setValue，反之亦然；
- 签发服务：setValue 需要目标带 `setValue` capability；enterprise 路径拒绝非 click；
- `OperatorApprovalStore`：summary 带 action；批准用同一 action 签发；
- 协议校验：`action` 的各种非法形状被拒绝；旧请求（无 action）仍是 click；
- 执行器：setValue 的授权消费参数、两次 prepare、OOPIF 拒绝、各种 isolated-world 返回值到错误码的映射（含 `outcomeMayHaveChanged`）、CDP 失败在发出前 / 后的区分、结果不含值；click 路径的既有测试全部不变；
- 审批页：动作类型与值的显示、只经 `textContent`、空值文案。

Real Chromium E2E（`e2e/specs/`，新 fixture `strict-write.html`，后台标签页）：

- 文本框与 textarea 填写成功：页面监听到的 `input` 事件 `isTrusted === true`、`inputType === "insertText"`，`valueMatched === true`，fresh observe 的值一致；
- 覆盖已有内容；空值清空字段；
- 页面在 focus 回调里把焦点移到另一个输入框：另一个输入框保持为空，返回 `ACTION_OUTCOME_UNKNOWN`；
- password 字段：`POLICY_BLOCKED`，字段未获得焦点；
- readonly / disabled / number 字段：`ACTION_NOT_SUPPORTED` 或 `TARGET_DISABLED`，无输入；
- 被遮罩覆盖的字段：`TARGET_OCCLUDED`，无输入；
- grant 参数不一致：用“A”的 grant 执行“B” → `AUTHORIZATION_REQUIRED`，字段不变；
- 带 maxlength 的字段：执行成功，`valueMatched === false`；
- operator 审批页：显示动作类型与完整值，页内批准后执行成功。

### 验证命令

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
```

### 回滚

S1 不改变任何现有 click 请求的行为（缺省 action 为 click）；revert PR 即可，无数据迁移。

---

## S2：selectOption 与 pressKey

### selectOption（原生单选 `<select>`）

- 参数 `{ kind: "selectOption"; label: string }`：按选项**可见文本**选择（NFKC + 空白折叠后精确相等），与审批页显示一致；值（`option.value`）对人不可读，不作为选择依据；
- 单一 isolated-world task 内：解析元素 → 必须是非 `multiple`、非 disabled 的 `HTMLSelectElement` → 在非 disabled 的 `<option>` 中找可见文本相等者，零个 → `ACTION_NOT_SUPPORTED`（选项不存在），多个 → `ACTION_NOT_SUPPORTED`（选项不唯一），都发生在任何修改之前 → `focus({ preventScroll: true })` → 设置 `selectedIndex` → 依次派发冒泡的 `input` 与 `change` 事件（与 Playwright `selectOption` 相同的做法；事件 `isTrusted === false`，这是原生 select 没有可信编辑命令时的已知限制）→ 返回 `valueMatched`（选中项文本是否等于目标）；
- 若已经选中该项，仍派发事件（与用户重新选择同一项一致）；
- 多选 `<select multiple>`、`role=combobox` / `listbox` 的自定义组件：`ACTION_NOT_SUPPORTED`。

### pressKey

- 参数 `{ kind: "pressKey"; key: "Enter" | "Escape" | "Tab" | "ArrowUp" | "ArrowDown" }`，固定白名单，不支持组合键与任意字符；
- 先在 isolated world 中把焦点移到目标并确认（同 setValue 第 3–4 步），然后用 CDP `Input.dispatchKeyEvent`（`rawKeyDown` + `char`（仅 Enter）+ `keyUp`）派发真实按键：Enter 需要浏览器生成的可信事件才能触发隐式表单提交等默认行为，isolated world 无法合成；
- **残余竞态**：确认焦点与 CDP 按键之间不在同一个 task，页面理论上可以在两者之间移动焦点。对策：派发前不让出控制（focus 确认后立即发 CDP，期间不做其它往返）；派发后再读一次 `activeElement`，若已不是目标则结果标记 `focusMoved: true`（按键已发生，不能撤回）。这一残余写入 SECURITY 的已接受风险；
- effect 同为 `unknown`（Enter 可能提交表单）。

### 新增不变量（S2）

145. selectOption 只按选项可见文本精确选择；选项不存在或不唯一时在任何修改之前拒绝；只支持原生单选 `<select>`。
146. pressKey 只接受固定白名单中的单个按键；按键前必须把焦点移到强身份解析出的目标并确认，按键后再次确认，焦点被移走时如实报告。

---

## S3：向模型开放

- `ModelActInput` 的 `kind` 接受 `setValue` / `selectOption` / `pressKey`，参数按 `parseStrictActionArgs` 校验，JSON Schema 与 `MODEL_INPUT_LIMITS` 同源；
- Act broker 生成 grant 时传入同一 `action`；operator 审批页显示动作与参数；
- 单次执行账本的键从 `(tab, revision, ref)` 改为 `(tab, revision, ref, canonicalActionArgs)`：同一字段在同一 revision 上可以先 setValue 再 pressKey，但同一参数的同一动作至多一次；预算仍按调用计；
- 模型可见结果：`status`、`effectClass`、`valueMatched`（仅写入类）与本地验证；不回显值；
- trace：`browser.act` 事件增加 `metrics` 之外的 `actionKind`（枚举），不记录参数；`validateTraceEvent` 同步收紧；
- `docs/MODEL-FACING-ADAPTER.md` 与 SECURITY 的 broker 边界更新；
- wire 测试：setValue 全链路（operator 批准，审批请求带参数），参数不同不能复用 grant，结果与 trace 中不含值。

---

## 关键决策

1. **用 `execCommand("insertText")` 而不是 CDP `Input.insertText`**：CDP 输入发往“当前有焦点的元素”，检查焦点与发送输入之间页面可以移动焦点；isolated world 中的 `execCommand` 让焦点确认与插入处在同一个 task，且仍产生浏览器生成的可信 input 事件。拒绝的替代：直接设置 `element.value` 并派发合成事件——受控组件常常不认（React 依赖原生 setter 与可信输入），且事件不可信。
2. **grant 绑定参数原文而不是摘要**：grant 只在扩展内存中，原文精确比较最简单；摘要不能减少任何暴露面。
3. **effect 保持 unknown**：字段的 onChange / 自动保存可以产生外部副作用，从页面结构无法证明不存在；与 click 同级授权是保守且一致的选择。
4. **凭据字段整体不做**：审批页必须显示值，与凭据值不应出现在界面上直接冲突；与其做半套掩码方案，不如明确不支持。
5. **OOPIF 写入 fail closed**：click 的 OOPIF 支持依赖坐标投影与 presentation fence 的大量验证；isolated-world 写入在 OOPIF 中涉及跨进程焦点，没有同等级证据前不开放。

## 方案前验证（spike）

2026-10-30 在本仓库预装的 Playwright Chromium 上，用 CDP `Page.createIsolatedWorld` 建立 isolated world（与扩展 content script 的 isolated world 同一机制），页面放在后台标签页，执行上面第 4 步的同一段逻辑：

| 场景 | 结果 |
|---|---|
| 带原值的 `<input>` 写入 `hello 世界` | `accepted: true`，值被完整替换，页面收到 `input`（`isTrusted: true`，`inputType: insertText`） |
| `<textarea>` 写入 `line1\nline2` | 成功，按段落产生多次可信 `input` |
| 非空字段写入空值（`execCommand("delete")`） | 成功清空 |
| `maxlength=3` 写入 `abcdef` | `accepted: true`，值为 `abc`（`valueMatched` 应为 false） |
| `type=email` | `select()` 可用，写入成功 |
| focus 回调把焦点移到另一个输入框 | 返回 `focus-lost`，另一个输入框保持为空 |
| `beforeinput` | 不派发（见上） |

S1 的 E2E 会在真实扩展 isolated world 中复验这些行为。

## 最脆弱的假设

本方案假设“扩展 isolated world 中调用 `document.execCommand('insertText')` 会编辑当前聚焦的原生输入框，并产生 `isTrusted` 的 input 事件”。如果某个 Chromium 版本在 isolated world 中禁用或改变 `execCommand` 行为，setValue 会以 `accepted === false` 返回 `ACTION_OUTCOME_UNKNOWN`，不会退化成向别处输入；S1 的 E2E 第一条用例在真实 Chromium 上验证这一点，失败则 S1 不合并，改用“CDP `Input.insertText` + 插入后校验目标值并在不符时报告 outcome unknown”的退路方案重新审查。
