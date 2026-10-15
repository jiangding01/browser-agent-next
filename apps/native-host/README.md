# Native Host

Chrome Native Messaging host，同时在 `127.0.0.1` 上提供带 Bearer token 认证的 trusted RPC。它只负责传输与安全基础设施；浏览器规划和模型相关逻辑不属于这里。

## 职责

- 由 Chrome 通过 `connectNative` 拉起，每次扩展连接都是一个新进程。
- 通过 stdin/stdout 与扩展交换 Native Messaging 帧，并把本地 trusted RPC 请求转发给扩展。
- **stdout 是 Native Messaging 协议通道，禁止写入任何其他内容；日志只能写 stderr。**
- 启动时从配置文件向扩展下发 auto-act origin allowlist（见下文）。

## 状态目录与 token 文件

状态目录为 `~/.browser-agent-next/`，必须是当前用户拥有的真实目录（非 symlink），权限不得向组或其他用户开放（`0700`）。

`trusted-rpc.token` 保存 trusted RPC 的 Bearer token：不存在时自动创建（`0600`），存在时必须是当前用户拥有、非 symlink、不含任何组或其他用户权限位（`mode & 0o077` 为 0）的普通文件，内容为 64 位十六进制字符串，否则 native host 拒绝启动。

## Auto-act origins 配置文件

扩展的 auto-act origin allowlist 默认为空。要让 native host 在启动时下发 allowlist，请创建 `~/.browser-agent-next/autoact-origins.json`：

```json
{
  "version": 1,
  "origins": ["http://127.0.0.1:4173", "https://example.com"]
}
```

格式要求：

- 顶层 key 必须恰好是 `version` 和 `origins`，不能多也不能少；`version` 必须等于 `1`。
- `origins` 是数组，长度 0～100；每一项是非空字符串、长度不超过 2048，且只能是纯 origin（`http:` 或 `https:`）。带 path（包括尾部的 `/`）、query、fragment、credentials、默认端口写法（如 `https://example.com:443`）或其他协议（`javascript:`、`file:` 等）的条目都会被拒绝。条目必须与 `new URL(entry).origin` 完全一致，因此主机名要写成小写、国际化域名要写成 punycode（例如 `https://xn--bcher-kva.de`），否则同样被拒绝。重复条目会被去重。
- 任何一项非法，**整份文件作废**，不做部分应用。

权限要求：

- 目录要求与 token 相同（当前用户拥有、非 symlink、`0700`）。
- 文件必须是当前用户拥有的普通文件，不能是 symlink，不能被组或其他用户写入（`mode & 0o022` 必须为 0）。origins 不是机密，所以不强制 `0600`（`0644` 可以）。
- 文件大小上限 64 KiB。

生效时机：

- 每次 native host 启动（即扩展连接时）读取一次，并在 trusted RPC 开始监听之前通过 `policy.replace-autoact-origins` 下发给扩展。成功时 stderr 只记录下发的数量，不记录 origin 列表。
- 运行期间通过 RPC 调用 `policy.replace-autoact-origins` 的结果只存在于扩展内存里；下次 native host 重新连接（例如 Service Worker 重启）时会被配置文件内容覆盖。
- 文件不存在时不下发，allowlist 保持扩展默认的空集合。
- 文件非法、读取失败或下发失败时，native host 只在 stderr 记录原因并继续启动，不下发任何内容，扩展 allowlist 保持为空，所有 act 都会被拒绝（fail closed）。
