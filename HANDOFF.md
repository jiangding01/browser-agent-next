# 交接：Strict 写入 S2（进行中）

最后更新：2026-10-30。本文件只服务于“换一个会话（云端或本地）无缝继续当前任务”；S2 合并后删除，长期信息以 `docs/` 为准。

## 1. 一句话现状

S2（trusted 路径的 `selectOption` / `submit` / `pressKey`）实现了一半，在分支 **`claude/magical-thompson-h5zzdu`** 上，**未开 PR、不可合并**。typecheck 与 796 个单测通过，E2E 未跑。下一步从「4. 剩余步骤」的第 1 步开始。

## 2. 用户约定（必须遵守）

- **汇报、输出、回复一律用简体中文。**
- 开发流程（每个功能批次）：think skill 写方案 → 方案独立审查一轮并修订 → 实现 → check skill 审查改动，有阻塞问题就修、修完再 check，直到没有阻塞问题 → 更新关联文档 → 提交 → 建 PR → 关注 CI → CI 绿后合并 → 更新本地代码 → 向用户汇报 → **等用户批准再开始下一个功能**。
- 用户已授权：S2 走完整流程，**合并后汇报**。S3 未授权，S2 合并后必须停下来等批准。
- 审查惯例：check skill 走 Deep 档，另起一个只拿代码和方案、不拿结论的独立对抗式审查员；对关键防线做变异验证（逐一移除，确认有测试变红，E2E 断言要有对照组防止空转）。
- PR 惯例：合并方式 `merge`（带 `expectedHeadSha`），合并后把本地 `main` 与工作分支快进到 `origin/main` 并推送分支。仓库没有 PR 模板。提交信息与 PR 正文不写模型名。

## 3. 环境与命令

