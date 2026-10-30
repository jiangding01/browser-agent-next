# 安全模型与信任边界

最后更新：2026-10-16

## 目标

Browser Agent Next 的安全目标不是“模型永远不会犯错”，而是把模型、页面内容和真实浏览器副作用分层隔开：

Page / Model Decision → Stored Observation → Strong Identity → Policy → Trusted Authorization → Second Strict Prepare → Browser Input → Independent Verify

页面文本、Prompt、AX name、DOM label、模型 confidence 都不能直接获得执行权限。

## 当前可以防御的威胁

- 页面 Prompt Injection 诱导模型点击错误对象；
- stale ref / same-looking replacement；
- DOM/AX semantic similarity 被误当 identity；
- observation 后导航或 frame lifecycle 变化；
- target 被遮挡、禁用、离开 viewport；
- unknown-effect click 在没有 trusted grant 时直接执行；
- grant 被挪用到其它 tab/revision/ref/action/effect；
- grant 跨 navigation 存活；
- dispatch 后 outcome ambiguous 时自动 retry；
- verify inconclusive 时重放 non-idempotent action；
- DNS rebinding 风格 Host header；
- token symlink / 非当前用户 ownership；
- Native Messaging 半帧后继续发送导致协议失步。

## Trusted Native Host 的真实语义

当前 Native Host + localhost Bearer token 提供的是“控制平面身份验证（control-plane authentication）”。

它可以证明请求来自一个能够读取 trusted token 的本地进程，但不能在所有部署场景中自动等价为人工批准或 OS 级硬隔离。

特别是，如果 Claude Code / Coding Agent 拥有与用户相同的任意文件读取 + localhost 网络权限，那么该 Agent 理论上也可能读取 ~/.browser-agent-next/trusted-rpc.token 并直接调用 trusted RPC。

因此，同 UID、拥有任意本地代码/文件能力的 Agent，不属于当前 token 能单独隔离的对象。

当前 token 可以隔离普通网页、页面 JS、Extension 普通 runtime message，以及不具备本地 token 访问权的模型/Agent；但不能单靠一个 0600 文件隔离已经拥有同用户任意 shell/filesystem 权限的 Coding Agent。

## 部署要求

受限 Browser Agent 场景中，如果模型只能通过受限 MCP / Browser Runtime 使用浏览器，不能任意读取本地 token，则 trusted-host grant 可以作为有效的控制平面授权。

如果 Agent 拥有同 UID shell/filesystem，推荐把授权控制平面放到 Agent 无法访问的边界外，例如独立 OS 用户、独立桌面审批进程、企业权限服务、人工确认 UI 或宿主提供的 capability-based authorization。

在这些模式完成前，不应声称当前 token 是“对任意本地 Coding Agent 的 hard authorization”。

## Auto-act Origin Policy

Auto-act allowlist 默认空，只支持 http/https，配置项必须是纯 origin，不允许 wildcard、suffix、path、query、fragment 或 credentials。

这样可以避免调用方误以为自己只授权了一个 path，实际上 Runtime 却扩大到了整个 origin。

### 配置文件来源

Native host 在每次启动（即扩展连接）时读取 `~/.browser-agent-next/autoact-origins.json`，并在 trusted RPC 开始监听之前通过 `policy.replace-autoact-origins` 整体下发给扩展。格式固定为 `{"version":1,"origins":[...]}`，最多 100 项，每项必须是纯 origin。

- 文件必须是当前用户拥有、非 symlink、不可被组或其他用户写入的普通文件，大小不超过 64 KiB；所在目录要求与 trusted token 目录相同。origins 不是机密，因此不强制 `0600`。
- 任一条目非法、或文件校验失败时，整份文件作废，不做部分应用。
- 文件缺失、非法或下发失败时，native host 只在 stderr 记录原因并继续启动，不下发任何内容，扩展 allowlist 保持为空，act 全部被拒绝（fail closed）。日志不得包含 origin 列表，且绝不能写入 stdout（Native Messaging 协议通道）。
- allowlist 只存在于扩展内存。运行期间通过 RPC replace 的结果会在下一次 native host 重连时被配置文件内容覆盖；没有配置文件时则重置为空。

## Model act broker 边界

