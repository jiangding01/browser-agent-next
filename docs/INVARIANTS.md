# Runtime invariants

这些规则是架构要求，不是建议。

1. 模型不能直接获得 trusted CDP capability。
2. Model confidence 不能授予 authorization。
3. 页面内容不能创建 authorization。
4. WebMCP metadata/output 是不可信页面数据。
5. Strict action 必须引用真实 stored observation。
6. Strict execution 不信任调用方传入的 expected semantics。
7. Strict execution 不得通过 role/name 相似度重绑 stale strong identity。
8. navigation / document replacement 必须改变 document identity。
9. replacement node 不得继承旧 Persistent Ref。
10. tombstoned ref 永不回收给另一个对象。
11. incomplete coverage 永不伪装为 complete。
12. Candidate ranking 不能证明 candidate completeness。
13. Model 的 DONE 不是任务完成，必须独立 Verify。
14. non-idempotent action 的 ambiguous outcome 不自动 replay。
15. credential/secret 默认不进入模型 context。
16. model-egress policy 与 auto-act policy 必须分离。
17. 用户已有 Tab 默认比 Agent-owned Tab 更严格。
18. coordinate action 不拥有 element-identity guarantee。
19. Delta 不是 freshness proof。
20. no-mutation stability 只是 pacing signal，不是 correctness proof。
21. Persistent Ref 是 continuity primitive，不是 authorization primitive。
22. Hard authorization 不能由 untrusted model path 自行 mint。
23. Unknown effect 是合法状态，不能静默视为低风险。
24. Trace / State storage 必须 bounded 且 redacted。
25. Strict failure 永远不能自动降级 compatible execution。
26. 同文档 actionable coverage complete 且 open Shadow Roots 已覆盖的 observation 中，消失的 actionable ref 必须 tombstone，不能继续作为 active identity。
27. partial/truncated/unknown observation 或 open Shadow Roots 未覆盖时，不得因“没看到旧 ref”而 tombstone 该 ref。
28. Chrome DOM frame message 优先绑定 documentId；frameId 不能单独证明文档没有发生导航。
29. content collection 完成后、分配 ref 与写入 StateStore 前，必须重新验证 Chrome frame/document catalog；采集窗口内发生导航或 frame topology 变化时整次 observation 作废。
30. BrowserObservation 的 canonical URL 必须来自与 documentId 同一份 frame catalog；不得用可能跨导航竞态的独立 tab URL 代替。
31. Persistent Ref 字符串本身不跨 runtime stateEpoch 构成权威身份；MV3 service worker 重启后旧 observation 必须视为不可用，任何 Strict Action 都必须同时引用仍存在的 observedRevision。
32. coverage 的 complete 仅表示声明的 observation profile / expectedSources 已完整执行；它不是“网页所有像素、事件监听器和隐式可点击区域都已被发现”的证明，FastPath 仍需独立 eligibility/page policy。
33. Trusted grant 必须精确绑定 tab + observedRevision + ref + actionKind + effectClass；不得授权“某个页面上任意下一次点击”。
34. Trusted grant 默认 single-use 且有 TTL；navigation/tab removal 必须撤销相关 grant。
35. Generic click 的业务副作用在无法由结构化 primitive 证明时必须保持 unknown；hard authorization 不能把 unknown 重新标记成 known。
36. 真正 dispatch 前必须执行第二次 Strict Prepare；第一次 preflight 得到的 point 不能跨 policy/authorization 窗口复用。
37. mousePressed 请求发出后任何 transport failure 都属于 ambiguous outcome；不得自动重放动作。
38. execute 后的 observation/verification 可以重试，但 non-idempotent action 本身不得因 Verify inconclusive 自动 retry。
39. trusted authorization ingress 必须与普通 runtime message ingress 分离；普通页面或 Agent message 不得调用 grant issue / real dispatch。
40. grant 签发后若 live node 被 same-looking replacement 替换，旧 revision/ref/grant 仍必须在 dispatch 前因 strong identity mismatch 被拒绝。
41. active authorization id 不得被同名 grant 静默覆盖；重复 ID 只有在旧 grant 已过期后才允许重新签发。
42. trusted RPC token path 必须是当前用户拥有的普通文件，不能接受符号链接；state directory 也不能是 symlink。
43. Native Messaging outbound write 失败必须立即向上层报告失败，不能伪装成已成功入管道并等待超时。
44. auto-act allowlist 的配置值必须是纯 origin；包含 path/query/fragment/credentials 的 URL 必须拒绝，不能静默扩大为整个 origin。
45. Native Messaging 一旦发生可能产生半帧的同步写异常，当前 transport 必须 fail closed；不能继续向同一长度流发送后续 frame。
46. Trusted Native Host token 仅证明 control-plane caller 能访问该 token；如果同一 Coding Agent 拥有同 UID 任意 filesystem/network 能力，不得把该 token 宣称为对该 Agent 的 OS 级 hard authorization。
47. webNavigation frame 与 CDP Frame 的对应关系必须由 browser-level strong evidence 建立；URL、frame 顺序、parent index、role/name/geometry 均不能作为 identity mapping 依据。
48. 任一 declared accessible frame 无法建立 exact CDP mapping 时，AX coverage 必须降级为 partial；不能因为其它 frame 成功而报告 complete。
49. child-frame Hybrid identity 的建立不自动授予 child-frame actuation 能力；在 top-level coordinate projection 与最终 hit-test 完成前，child-frame Strict Click 必须继续 fail closed。
50. cross-process/OOPIF 若当前 chrome.debugger root session 无法取得对应 execution context/session，则视为 unmapped/degraded frame，而不是通过 URL 或拓扑猜测补齐。
51. Authorization Assurance 必须来自受信 grant 签发边界；模型、页面或调用方 JSON 不能自行声明或提升 assurance。
52. 现有 Trusted Native Host 只能签发 control-plane assurance；在独立 operator/enterprise ingress 完成前不得伪装成更高等级。
53. Agent-facing browser.observe 在 Tab Ownership Registry 完成前不得接受调用方 supplied ownedBySession；默认按 user-existing tab 处理。
54. browser.verify 只能验证指定 retained observation；它不是 fresh live-state proof。
55. browser.wait 可以重试 observation/verification，但不得执行或重放任何 browser action；DOM/navigation signal 只能提前唤醒，且必须保留 bounded timeout fallback。
56. browser.act 遇到未支持 action kind 必须 fail closed，不得自动降级 compatible/raw-CDP execution。
57. Agent-facing Browser API 的集合大小、timeout 和 polling interval 必须有显式上限，避免 untrusted caller 造成无界资源消耗。
58. unknown effect 在用户已有 Tab 上至少要求 operator-approved；control-plane 只能覆盖可信证明为 Agent-owned 的 unknown action。
59. 高层 observation 单次 candidate 上限必须与传输预算匹配；当前 DOM/AX 各最多 500，超大 action space 应通过 truncation/scoping/paging 处理，而不是无界扩大 Native Messaging payload。
60. authorization source 必须具有自己的 assurance ceiling；trusted-host 最高只能 control-plane，不能只依赖 ingress 层硬编码来阻止权限升级。
61. browser.open 是当前唯一可以 mint Agent-owned Tab 的高层 Runtime 入口；Runtime 必须真实创建该 Tab，高层 API 不接受 caller supplied ownedBySession/claim，未知 Tab 与 MV3 restart 后均按 user-existing 处理。
62. browser.open 只允许无 credentials 的绝对 http/https URL；javascript:/data:/file:/chrome: 等 scheme 必须 fail closed。
63. browser.extract 只能读取 retained BrowserObservation；不得绕过 observation profile 直接执行 caller supplied selector/JS。missing ref 不能脱离原 observation coverage 被解释为页面真实不存在。
64. authorization assurance label 不得因为“强度更高”而被重标成另一种证明类型；签发源与 assurance label 必须按受信入口精确绑定，Policy 的满足关系与 grant provenance 是两个独立概念。
65. browser.open 返回的 requestedUrl 只证明请求目标，不证明导航完成或最终 URL；committed/final URL 必须来自后续 BrowserObservation。
66. 普通 runtime perception ingress 不得接受 caller supplied ownedBySession；即使 sender.id 是当前 Extension，自身 extension context 也不能通过 observe request mint Agent-owned 语义。
67. High-level browser.* runtime facade 不是最终 model-egress boundary；未来 MCP/LLM adapter 必须单独执行 model-egress/navigation policy，并且不得向模型暴露 policy mutation 或 authorization issuance 能力。
68. model-egress policy 与 auto-act origin policy 必须保持独立；可读取/可出境不等价于可自动产生副作用。
69. 普通 perception ingress 的 requestId、sinceRevision、candidate count 与选项类型必须经过有界校验，拒绝无界输入和未知类型。
70. AX lifecycle binding 必须同时保留 frameEpoch、CDP frame id 与 documentEpoch；迟到的 navigation event 若对应当前已观察文档，不得清理新文档的 refs 或 state。
71. Native Messaging Port 断连或回包失败后必须停用 ingress；异步请求完成时不得继续回传、重连或重放动作。