- Node ≥ 20.19.0（CI 用 20.19.0），pnpm 10.34.5（`packageManager` 字段）。
- 首次：`pnpm install --frozen-lockfile`；本地 E2E 需要浏览器：`pnpm exec playwright install --with-deps --no-shell chromium`（Playwright 1.63.0，与 CI 相同）。
- 门禁（与 CI 一致）：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
```

- 单个 E2E：`pnpm e2e -g "Strict setValue"`（E2E 依赖 `pnpm build` 的扩展产物，改了扩展代码要先 build）。
- 单个单测文件：`pnpm vitest run <path>`。
- 单测没有 DOM 环境（无 jsdom / happy-dom，不要为此加依赖）：依赖真实 DOM 的逻辑用 fake 对象测，或放到 E2E。

## 4. 剩余步骤（按顺序）

### 4.1 isolated-world 执行器单测

文件：`apps/extension/src/background/execution/chromeStrictIsolatedActions.test.ts`（已有 setValue 的 `harness()`，用 fake transport 按 `functionDeclaration` 分派返回值，照它扩展）。补：

- `interpretSelectResult` / `interpretSubmitResult` / `interpretKeyArmResult` / `interpretKeyReadResult` 的每种返回值 → 错误码（`option-not-found` / `option-ambiguous` → `TARGET_CAPABILITY_MISSING` 带 `details.reason`；`form-invalid` → `NO_EFFECT`；`has-submit-button` / `not-own-form` / `custom-control` → `ACTION_NOT_SUPPORTED`；`not-observed`、`focus-lost`、`misrouted`、`expired`、未知形状 → `ACTION_OUTCOME_UNKNOWN`）；错误消息不含参数；
- pressKey 调用顺序：A（`STRICT_KEY_ARM_FUNCTION`）→ 两次 `Input.dispatchKeyEvent`（keyDown、keyUp，带 key / code / windowsVirtualKeyCode）→ B（`STRICT_KEY_READ_FUNCTION`）；A 拒绝时不派发按键；派发抛错 → `ACTION_OUTCOME_UNKNOWN`；
- 同一 tab 两次 `run` 串行（第二次的第一个 CDP 调用发生在第一次结束之后）；不同 tab 不互相阻塞；前一次失败不阻塞后一次；
- 页面函数源码断言：`STRICT_SUBMIT_FUNCTION` 经 `HTMLFormElement.prototype` 访问 `elements` / `noValidate` / `requestSubmit`、经 `EventTarget.prototype` 注册监听器；`STRICT_KEY_ARM_FUNCTION` 在 `element.focus(` 之前注册监听器；`STRICT_SELECT_OPTION_FUNCTION` 不含 `focus(`。

### 4.2 签发前的早期拒绝

文件：`apps/extension/src/background/execution/authorizationIssuanceService.ts` 的 `assertStrictActionTarget`（审批入队 `operatorApprovalStore.ts` 复用同一函数）。按方案「签发前的早期拒绝」表实现：

| 动作 | 拒绝 |
|---|---|
| selectOption | 缺 `selectOption` capability → `TARGET_CAPABILITY_MISSING`；`state.sensitive` → `POLICY_BLOCKED`；禁用或 `provenance.dom !== true` → `ACTION_NOT_SUPPORTED` |
| submit | 缺 `submit` capability → `TARGET_CAPABILITY_MISSING`；禁用或非 DOM 来源 → `ACTION_NOT_SUPPORTED` |
| pressKey | `sensitive` → `POLICY_BLOCKED`；禁用或非 DOM 来源；方向键作用于有 `selectOption` capability 或 role 为 `spinbutton` / `slider` / `radio` 的目标、Escape 作用于 role `searchbox` 的目标 → `ACTION_NOT_SUPPORTED` |

enterprise 路径只签 click（已实现，不用改）。补单测（`authorizationIssuanceService.test.ts`、`operatorApprovalStore.test.ts`）。

### 4.3 审批页

文件：`apps/extension/src/operator-approval/display.ts`、`index.ts`、`operator-approval.css`。

- `approvalTitle` 改为对 `action.kind` 穷举的 `switch`：click「待批准的点击」、setValue「待批准的填写」、selectOption「待批准的选择」、submit「待批准的表单提交」、pressKey「待批准的按键」；未知 kind → 卡片显示「无法识别的动作」且**不渲染批准按钮**；
- selectOption：区块标签「将要选择的选项（来自调用方，非页面）」+ 值框（复用 `writeValueDisplay`）；
- submit：固定说明「将提交该字段所在的表单（该表单没有提交按钮，相当于在字段中按 Enter）」；
- pressKey：「将要按下的键」+ 固定映射 Escape→Esc、Tab→Tab、ArrowUp→↑、ArrowDown→↓（不显示调用方字符串）；
- 只经 `textContent` 写入；补 `display.test.ts`。

### 4.4 E2E

fixture：`e2e/server.mjs` 的 `/strict-write.html`（S1 的字段都在，行距已压缩以保证都在视口内；新区域继续用 inline-block 小字号）。spec：`e2e/specs/trusted-execution.spec.ts` 末尾的 S1 用例（`Strict setValue：…`）有现成的 `observe()` / `issue()` / `write()` 帮手，照它为 S2 写一个新 test（`write` 帮手硬编码了 setValue，需要泛化成接收 action）。用例清单见 `docs/STRICT-WRITE-ACTIONS.md`「测试计划（S2）」的 E2E 部分，另外要覆盖：

- 观测结果中 `submit` capability 的有无（无按钮表单的字段有；有提交按钮 / `type=image` / 经 `form` 属性关联的字段 / 表单外字段 / 提交按钮本身没有）——单测环境测不了，只能在这里断言；
- 每个“拒绝”用例都断言页面状态未变（值、`focusin` 记录、页面自己的事件日志），并给断言配对照组。

### 4.5 审查循环

`pnpm typecheck && pnpm test && pnpm build && pnpm e2e` 全绿后：check skill（Deep）+ 独立对抗式审查员；修复后重跑全部门禁，再对修复部分审一轮，直到没有 HIGH / MEDIUM；做变异验证并把结果写进 PROGRESS。

### 4.6 文档

- `docs/INVARIANTS.md` 追加 147～151（原文在 `docs/STRICT-WRITE-ACTIONS.md`「新增不变量（S2）」，直接复制）；
- `docs/SECURITY.md`「Strict 写入边界（setValue，S1）」扩写为覆盖 S2（标题改为不限于 setValue）；
- `docs/PROGRESS.md`（新增「Strict 写入 S2」一节与门禁，状态表，下一步改为 S3）、`docs/ROADMAP.md`（勾掉 S2）、`README.md`、`docs/HIGH-LEVEL-API.md`（browser.act 支持的动作与 `label` / `key` 字段）；
- `docs/STRICT-WRITE-ACTIONS.md`：顶部状态改为 S2 已实现，加「S2 实现记录」（审查发现与处理），删除末尾「S2 实现进度（交接，WIP）」一节；
- **删除本文件 `HANDOFF.md`**。

### 4.7 交付

提交、推送、建 PR（base `main`，head `claude/magical-thompson-h5zzdu`，正文结构参照 PR #19：改动 / 验证 / 审查 / 回滚）、等 CI（`test` 与 `browser-e2e` 两个 job）全绿、合并、同步本地、用简体中文向用户汇报，然后停下等 S3 的批准。

## 5. 已完成的部分（S2，未经审查）

| 位置 | 内容 |
|---|---|
| `packages/core/src/actions/strictArgs.ts` | `StrictActionArgs` 增加三种动作、`STRICT_KEYS` / `isStrictKey`、`strictArgsFromActAction`（`browser.act` 参数拼装的唯一实现），及单测 |
| `packages/core/src/api/types.ts` | `BrowserActInput.action` 增加 `label?` / `key?` |
| `apps/extension/src/protocol/trustedHost.ts` | `isBrowserActAction` 改用 `strictArgsFromActAction`，单测已更新 |
| `apps/extension/src/background/api/browserApiService.ts` | `act` 改用 `strictArgsFromActAction`；未支持的 kind 仍报 `ACTION_NOT_SUPPORTED` |
| `apps/extension/src/content/domFrameSource.ts` | `submit` capability（`submitsOwnFormWithoutButton`，表单属性经原型访问）、敏感 `<select>`；敏感 select 有单测 |
| `packages/runtime/src/execution/strictPreflight.ts` | 几何检查适用于所有 strict 动作（不变量 150），及单测 |
| `apps/extension/src/background/execution/chromeStrictClickResolver.ts` | 白名单扩展到五种动作，及单测 |
| `apps/extension/src/background/execution/chromeStrictIsolatedActions.ts` | 由 S1 的 `chromeStrictValueWriter.ts` 改名重写：`IsolatedWorldStrictActionRunner`，五个页面函数、结果映射、按 tab 串行。S1 setValue 单测已迁移；**S2 部分无单测、未在浏览器中运行** |
| `apps/extension/src/background/execution/policyGatedStrictClick.ts` | 所有非 click 动作走 `executeIsolatedAction`；有单测证明 S2 动作不走 click dispatch |
| `apps/extension/src/background/index.ts` | 接线改为 `IsolatedWorldStrictActionRunner` |

## 6. 设计要点与已踩过的坑

完整设计在 `docs/STRICT-WRITE-ACTIONS.md` 的「S2」与「S2 方案前验证（spike）」。实现时最容易出错的几点：

- **动作名与 `BrowserActionKind` 一致**：`selectOption` / `submit` / `pressKey`，grant 的 `actionKind` 直接取 `args.kind`；
- **submit 范围很窄**：只用于字段自身所在（`form === closest("form")`）、没有任何提交按钮的表单，不带 submitter 调用 `requestSubmit()`；有提交按钮时让调用方用 Strict click；
- **`HTMLFormElement` 的属性会被同名控件覆盖**（isolated world 中也是，spike 已证实），表单的 `elements` / `noValidate` / `requestSubmit` 与监听器注册一律经原型；`form.elements` 不含 `input type=image`，要单独查；
- **隐藏 optgroup 里的 option 自身 `display` 仍是 `block`**，隐藏检查必须向上查到 `<select>`；
- **pressKey 的成功判定**：A 中在 focus 之前于元素所在窗口注册捕获 keydown 监听器；B 中恰有一条可信、key 相符、`composedPath()[0] === element` 的记录才算成功，否则 `ACTION_OUTCOME_UNKNOWN`；
- **Playwright 会模拟页面焦点**，E2E 证明不了真实后台标签页下的行为，文档里要写明；
- **Strict 命中测试在目标自身的 tree scope 上做**（S1 修过 shadow root 的问题，不变量 146），不要改回 `document.elementFromPoint`；
- `ACTION_OUTCOME_UNKNOWN` 是唯一禁止自动重试、会让 broker 降级 tab 的错误码：页面代码可能已经运行之后的任何失败都用它，之前的拒绝不要用它。

## 7. 历史

- PR #17：Phase 7-0a 决策评测 harness（已合并）
- PR #18：Phase 7-0b model-facing 脱敏 trace（已合并）
- PR #19：Strict 写入 S1，trusted 路径 setValue（已合并，merge commit `4a335a1`）
- S2：本分支进行中；S3（向模型开放写入，强制 operator 审批）待用户批准
