#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bootstrapAutoActOrigins,
  readAutoActOriginsConfig,
} from "./autoActOriginsFile.js";
import { NativeMessagingTransport } from "./nativeMessaging.js";
import { ensureTrustedToken } from "./tokenFile.js";
import {
  TrustedRpcServer,
  type TrustedBridgeRequest,
} from "./trustedRpcServer.js";

const HOST = "127.0.0.1";
const PORT = Number(
  process.env.BROWSER_AGENT_NEXT_RPC_PORT ?? 17366,
);
const STATE_DIR = join(
  homedir(),
  ".browser-agent-next",
);

const token = ensureTrustedToken(STATE_DIR);
const transport = new NativeMessagingTransport();

interface Pending {
  callerRequestId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

// 在 bootstrap await 期间 transport 可能已关闭，因此这两个状态必须先于
// transport.on("close") 声明，避免 shutdown() 触发 TDZ 错误。
let shuttingDown = false;
let rpc: TrustedRpcServer | undefined;

transport.on("message", (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null
  ) {
    return;
  }

  const response = message as {
    requestId?: unknown;
  };

  if (typeof response.requestId !== "string") {
    return;
  }

  const item = pending.get(response.requestId);
  if (!item) return;

  pending.delete(response.requestId);
  clearTimeout(item.timer);

  item.resolve({
    ...(message as Record<string, unknown>),
    requestId: item.callerRequestId,
  });
});

transport.on("parse-error", (error) => {
  console.error(
    "[browser-agent-next/native-host] native JSON parse error:",
    error,
  );
});

transport.on("transport-error", (error) => {
  console.error(
    "[browser-agent-next/native-host] native transport error:",
    error,
  );
});

transport.on("close", () => {
  for (const [id, item] of pending) {
    clearTimeout(item.timer);
    item.reject(
      new Error("Chrome extension disconnected"),
    );
    pending.delete(id);
  }

  void shutdown();
});

transport.start();

// stdout 是 Native Messaging 协议通道，这里只能写 stderr。
// 读取/下发失败都不阻止启动：扩展 allowlist 保持为空（fail closed）。
await bootstrapAutoActOrigins(
  () => readAutoActOriginsConfig(STATE_DIR),
  forwardToExtension,
  (message) =>
    console.error(
      "[browser-agent-next/native-host] " + message,
    ),
);

const server = new TrustedRpcServer({
  host: HOST,
  port: PORT,
  token,
  forward: forwardToExtension,
});
rpc = server;

try {
  const address = await server.start();
  console.error(
    "[browser-agent-next/native-host] trusted RPC listening on http://" +
      address.host +
      ":" +
      address.port,
  );
} catch (error) {
  console.error(
    "[browser-agent-next/native-host] failed to start trusted RPC:",
    error,
  );
  process.exit(1);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await rpc?.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function forwardToExtension(
  request: TrustedBridgeRequest,
): Promise<unknown> {
  const wireId = "native-" + randomUUID();
  const callerRequestId = request.requestId;
  const outbound = {
    ...request,
    requestId: wireId,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(wireId);
      reject(
        new Error(
          "trusted extension request timed out: " +
            request.type,
        ),
      );
    }, 15_000);

    pending.set(wireId, {
      callerRequestId,
      resolve,
      reject,
      timer,
    });

    if (!transport.send(outbound)) {
      clearTimeout(timer);
      pending.delete(wireId);
      reject(
        new Error(
          "trusted request exceeds native messaging outbound limit",
        ),
      );
    }
  });
}