72. Model-facing tool catalog 必须是独立显式 allowlist；trusted-host 内部 RPC、新增控制面方法不能因为名称存在就自动成为模型工具。
73. Model read/egress origin policy、model navigation origin policy、Runtime auto-act origin policy 是三个独立 policy plane，任何一个 allow 都不能推导另外两个 allow。第 119 条在此基础上增加第 4 个独立 plane（model act origin）。
74. `sinceRevision`、model-facing `browser.extract` 与 `browser.verify` 只能引用已经成功通过 model-egress projection 的 model-visible revision；adapter restart 后不得猜测恢复内部 revision 可见性。
75. 未被 model read policy 允许的 child frame 内容不得进入模型；发生 frame egress filtering 时 coverage 必须降级，模型“没看到”不能被解释为页面不存在。
76. credential/value 默认不进入模型；模型请求 `includeValues=true` 不能越过 trusted model-egress policy，verification evidence 也不得把被 redaction 的 observed value 二次带回模型。
77. Model-facing `extract/verify/wait` 必须基于 projected model-visible observation；不得通过直接调用 trusted Runtime 的完整 retained state / verification 形成 hidden-state boolean side channel。
78. `browser.act` 只能经过 scoped broker 暴露给模型；模型不能提供或铸造 authorizationId、actionId、assurance。

