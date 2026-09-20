# PR #6 Final Adversarial Review

更新日期：2026-09-20

## 结论

PR #6 完成了 Authorization Assurance 从“类型与等级”到“独立证明来源”的闭环。

最终不存在允许 control-plane 通过请求字段自行升级为 `operator-approved` 或 `enterprise-policy` 的路径。

本 PR 的核心边界：

```text
control-plane
  ├─ issueControlPlane()
  │    → trusted-host / control-plane
  │
  ├─ request operator approval
  │    → pending only
  │    → explicit trusted UI click
  │    → trusted-ui / operator-approved
  │
  └─ relay enterprise assertion
       → managed public key verification
       → persistent consume-once replay check
       → enterprise-policy / enterprise-policy
```

`browser.act` 仍未进入 model-facing MCP surface。

---

## 1. Shared issuance core

所有 Strict Click grant 最终进入同一个 `StrictClickAuthorizationIssuanceService`。

三个入口在代码层固定 provenance：

```text
issueControlPlane()
  source=trusted-host
  assurance=control-plane

issueOperatorApproved()
  source=trusted-ui
  assurance=operator-approved

issueEnterprisePolicy()
  source=enterprise-policy
  assurance=enterprise-policy
```

调用参数不存在 `source` 或 `assurance`。

三条路径共享：

- retained observation 校验；
- ref membership；
- exact auto-act origin policy；
- bounded TTL；
- minimum assurance；
- precise tab/revision/ref/action/effect binding；
- single-use grant。

---

## 2. Operator-approved ingress

### Control-plane capability

control-plane 只能：

- 创建 pending approval；
- 查询 approval status。

不能调用 approve。

trusted-host protocol 没有 operator approve request type。

### Human approval boundary

真正批准只接受：

```text
sender.id == current extension id
sender.url == chrome-extension://<id>/operator-approval.html
```

专用 action popup 显示：

- origin；
- page title；
- role/name；
- Persistent Ref；
- “批准一次 / 拒绝”。

UI request 使用 exact-key validator，不能夹带 `source` / `assurance`。

### Freshness

pending approval 不创建 grant。

用户点击批准后：

```text
consume pending
→ re-run issuance checks
→ mint trusted-ui grant
```

因此 pending 期间发生：

- navigation；
- retained revision 丢失；
- ref 失效；
- origin policy 变化；

都会在最终 issuance 处 fail closed。

任意 committed navigation / tab removal 同时清 active grant 和 pending approval。

---

## 3. Enterprise-policy ingress

### Trust root

enterprise verification key 只能来自：

```text
chrome.storage.managed
```

managed storage 在读取前限制到 `TRUSTED_CONTEXTS`。

control-plane request 不能提供：

- verification key；
- source；
- assurance。

### Signed assertion

当前 baseline 使用：

```text
ECDSA P-256 + SHA-256
```

canonical signed payload 精确包含：

- assertionId；
- keyId；
- authorizationId；
- tabId；
- observedRevision；
- ref；
- exact origin；
- actionKind=click；
- effectClass=unknown；
- issuedAt；
- expiresAt；
- grantTtlMs。

任一绑定字段变化都会破坏签名。

### Time bounds

- assertion 必须已经生效；
- assertion 必须尚未过期；
- assertion lifetime 不能超过 managed policy 上限；
- grant TTL 不能超过 60 秒；
- grant 不能活得比 signed assertion 更久。

### Post-signature checks

签名有效不直接等于 grant。

仍然需要：

```text
signed origin == retained observation origin
→ persistent replay consume
→ shared issuance core
→ ref/origin/minimum assurance checks
```

---

## 4. Replay protection

Enterprise assertion 采用 persistent consume-once ledger：

```text
chrome.storage.local
+ TRUSTED_CONTEXTS
+ serialized consume
```

这使 replay marker 跨 MV3 service-worker restart 保留。

### Final-review finding

初版 bounded ledger 在超容量时会淘汰最早过期时间的记录，即使该记录仍未过期。

这会产生：

```text
valid assertion A consumed
→ ledger pressure
→ A marker evicted
→ A can be replayed
```

最终实现已改为：

```text
prune expired only
→ if unexpired ledger full
→ POLICY_BLOCKED
→ do not mint new grant
```

因此未过期 replay marker 永不因容量压力被驱逐。

---

## 5. MV3 restart semantics

### Operator

pending approval 只在内存中存在。

service-worker restart 后 pending 丢失，结果是需要重新请求人工批准，属于 fail-safe。

### Enterprise

replay marker 持久化在 `storage.local`。

service-worker restart 后已消费 assertion 仍保持不可重放。

active AuthorizationGrant 本身仍是内存态；worker restart 会丢失 grant，而不是恢复权限。

---

## 6. Model-facing boundary

PR #5 建立的 MCP 边界没有扩大。

Model-facing Runtime client 仍只公开：

```text
browser.open
browser.observe
```

模型仍不能调用：

- operator approval request/approve；
- enterprise assertion issuance；
- authorization issuance；
- policy mutation；
- raw trusted RPC；
- `browser.act`。

Phase 6.6 在 scoped authorization broker 完成前继续保持 fail closed。

---

## 7. Security limits

### Operator-approved

trusted Extension UI 是产品内证明来源，不应被描述成针对拥有以下能力的攻击者的 OS 级硬隔离：

- 同 UID 任意进程控制；
- 桌面/UI 自动化；
- DevTools / debugger 控制；
- 扩展代码篡改。

更强部署应采用独立 OS 用户、宿主审批进程或平台级 confirmation。

### Enterprise-policy

企业私钥必须保留在扩展之外。

扩展只持有 public verification key。

如果企业签名服务私钥泄露，`enterprise-policy` assurance 的证明根也随之失效；这是该 assurance 的外部信任根，而不是浏览器 Runtime 可以补救的问题。

当前只支持一个 managed P-256 key。多 key rotation / overlap 是后续可扩展项，不影响当前 fail-closed baseline。

---

## 8. Merge gate

最终 HEAD 必须同时满足：

- [x] pnpm frozen-lockfile install
- [x] TypeScript typecheck
- [x] 243 unit / integration tests
- [x] operator request/status/UI provenance tests
- [x] enterprise real P-256 sign/verify tests
- [x] managed policy tests
- [x] persistent replay / capacity tests
- [x] workspace build
- [x] managed schema + popup packaging
- [x] Real Chromium E2E
- [x] docs / roadmap / invariants synchronized
- [x] no model-facing authorization surface
- [x] no caller-supplied assurance escalation

## 最终判断

PR #6 已达到本阶段合并条件。

合并后建议下一阶段回到浏览器执行能力缺口：

1. OOPIF/session exact mapping；
2. child-frame coordinate projection / actuation；
3. 再单独推进 Phase 6.6 model-facing scoped authorization broker；
4. 随后进入 Intelligence Layer。