Phase 6.6a 起，operator 可以显式把 side-effect tier 的 `browser.act` 暴露给模型。模型只能提出“点击某个已出境 ref”，授权 id、action id 与授权路径都由 MCP 进程内的 Act broker 生成（见 `docs/MODEL-FACING-ADAPTER.md`）。

### broker scope 与威胁模型

broker 的 scope 是 MCP 进程内的代码约束：它限制的是只能通过受限 MCP 使用浏览器的模型，与不变量 46 描述的威胁模型一致。拥有同 UID 任意 filesystem/network 能力的 Coding Agent 仍可以绕过 MCP 进程直接读取 trusted token，这不属于 broker 能隔离的对象。扩展侧对授权签发（assurance ceiling、`ownedBySession`、retained observation / ref / origin 重验证）与执行（grant 精确绑定、第二次 Strict Prepare）的校验是第二道防线，不依赖 broker 的实现正确性。

### 默认配置

- `browser.act` 默认不在 `MODEL_TOOLS` 里；
- act origin 默认为空，且必须是 read origin 的子集；tab origin 与目标 element 所在 frame 的有效 origin（`about:blank` / `about:srcdoc` 继承父 frame）都必须在 act allowlist 内；
- 授权路径默认是 operator approval；`agent-owned-auto` 仅对 `ownedBySession` 且未降级的 tab 生效；
- `ACTION_OUTCOME_UNKNOWN`（授权或执行阶段）或非 Runtime 异常之后，该 tab 在当前连接内永久降级为 operator approval。

### operator approval 的证明来源

MCP elicitation 或 client UI 的响应不构成 operator-approved 的证明。MCP client 侧的确认界面由宿主或模型运行环境控制，MCP 进程无法证明它来自人类，也无法阻止同一个模型环境自动应答。operator-approved 只能来自扩展的审批 UI（见上文「Operator approval UI boundary」）：broker 只创建 pending request 并轮询状态，不能调用 approve。

### 出境脱敏

- 扩展返回的 verification、`verificationAttempts`、`freshRevision`、`postActionObservationError`、execution 细节与 evidence 中的 `observed`、`reason` 全部在 trusted client 或 broker 层丢弃；模型可见的 verification 在投影后的 observation 上本地重算；
- trusted Runtime 的错误在所有 model-facing 路径（open / observe / extract / verify / wait / act / 授权）都只保留 code，message 换成固定文本（Phase 6.6c 起由 `TrustedRuntimeHttpClient` 统一处理，不再依赖扩展错误消息恰好是静态文本）；
- 执行阶段固定 `verifyTimeoutMs=0`，act 耗时不随隐藏页面状态变化。

### 已接受的残余风险

- act 执行失败的 runtime code（`TARGET_OCCLUDED`、`DOCUMENT_CHANGED` 等）会原样保留，每次最多泄露约 1 bit 实时页面状态。该信道受三项约束：每连接预算（默认 16，上限 256）、同一 `(tab, revision, ref)` 至多执行一次、每次都需要授权（默认 operator approval）；
- 撤销是尽力而为：cancel RPC 不可达或失败（例如 native 通道已断开），或 tombstone 被驱逐后同 id 的 request 才迟到，扩展里仍可能遗留 pending request，事后批准会产生一个无人消费的 grant。该 grant 的 id 随机、单次使用、TTL 30 秒、精确绑定 `(tab, revision, ref)`，任意 navigation 或 tab removal 会撤销它；pending request 的有效期也已与 broker 等待时间对齐（`approvalTtlMs`）；
- 扩展的待审批池是全局共享的（上限 32），一个 MCP 连接高频发起审批可以把其它连接较早的待审批请求挤出为 `invalidated`。这只影响可用性（fail closed，不产生授权），尚未按连接分配配额；
- 读路径（`browser.observe`、`browser.wait` 轮询）没有速率或预算限制，一次长 wait 可触发数百次完整采集，属于对用户浏览器的资源放大，不突破安全边界；
- 同一 tab 上并发的两次 act，先结束的那次触发的降级对已经越过降级检查的另一次不生效；该窗口受预算与单次执行约束。

### 取消与撤销（Phase 6.6b-A）