79. Model-facing MCP stdio 必须使用 connection factory 创建独立 adapter/invoker；model-visible revision store 不得跨 MCP connection 共享。
80. MCP tools/call 的名称必须再次经过当前 catalog allowlist 校验；未列出的工具不得进入 model-facing adapter dispatch。
81. MCP tool result 必须有显式字节数上限；超限结果 fail closed，不能无界写入模型上下文。
82. MCP error 出境只能包含 bounded code/message；BrowserRuntimeError.details、stack 与未知异常原文不得返回模型。
83. Stdio stdout 是 MCP protocol channel；实现不得向 stdout 写业务日志或调试文本。

84. Model-facing trusted Runtime client 的公共能力只能是明确需要的高层 Runtime 方法：open / observe，加上 broker 专用的 act、issueStrictClick、requestOperatorApproval、operatorApprovalStatus；这四个 broker 专用方法不得出现在 adapter 的 runtime client 类型里，仍然禁止 generic trusted RPC passthrough。
85. Trusted Runtime HTTP client 只能连接显式 loopback endpoint，并且必须禁止 redirect；trusted Bearer token 不得因 URL/redirect/proxy-style 配置进入非 loopback 目标。
86. MCP 侧只能读取 native-host 已存在的 trusted token，不能创建、轮换或修复 token；token 路径必须拒绝 symlink、错误 owner 和过宽权限。
87. Trusted Runtime response 必须绑定精确 requestId，并受显式字节数与结构校验约束；不满足时不得进入 model-facing adapter。
88. browser.open 在传输失败且无法证明是否已创建 Tab 时必须返回 ACTION_OUTCOME_UNKNOWN；上层不得自动重放 open。
89. trusted-host 返回的未知 error code 不得直接升级为 RuntimeErrorCode；只有共享白名单中的 error code 才能保留语义。

