import http from "node:http";
import { describe, expect, it } from "vitest";
import { TrustedRpcServer } from "./trustedRpcServer.js";

function request(
  port: number,
  options: {
    token?: string;
    body?: unknown;
    host?: string;
  } = {},
): Promise<{
  status: number;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(
      options.body ?? {
        type: "policy.replace-autoact-origins",
        requestId: "req-1",
        origins: [],
      },
    );

    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/trusted",
      method: "POST",
      headers: {
        host: options.host ?? "127.0.0.1:" + port,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        ...(options.token
          ? {
              authorization:
                "Bearer " + options.token,
            }
          : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ),
        });
      });
    });

    req.once("error", reject);
    req.end(payload);
  });
}

describe("TrustedRpcServer", () => {
  it("必须使用 trusted bearer token", async () => {
    const server = new TrustedRpcServer({
      port: 0,
      token: "a".repeat(64),
      async forward(request) {
        return {
          ok: true,
          requestId: request.requestId,
        };
      },
    });

    const { port } = await server.start();

    try {
      expect((await request(port)).status).toBe(401);

      const accepted = await request(port, {
        token: "a".repeat(64),
      });

      expect(accepted).toEqual({
        status: 200,
        body: {
          ok: true,
          requestId: "req-1",
        },
      });
    } finally {
      await server.stop();
    }
  });

  it("拒绝 DNS rebinding 风格 Host header", async () => {
    const server = new TrustedRpcServer({
      port: 0,
      token: "a".repeat(64),
      async forward() {
        return { ok: true };
      },
    });

    const { port } = await server.start();

    try {
      expect((await request(port, {
        token: "a".repeat(64),
        host: "evil.example:" + port,
      })).status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});
