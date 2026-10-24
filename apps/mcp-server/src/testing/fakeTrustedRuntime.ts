import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type {
  BrowserObservation,
  ElementState,
  FrameState,
} from "@browser-agent-next/core";

/**
 * 测试专用：node:http 实现的假 trusted RPC 服务。
 *
 * 只监听 127.0.0.1 随机端口；路由、Bearer 校验与响应信封与
 * apps/native-host/src/trustedRpcServer.ts + 扩展 trustedNativeIngress 一致：
 * POST /trusted，`authorization: Bearer <token>`，响应
 * `{ type: "trusted-host.result", requestId, ok, result | error }`，requestId 原样回显。
 * 按请求 type 分派到脚本 handler，并按到达顺序记录全部已鉴权请求。
 */

export interface FakeTrustedRequest {
  type: string;
  requestId: string;
  [key: string]: unknown;
}

export type FakeTrustedReply =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        outcomeMayHaveChanged?: boolean;
      };
    };

export type FakeTrustedHandler = (
  request: FakeTrustedRequest,
) => FakeTrustedReply | Promise<FakeTrustedReply>;

export interface FakeTrustedRuntimeOptions {
  token: string;
  handlers: Readonly<
    Partial<Record<string, FakeTrustedHandler>>
  >;
}

export interface FakeTrustedRuntime {
  readonly host: "127.0.0.1";
  readonly port: number;
  /** 已通过 Bearer 校验的请求，按到达顺序。 */
  readonly requests: readonly FakeTrustedRequest[];
  /** Bearer 校验失败（401）的请求数。 */
  unauthorizedCount(): number;
  ofType(type: string): FakeTrustedRequest[];
  /** 类型以 prefix 开头的请求，如 "authorization."。 */
  withPrefix(prefix: string): FakeTrustedRequest[];
  types(): string[];
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;

function validBearer(
  header: string | undefined,
  expected: string,
): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return (
    actual.length === wanted.length &&
    timingSafeEqual(actual, wanted)
  );
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(
  request: IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeTrustedRuntime(
  options: FakeTrustedRuntimeOptions,
): Promise<FakeTrustedRuntime> {
  const requests: FakeTrustedRequest[] = [];
  let unauthorized = 0;

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (
      request.method !== "POST" ||
      request.url !== "/trusted"
    ) {
      request.resume();
      json(response, 404, {
        ok: false,
        error: "not found",
      });
      return;
    }

    if (
      !validBearer(
        request.headers.authorization,
        options.token,
      )
    ) {
      unauthorized += 1;
      request.resume();
      json(response, 401, {
        ok: false,
        error: "unauthorized",
      });
      return;
    }

    let parsed: Partial<FakeTrustedRequest>;
    try {
      parsed = JSON.parse(
        await readBody(request),
      ) as Partial<FakeTrustedRequest>;
    } catch {
      json(response, 400, {
        ok: false,
        error: "invalid trusted request envelope",
      });
      return;
    }

    if (
      typeof parsed.type !== "string" ||
      !parsed.type ||
      typeof parsed.requestId !== "string" ||
      !parsed.requestId
    ) {
      json(response, 400, {
        ok: false,
        error: "invalid trusted request envelope",
      });
      return;
    }

    const trusted = parsed as FakeTrustedRequest;
    requests.push(trusted);

    const handler = options.handlers[trusted.type];
    let reply: FakeTrustedReply;
    try {
      reply = handler
        ? await handler(trusted)
        : {
            ok: false,
            error: {
              code: "INVALID_TRUSTED_HOST_REQUEST",
              message:
                "fake trusted runtime has no handler for " +
                trusted.type,
            },
          };
    } catch (error) {
      json(response, 500, {
        ok: false,
        error: (
          error instanceof Error
            ? error.message
            : "fake trusted handler failed"
        ).slice(0, 500),
      });
      return;
    }

    json(response, 200, {
      type: "trusted-host.result",
      requestId: trusted.requestId,
      ...reply,
    });
  };

  const server = createServer(
    (request, response) => {
      void handle(request, response);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fake trusted runtime address unavailable");
  }

  return {
    host: "127.0.0.1",
    port: address.port,
    requests,
    unauthorizedCount: () => unauthorized,
    ofType: (type) =>
      requests.filter((item) => item.type === type),
    withPrefix: (prefix) =>
      requests.filter((item) =>
        item.type.startsWith(prefix)
      ),
    types: () => requests.map((item) => item.type),
    close: () =>
      new Promise<void>((resolve) => {
        // fetch 默认 keep-alive；先断开所有连接再关闭监听。
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface MakeObservationOptions {
  tabId: number;
  revision: string;
  /** 顶层页面 URL；tab.origin 由它推导。 */
  url: string;
  ownedBySession?: boolean;
  title?: string;
  /** 缺省为单个顶层 frame `web:0`（url 同 tab）。 */
  frames?: FrameState[];
  /** 缺省为顶层 frame 中的 Save 按钮 `@save`。 */
  elements?: ElementState[];
}

export function makeButton(
  ref: string,
  frameId = "web:0",
  name = "Save",
): ElementState {
  return {
    ref,
    kind: "element",
    semantic: { role: "button", name },
    state: {
      visible: true,
      enabled: true,
      focused: false,
    },
    frameId,
    capabilities: [{ kind: "click" }],
    provenance: { dom: true, ax: true },
  };
}

/**
 * 构造能通过 trusted client `isBrowserObservation` 全量校验的 observation。
 */
export function makeObservation(
  options: MakeObservationOptions,
): BrowserObservation {
  const origin = new URL(options.url).origin;
  const frames = options.frames ?? [
    {
      frameId: "web:0",
      url: options.url,
      documentEpoch: "doc-" + options.revision,
      accessible: true,
    },
  ];
  const elements = options.elements ?? [
    makeButton("@save"),
  ];

  return {
    schemaVersion: 1,
    tab: {
      tabId: options.tabId,
      title: options.title ?? "Fixture",
      url: options.url,
      origin,
      ownedBySession:
        options.ownedBySession ?? false,
    },
    revision: {
      id: options.revision,
      stateEpoch: "runtime",
      documentEpoch: "doc-" + options.revision,
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: {
        status: "complete",
        returned: elements.length,
        totalKnown: elements.length,
      },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: {
        status: "complete",
        returned: elements.length,
        totalKnown: elements.length,
      },
      frames: {
        discovered: frames.length,
        accessible: frames.filter((frame) => frame.accessible)
          .length,
        degraded: [],
      },
      shadowDom: {
        openRootsCovered: true,
        closedRootsUnknown: true,
      },
      canvas: { present: false, semanticallyCovered: false },
    },
    viewport: {
      width: 1280,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1280,
      scrollHeight: 800,
    },
    frames,
    elements,
  };
}
