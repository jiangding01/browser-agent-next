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
26. 同文档 complete observation 中消失的 actionable ref 必须 tombstone，不能继续作为 active identity。
27. partial/truncated/unknown observation 不得因“没看到旧 ref”而 tombstone 该 ref。
28. Chrome DOM frame message 优先绑定 documentId；frameId 不能单独证明文档没有发生导航。
29. content collection 完成后、分配 ref 与写入 StateStore 前，必须重新验证 Chrome frame/document catalog；采集窗口内发生导航或 frame topology 变化时整次 observation 作废。
30. BrowserObservation 的 canonical URL 必须来自与 documentId 同一份 frame catalog；不得用可能跨导航竞态的独立 tab URL 代替。
31. Persistent Ref 字符串本身不跨 runtime stateEpoch 构成权威身份；MV3 service worker 重启后旧 observation 必须视为不可用，任何 Strict Action 都必须同时引用仍存在的 observedRevision。
32. coverage 的 complete 仅表示声明的 observation profile / expectedSources 已完整执行；它不是“网页所有像素、事件监听器和隐式可点击区域都已被发现”的证明，FastPath 仍需独立 eligibility/page policy。
33. Trusted grant 必须精确绑定 tab + observedRevision + ref + actionKind + effectClass；不得授权“某个页面上任意下一次点击”。
34. Trusted grant 默认 single-use 且有 TTL；navigation/tab removal 必须撤销相关 grant。
35. Generic click 的业务副作用在无法由结构化 primitive 证明时必须保持 unknown；hard authorization 不能把 unknown 重新标记成 known。
36. 真正 dispatch 前必须执行第二次 Strict Prepare；第一次 preflight 得到的 point 不能跨 policy/authorization 窗口复用。
37. mousePressed 成功后任何 transport failure 都属于 ambiguous outcome；不得自动重放动作。
38. execute 后的 observation/verification 可以重试，但 non-idempotent action 本身不得因 Verify inconclusive 自动 retry。
39. trusted authorization ingress 必须与普通 runtime message ingress 分离；普通页面或 Agent message 不得调用 grant issue / real dispatch。
40. grant 签发后若 live node 被 same-looking replacement 替换，旧 revision/ref/grant 仍必须在 dispatch 前因 strong identity mismatch 被拒绝。
41. active authorization id 不得被同名 grant 静默覆盖；重复 ID 只有在旧 grant 已过期后才允许重新签发。
42. trusted RPC token path 必须是当前用户拥有的普通文件，不能接受符号链接；state directory 也不能是 symlink。
43. Native Messaging outbound write 失败必须立即向上层报告失败，不能伪装成已成功入管道并等待超时。