90. MCP operator 配置只能来自进程启动控制面，不得由 model tool arguments 修改；read/navigation origin 默认必须是空集合。
91. MCP CLI 不得提供 trusted token value 的环境变量入口；只允许读取受保护 token file，并且必须在 stdio protocol wire 启动前完成校验。
92. MCP CLI 的 origin 配置必须复用 exact-origin policy；path/query/fragment/credentials 不能被静默 canonicalize 成更宽 origin。
93. MCP CLI 的 `includeValues` 默认必须为 false；只有显式 operator 配置可以开启，模型自己的 includeValues 请求不能越过该开关。
94. MCP CLI 启动失败只能写 stderr；任何 startup/config/debug 文本都不得污染 stdout MCP wire。


95. Operator-approved grant 必须由专用 trusted Extension approval UI 的明确批准动作产生；control-plane 只能创建 pending approval / 查询状态，不能直接 approve。
96. Operator approval request 必须单次消费且有界过期；任意 committed navigation 或 tab removal 必须清除该 tab 的 pending approval。
97. Enterprise-policy grant 不能由第二个普通 control-plane token 或 caller-supplied assurance 产生；必须验证独立 enterprise proof。
98. Enterprise authorization assertion 必须签名绑定 authorizationId、tab、revision、ref、origin、action/effect、validity window 与 grant TTL；任一字段修改都必须使签名失效。
99. Enterprise verification public key 只能来自管理员受管配置；control-plane/model/page 不能在 issuance request 中提供或替换 verification key。
100. Enterprise assertion 必须 consume-once，且 replay state 必须跨 MV3 service-worker restart 持久化；replay persistence 不可用时必须 fail closed。未过期 replay marker 不得因容量限制被驱逐，ledger 满时必须拒绝新的 enterprise issuance。
101. Enterprise grant TTL 不得超出 signed assertion 的剩余有效期；signature 验证通过后仍必须重新执行 retained observation / ref / origin / minimum assurance 校验。

102. OOPIF child session 必须由 debugger flat-session 的 opaque sessionId/targetId 证明，禁止使用 URL、frame 顺序或名称推断 child target。
103. Root-session execution context 与 child-session execution context 必须保持 session provenance；任何 child context 的 CDP command 不得退回 root session 发送。
104. OOPIF auto-attach 不可用、child session 未登记或 session 已 detach 时必须保持 mapping/actuation fail closed，不能退化为 main-frame dispatch。
105. Child-frame Strict live resolution 必须使用 observation 已证明的 exact frame binding；不得仅凭 web frameId、URL、frame 顺序或 cdpFrameId 猜测 child session。
106. OOPIF child 的 backend-node linking、DOM inspection 与 AX revalidation 必须全部发送到同一个 exact cdpSessionId；任一步 session provenance 缺失或不一致都必须 fail closed。
107. 在 top-level coordinate projection 与 root-level pre-dispatch validation 完成前，即使 child live identity 已全部匹配，也不得生成可 dispatch 的 Strict Click prepared target。
108. Child-frame 坐标投影必须沿 retained frame parent chain 和 exact lifecycle CDP binding 逐层计算；URL、frame 顺序和几何相似度不能用于补齐 identity。
109. 每一层投影必须先在 exact CDP session 的 isolated-world context 中重新证明 frameEpoch，并使用实时 child viewport 与父 session 的 frame-owner content quad。
110. 只有可证明的 2D affine frame-owner content quad 可以参与自动投影；perspective、退化或不可解释 quad 必须 fail closed。
111. 投影到 root 后必须重新验证 root viewport bounds，并通过 top-level hit-test 证明 projected point 仍命中最外层 frame owner；否则不得生成可执行 target。
112. Prepared Strict Click 的 dispatch 坐标必须显式标记为 `top-level-viewport`；child-local 或未声明 coordinate space 的 target 不得进入 `Input.dispatchMouseEvent`。
113. Child-frame resolver 只有在 same-session live identity 与 child→root projection 都成功后才能返回 `identityMatches=true`；projection 失败必须等价于 target 不可安全执行。
114. Effect/authorization policy 通过后仍必须执行第二次 Strict prepare，因此 child-frame identity 与 top-level projection 必须在真正 dispatch 前重新计算，不能复用第一次 prepare 的几何结果。
115. Nested child-frame 坐标投影的每一跳都必须在对应 parent execution context 中对 frame-owner 执行 live hit-test；只验证最外层 root iframe 不足以证明内层 iframe 未被 parent-document overlay 遮挡。
116. Scroll、layout shift 或 2D transform 后的 frame-owner 坐标必须来自当前 prepare 的实时 `DOM.getBoxModel`；不得缓存或复用前一次 prepare 的投影坐标。
117. auto-act origins 配置文件必须是当前用户拥有、非 symlink、不可被组或其他用户写入的普通文件，且只接受纯 origin；任一条目非法时整份文件作废、不做部分应用，扩展 allowlist 保持为空（fail closed）；native host 不得因配置读取失败而向 stdout 写入。