- broker 生成 `authorizationId` 之后，只要 act 没有成功返回（授权超时、客户端取消、轮询出错、拒绝等终态、执行失败，含 `ACTION_OUTCOME_UNKNOWN` 与 RPC 超时），都会调用一次 `authorization.cancel-strict-click`。按 `authorizationId` 而不是 approval id 取消，request 的响应丢失时也能取消。
- 扩展先记 tombstone（有界，默认 256 条，FIFO 驱逐），拒绝之后到达的同 id issue / request / 企业签发；再撤销同 id 的未消费 grant（任意来源）；最后把同 id 的 pending approval 记为 `cancelled`，已批准的 approval 只有在 grant 确实被撤销时才翻为 `cancelled`。
- 撤销只减少能力。grant 在 policy gate 处就被消费，消费之后的撤销是 no-op，因此 cancel 成功不代表点击被阻止，broker 不会据此改变错误码或降级判断。
- cancel 只能经 trusted 通道调用，不进入模型工具目录。持有 trusted token 的调用方可以撤销任意已知 id 的授权；它们本就能签发授权，属于同一信任域，撤销不构成提权面。
- tombstone、pending approval 与 grant 都只存在于扩展 service worker 内存；service worker 重启时三者一起清空，整体仍 fail closed。
- 客户端取消信号只在 act 发出之前生效，绝不中断在途 act RPC，避免把“点击可能已发生”伪装成客户端取消。
- 等待审批期间的 MCP progress notification 只含递增计数与固定文本，不含 approval id、ref、origin、revision 或页面文本。

### 状态按连接计

预算、`(tab, revision, ref)` 账本与降级状态都保存在每个 MCP 连接自己的 broker 里。宿主重连会重置这些状态，模型自身无法触发重连。因此预算和降级是“每连接”而不是“每 operator”的限制，operator 需要把宿主的重连行为视为信任边界的一部分。

## Model-facing trace 边界（Phase 7-0b）

trace 默认关闭，只有 operator 设置 `BROWSER_AGENT_NEXT_TRACE_DIR` 才会写文件（设计见 `docs/TRACE-EVAL-FOUNDATION.md`）。

- **内容**：每次 tool call 一条事件（executed 的 act 另加一条动作后 verify），只包含 runId / sessionId / seq、事件层、结果 code、计数与延迟、act 的授权路径与审批结果，以及系统已证实的 tabId / revision / ref 与已通过 policy 的 exact origin。失败调用的入参标识没有经过任何查表，是模型自己选的字符串，合法字符集同样能拼出敏感数据，因此一律不记录。core 的 `validateTraceEvent`（exact-key + 格式白名单）是第二道防线，不合法的事件整条丢弃。
- **对模型不可见**：没有任何 tool 读取 trace，trace 内容不进入 MCP 结果；目录只来自进程环境。
- **文件**：只在当前用户拥有、`mode & 0o077 === 0` 的真实目录中以 `O_EXCL | O_NOFOLLOW` 新建 `0600` 文件，打开后用 fstat 与 dev/ino 复核；绝不打开、追加或截断已存在的文件，因此把目录配错也无法写坏 token、私钥或其它文件。Windows 上没有 `O_NOFOLLOW`，直接拒绝开启。
- **有界**：队列与每进程文件大小都有上限；进入授权阶段或已执行的 `browser.act` 事件有普通事件无法占用的保留容量（它们都发生在每连接预算扣减之后），在预算之前就失败的 act 调用与普通事件同档，因此模型无法先用廉价调用撑满再执行不被记录的 act。丢弃表现为同一 session 的 seq 断档；文件写满或写入失败后的尾部丢弃没有断档，只在 stderr 提示一次。
- **不是前置条件**：trace 的任何失败（未配置、队列满、文件满、写入失败、构造异常、授权回调异常）都不改变工具结果、错误 code、授权或执行路径。

已接受的残余：trace 记录访问过的 origin（都在 operator 已配置的 allowlist 内）与操作时间线；trace 文件的访问控制依赖 OS 用户隔离，与 trusted token 相同；模型输入校验失败在 adapter 里同为 `POLICY_BLOCKED`，会计入 policy 层；进程退出时队列中未写出的事件会丢失。

## Strict 写入边界（setValue，S1）

