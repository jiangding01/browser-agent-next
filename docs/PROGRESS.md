# 实现进度

最后更新：2026-09-20

## 当前分支

```text
feat/high-level-browser-api-assurance
```

## 当前阶段

```text
PR #1 Foundation + DOM Perception        ✅ 已合并
PR #2 Hybrid + Strict Click              ✅ 已合并
PR #3 Child-frame Hybrid                 ✅ 已合并
Authorization Assurance                  ✅
browser.observe                          ✅
browser.verify                           ✅
browser.wait baseline                    ✅
browser.act / Strict Click               ✅
Real Chromium High-level API E2E         🚧 CI 验证中
browser.extract                          ⏭
event-driven wait                        ⏭
```

## PR #4 当前完成内容

- AuthorizationAssurance：control-plane / operator-approved / enterprise-policy；
- grant consume 按 minimum assurance 校验；
- trusted-host 只能签发 control-plane，不能由请求自报升级；
- 高层 browser.observe 默认 Hybrid；
- 高层 API 不接受 ownedBySession，当前安全默认按 user-existing tab；
- browser.verify 只验证指定 retained revision；
- browser.wait 只重复 fresh observation + verification，不执行动作；
- browser.act 第一版只接 Strict Click；
- trusted protocol 对 API 输入做数量、timeout、poll interval 等边界校验；
- 真实 Chromium trusted E2E 已改为通过 browser.observe / verify / wait / act 驱动主闭环。

## 当前边界

`browser.wait` 当前是 bounded polling baseline，不宣称 event-driven。

`browser.act` 只支持 main-frame Strict Click；child-frame actuation 继续 fail closed。

## 下一步

1. 等待并处理最新 CI / Real Chromium E2E；
2. 对 High-level API 做最终对抗式 Review；
3. 决定 PR #4 是否同时加入 browser.extract，或拆到下一 PR；
4. 收口后再通知合并。