118. （N1）side-effect tier 的工具不得进入默认 `MODEL_TOOLS`；只有 operator 显式写进 `BROWSER_AGENT_NEXT_MODEL_TOOLS` 才会暴露。
119. （N2）model act origin 是第 4 个独立 policy plane，默认为空且必须是 read origin 的子集；tab origin 与目标 element 所在 frame 的有效 origin（`about:blank` / `about:srcdoc` 继承父 frame）都必须满足。
120. （N3）只能对本连接已出境 revision 中已投影的 ref 发起授权。
121. （N4）同一 `(tab, revision, ref)` 每个连接至多执行一次，标记先于任何 trusted 请求落账；`ACTION_OUTCOME_UNKNOWN` 之后该 tab 至少需要 operator-approved。
122. （N5）MCP elicitation 或 client UI 的响应不构成 operator-approved 的证明，批准只能来自扩展的审批 UI。
123. （N6）act 结果必须经过出境投影，不得携带扩展侧的 verification、`observed`、未出境的 revision 或原始错误文本；模型可见的 verification 必须在投影后的 observation 上本地计算。
124. 浏览器跨 process 路由 `Input.dispatchMouseEvent` 依据的是 root renderer 已 present 的 compositor hit-test 数据，而 Strict prepare 的 box model / `elementFromPoint` 读取 main-thread 实时 layout；二者一致不能被假设。目标位于 OOPIF child session 时，dispatch 前必须在 root frame 的独立 isolated world 中等待 root renderer present 足够的 animation frame（presentation fence）；root 文档 hidden、超时、异常或 frame 不足都必须在任何 input 之前 fail closed。当前 fence 只覆盖 root renderer，nested OOPIF 中间层 renderer 的 presentation 延迟是已知限制，不得据此宣称中间层路由已被证明。
125. Presentation fence 之后必须再次执行 Strict prepare，live identity、frame/session binding 与 top-level 点必须与 fence 前一致才可 dispatch；任一变化都 fail closed，且不得自动重试 click。grant TTL 必须在 fence 之后、`mousePressed` 之前再次校验。
126. Model act broker 生成 `authorizationId` 后，只要 act 未成功返回，就必须按 `authorizationId` 撤销本次授权（pending approval 与未消费 grant）；撤销尽力而为，失败不得覆盖原错误，撤销成功也不代表点击被阻止，不得据此改变错误码或降级判断。降级状态必须先于撤销 RPC 落定。扩展侧撤销后必须拒绝同 id 的迟到签发（有界 tombstone）。客户端取消只能阻止尚未发出的 act，不得中断在途 act RPC。
127. 等待 operator approval 期间发给 MCP 客户端的 progress notification 只能包含严格递增的计数与固定文本，不得包含 approval id、authorization id、ref、origin、revision 或任何页面派生文本；客户端未提供 progressToken 时不得发送。
128. 审批页必须把页面派生文本（目标名称、role、页面标题）放在明确标注为不可信的区域，并与浏览器提供的 origin 分开展示；显示前必须删除控制字符、格式字符（含 bidi 覆盖 / 隔离与零宽字符）与变体选择符，且只能经 `textContent` 写入。自动刷新不得让已有卡片在 operator 点击时移位而按钮仍可用：已有卡片不重排、新卡片只追加并延迟启用、消失的卡片先原位禁用再移除。扩展角标只能显示待审批数量。
