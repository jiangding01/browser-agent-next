import { timingSafeEqual } from "node:crypto";
import http from "node:http";

export interface TrustedBridgeRequest {
  type: string;
  requestId: string;
  [key: string]: unknown;
}

export interface TrustedRpcServerOptions {
  host?: string;
  port?: number;
  token: string;
  forward(
    request: TrustedBridgeRequest,
  ): Promise<unknown>;
}

const MAX_BODY_BYTES = 256 * 1024;
const ALLOWED_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

function allowedHostHeader(
  value: string | undefined,
): boolean {
  if (!value) return false;

  let hostname: string;

  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return false;
    hostname = value.slice(0, close + 1);
    const suffix = value.slice(close + 1);
    if (suffix && !/^:\d{1,5}$/.test(suffix)) {
      return false;
    }
  } else {
    const parts = value.split(":");
    hostname = parts[0] ?? "";
    if (
      parts.length > 2 ||
      (
        parts.length === 2 &&
        !/^\d{1,5}$/.test(parts[1] ?? "")
      )
    ) {
      return false;
    }
  }

  return ALLOWED_HOSTS.has(
    hostname.toLowerCase(),
  );
}

function validBearer(
  header: string | undefined,
  expected: string,
): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = header.slice(7);
  if (actual.length !== expected.length) return false;

  try {
    return timingSafeEqual(
      Buffer.from(actual),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

async function readBody(
  request: http.IncomingMessage,
): Promise<string> {
  const declared = Number(
    request.headers["content-length"],
  );

  if (
    Number.isFinite(declared) &&
    declared > MAX_BODY_BYTES
  ) {
    throw new Error("REQUEST_TOO_LARGE");
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error("REQUEST_TOO_LARGE"));
        request.destroy();
        return;
      }

      chunks.push(Buffer.from(chunk));
    });

    request.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", reject);
  });
}

function json(
  response: http.ServerResponse,
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

export class TrustedRpcServer {
  private server: http.Server | undefined;

  constructor(
    private readonly options: TrustedRpcServerOptions,
  ) {}

  async start(): Promise<{
    host: string;
    port: number;
  }> {
    if (this.server) {
      throw new Error("trusted RPC server already started");
    }

    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 17366;

    const server = http.createServer(
      (request, response) => {
        void this.handle(request, response);
      },
    );

    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("trusted RPC server address unavailable");
    }

    return {
      host,
      port: address.port,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;

    server.closeIdleConnections();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (!allowedHostHeader(request.headers.host)) {
      request.resume();
      json(response, 400, {
        ok: false,
        error: "invalid host header",
      });
      return;
    }

    if (
      request.method === "GET" &&
      request.url === "/health"
    ) {
      request.resume();
      json(response, 200, {
        ok: true,
        service: "browser-agent-next-native-host",
      });
      return;
    }

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
        this.options.token,
      )
    ) {
      request.resume();
      json(response, 401, {
        ok: false,
        error: "unauthorized",
      });
      return;
    }

    try {
      const body = await readBody(request);
      const parsed = JSON.parse(body) as Partial<TrustedBridgeRequest>;

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

      const result = await this.options.forward(
        parsed as TrustedBridgeRequest,
      );

      json(response, 200, result);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "REQUEST_TOO_LARGE"
      ) {
        json(response, 413, {
          ok: false,
          error: "request too large",
        });
        return;
      }

      json(response, 500, {
        ok: false,
        error: (
          error instanceof Error
            ? error.message
            : "trusted RPC failure"
        ).slice(0, 500),
      });
    }
  }
}