S1 只在 trusted 路径开放（`authorization.issue-strict-action`、`authorization.request-strict-action-approval`、`execution.execute-strict-action` 与 trusted `browser.act`）；model-facing `browser.act` 仍只接受 click。设计与威胁模型见 `docs/STRICT-WRITE-ACTIONS.md`。

- **参数绑定**：grant 绑定 `actionKind` 与规范化参数（含值原文），消费时逐字比较；为“填 A”签发的授权不能用于填 B，也不能用于 click，反之亦然。enterprise-policy 的签名结构只绑定 click，因此拒绝为写入签发。
- **版本错配**：写入只走独立的 strict-action 消息；旧 click 消息带 `action` 字段一律以 `INVALID_TRUSTED_HOST_REQUEST` 拒绝，旧扩展收到新消息类型同样拒绝，写入永远不会被执行成 click。
- **敏感字段**：password、`<input>` / `<textarea>` 上的凭据 / 支付 autocomplete、`-webkit-text-security` 遮盖的字段在感知阶段标记为 `sensitive`，签发与审批请求入队前就拒绝，审批页永远不显示这类字段的待写入值；写入函数在 focus 前后用同一组判定再复核。这是按已知形态列举的判定，不是完备的“敏感”定义。
- **单 task 写入**：在目标帧中唯一的、origin 为本扩展的 isolated world 里，一个同步函数内完成字段检查 → focus → 确认 `activeElement` → 复核 → `select()` → `execCommand`；不向“恰好有焦点的元素”发送 CDP 输入，不在另一个上下文重试。只写单行原生文本字段；OOPIF 中的目标在任何输入之前 fail closed。
- **结果语义**：focus 之后的任何失败都是 `ACTION_OUTCOME_UNKNOWN`，禁止自动重试；执行结果只带 `valueMatched` 布尔值，错误为固定文本，均不含值。动作后验证是普通 observation：trusted 路径与 `browser.observe` 一样能看到字段当前值，model-facing 出口去掉 `observed` 与未获允许的 `value`。
- **审批页**：值的字符集在所有入口限定为审批页能如实显示的字符（拒绝控制、格式、默认可忽略字符、非 U+0020 空格、U+2800、孤立代理项）；值完整显示、不截断、不设高度上限，附字符数与首尾 / 连续空格提示，并标注“来自调用方，非页面”；清空字段的说明显示在值框之外。
- **命中测试**：Strict 命中测试在目标自身的 tree scope 上进行，open shadow root 内的目标可以被 click 或写入，覆盖其上的元素（同一 shadow root、外层 tree 或其它 shadow host）仍判为遮挡。

已接受的残余：`element.focus()` 会触发页面的 focus / blur 回调；页面可以在 `input` 事件里改写值，`valueMatched` 如实反映；签发阶段无法预知的拒绝（`contenteditable`、OOPIF）在 grant 消费之后发生，浪费一次授权但 fail closed；Playwright 的焦点模拟使 E2E 无法证明真实后台标签页下的行为。

## Unknown Effect

Generic click 默认 effect=unknown、confidence=unknown。

Trusted grant 的存在只表示允许对该精确 target 尝试这个动作；它不会把 unknown 重新标成 known-safe。

## Ambiguous Outcome

mousePressed 请求发出后发生的任何 transport error 都必须视为 ACTION_OUTCOME_UNKNOWN，因为浏览器可能已执行输入但响应丢失。此时禁止自动 retry click，只允许重新 Observe → Verify → 由上层决定下一步。

## Authorization Assurance

当前已实现 `control-plane`、`operator-approved`、`enterprise-policy` 三个 assurance 层级，并按 Effect Class 校验最低 assurance。Trusted Native Host 只能签发 `control-plane`；operator-approved 与 enterprise-policy 仍需要各自独立的受信签发入口。

## Tab Ownership

Tab ownership 是 Policy 输入，因此属于安全属性。

当前唯一可以 mint `ownedBySession=true` 的路径是：

```text
trusted browser.open
→ chrome.tabs.create
→ valid tabId
→ TabOwnershipRegistry.markCreated
```

普通 `runtime.onMessage` 的 perception 请求不能携带 `ownedBySession`。即使请求来自 Extension 自己的页面/上下文，也不能通过该字段把用户已有 Tab 提升成 Agent-owned。

MV3 service worker restart 后 registry 丢失，旧 Tab 会安全降级为 user-existing，而不是猜测恢复 ownership。


## Operator approval UI boundary

`operator-approved` 的 baseline 由专用 Extension action popup 提供人工审批路径。

background 只接受 sender 同时满足：

```text
sender.id  == current extension id
sender.url == chrome-extension://<id>/operator-approval.html
```

control-plane/native-host 只能创建 pending request、读取状态和撤销（只减少能力），不能调用 approve。批准按钮触发后，pending request 会被单次消费，并在真正签发前重新验证 retained observation、ref、origin 与 assurance requirement。

### 审批页展示规则（Phase 6.6b-B）

审批页是 operator-approved 的唯一来源，展示必须帮助 operator 做出正确判断，而不是被页面内容误导：

- origin 来自浏览器（`URL.origin`，IDN 以 punycode 显示），标注“浏览器提供”，与页面文本分开展示；
- 目标名称、role、页面标题都来自页面，放在标注“页面提供的内容（不可信，仅供参考）”的虚线框里；显示前删除控制字符与格式字符（`\p{Cc}`、`\p{Cf}`，含 bidi 覆盖 / 隔离、零宽字符、soft hyphen、Tag 字符、BOM）以及变体选择符，空白折叠，按码点截断，加「」引号，只经 `textContent` 写入；清理后为空时显示固定占位；
- 每张卡片显示请求短码（approvalRequestId 末 6 位）与剩余时间，批准 / 拒绝后的提示带短码；
- 防误点：列表每 2 秒刷新，已有卡片不重排；新请求只追加到末尾，按钮延迟 500 ms 启用；消失的请求先原位禁用并标注“已失效”，下一次刷新才移除，移除位置之后的卡片按钮也延迟启用；本页已处理的请求不会被晚到的列表结果恢复为可点击；
- 带 query 或 hash 打开审批页时先跳回干净地址，以满足上面的 `sender.url` 精确匹配；
- 扩展图标角标只显示待审批数量，不含任何页面内容。

UI 防护只降低误点概率，签发正确性仍由 store 保证：批准时请求必须仍是 pending，并在签发前重新验证。

已知限制：Chrome 106–109 上 native messaging 端口不保证让 service worker 保活，worker 空闲后可能被回收，待审批请求随之清空（fail closed），角标可能残留到下次唤醒；下次启动时角标会按当前数量（0）重绘。非 `Cc` / `Cf` 的不可见字符（如 U+3164 HANGUL FILLER）不会被删除，只会以空白形式出现在不可信框内。

这个边界表示“来自受信扩展审批 UI 的明确批准路径”，仍不应被描述成对拥有同 UID 任意桌面自动化、调试器或扩展代码修改能力的攻击者提供 OS 级硬隔离。更强部署仍应使用独立 OS 用户、宿主审批进程或企业策略服务。


## Enterprise authorization proof boundary

`enterprise-policy` assurance 只能由经过受管公钥验证的签名 assertion 进入。

公钥来自 `chrome.storage.managed`，该区域由企业管理员下发且扩展侧只读；实现会进一步把 managed storage access level 限制为 `TRUSTED_CONTEXTS`。企业 assertion 使用 ECDSA P-256/SHA-256，并精确绑定 target/revision/origin/TTL 与 action/effect。

control-plane/native-host 只是 relay，不能：

- 自报 `source=enterprise-policy`；
- 自报 `assurance=enterprise-policy`；
- 提供任意验证公钥；
- 修改已签名的 ref/revision/origin/TTL；
- replay 已消费 assertion。

assertion replay ledger 存在 `storage.local` 并同样限制到 trusted contexts，因此 MV3 service-worker restart 不会清掉 replay 记录。持久化失败时 enterprise issuance fail closed。

这条边界的安全性依赖企业私钥在扩展之外安全保存。扩展只持有公开验证 key，不具备企业 assertion 的签名能力。


### Replay ledger capacity

Persistent enterprise replay state 采用 fail-closed capacity policy：

- 先清理已过期 assertion id；
- 未过期记录绝不因容量压力被淘汰；
- ledger 满时拒绝新的 enterprise issuance；
- storage 读取、结构校验或持久化失败时同样拒绝 issuance。

这样避免通过大量合法签名 assertion 挤出旧 replay marker 后重新使用旧 assertion。
