import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  BrowserObservation,
} from "@browser-agent-next/core";
import {
  TrustedRuntimeHttpClient,
  readTrustedRpcToken,
} from "./trustedRuntimeClient.js";

const TOKEN = "a".repeat(64);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  }
});

function observation(): BrowserObservation {
  return {
    schemaVersion: 1,
    tab: {
      tabId: 7,
      title: "",
      url: "https://allowed.test/",
      origin: "https://allowed.test",
      ownedBySession: true,
    },
    revision: {
      id: "rev-1",
      stateEpoch: "state-1",
      documentEpoch: "doc-1",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: {
        status: "complete",
        returned: 1,
        totalKnown: 1,
      },
      forms: {
        status: "complete",
        returned: 0,
        totalKnown: 0,
      },
      text: {
        status: "complete",
        returned: 1,
        totalKnown: 1,
      },
      frames: {
        discovered: 1,
        accessible: 1,
        degraded: [],
      },
      shadowDom: {
        openRootsCovered: true,
        closedRootsUnknown: true,
      },
      canvas: {
        present: false,
        semanticallyCovered: false,
      },
    },
    viewport: {
      width: 1000,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1000,
      scrollHeight: 800,
    },
    frames: [{
      frameId: "web:0",
      url: "https://allowed.test/",
      documentEpoch: "doc-1",
      accessible: true,
    }],
    elements: [{
      ref: "@save",
      kind: "element",
      semantic: {
        role: "button",
        name: "Save",
      },
      state: {
        visible: true,
        enabled: true,
        focused: false,
      },
      frameId: "web:0",
      capabilities: [{ kind: "click" }],
      provenance: { dom: true },
    }],
  };
}

function successResponse(
  requestId: string,
  result: unknown,
): Response {
  return new Response(
    JSON.stringify({
      type: "trusted-host.result",
      requestId,
      ok: true,
      result,
    }),
    { status: 200 },
  );
}

describe("TrustedRuntimeHttpClient", () => {
  it("只构造 browser.open / browser.observe，携带 bearer 且禁止 redirect", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit;
      body: Record<string, unknown>;
    }> = [];

    const fetchImpl: typeof fetch =
      async (input, init) => {
        const body = JSON.parse(
          String(init?.body),
        ) as Record<string, unknown>;
        calls.push({
          url: String(input),
          init: init ?? {},
          body,
        });

        return successResponse(
          String(body.requestId),
          body.type === "browser.open"
            ? {
                tabId: 9,
                requestedUrl: body.url,
                ownedBySession: true,
              }
            : observation(),
        );
      };

    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        fetchImpl,
        requestId: () => "req-fixed",
      });

    await client.open({
      url: "https://allowed.test/",
      active: false,
    });
    await client.observe({
      tabId: 7,
      sinceRevision: "rev-0",
      options: {
        profile: "hybrid",
        maxElements: 100,
      },
    });

    expect(calls[0]).toMatchObject({
      url:
        "http://127.0.0.1:17366/trusted",
      init: {
        method: "POST",
        redirect: "error",
      },
      body: {
        type: "browser.open",
        requestId: "req-fixed",
        url: "https://allowed.test/",
        active: false,
      },
    });
    expect(
      (calls[0]?.init.headers as
        Record<string, string>)
        .authorization,
    ).toBe("Bearer " + TOKEN);

    expect(calls[1]?.body).toEqual({
      type: "browser.observe",
      requestId: "req-fixed",
      tabId: 7,
      sinceRevision: "rev-0",
      options: {
        profile: "hybrid",
        maxElements: 100,
      },
    });
  });

  it("拒绝非 loopback host", () => {
    expect(
      () =>
        new TrustedRuntimeHttpClient({
          token: TOKEN,
          host: "example.com",
        }),
    ).toThrow(/loopback/);
  });

  it("response requestId 不匹配时 fail closed", async () => {
    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "expected",
        fetchImpl: async () =>
          successResponse(
            "wrong",
            observation(),
          ),
      });

    await expect(
      client.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
    });
  });

  it("open 的传输失败视为 ambiguous outcome，observe 则视为 state incomplete", async () => {
    const client =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        fetchImpl: async () => {
          throw new Error("connection lost");
        },
      });

    await expect(
      client.open({
        url: "https://allowed.test/",
      }),
    ).rejects.toMatchObject({
      code: "ACTION_OUTCOME_UNKNOWN",
    });

    await expect(
      client.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
    });
  });

  it("trusted Runtime 已知错误码保持语义，未知错误码不透传", async () => {
    const known =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-known",
        fetchImpl: async () =>
          new Response(JSON.stringify({
            type: "trusted-host.result",
            requestId: "req-known",
            ok: false,
            error: {
              code: "ORIGIN_NOT_ALLOWED",
              message: "blocked",
            },
          }), { status: 200 }),
      });

    await expect(
      known.open({
        url: "https://blocked.test/",
      }),
    ).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      message: "blocked",
    });

    const unknown =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-unknown",
        fetchImpl: async () =>
          new Response(JSON.stringify({
            type: "trusted-host.result",
            requestId: "req-unknown",
            ok: false,
            error: {
              code: "SOMETHING_NEW",
              message: "internal detail",
            },
          }), { status: 200 }),
      });

    await expect(
      unknown.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
      message:
        "trusted Runtime returned an unknown error code",
    });
  });

  it("malformed observation 与超大 response 都拒绝进入 model adapter", async () => {
    const malformed =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        requestId: () => "req-malformed",
        fetchImpl: async () =>
          successResponse(
            "req-malformed",
            {
              schemaVersion: 1,
              tab: { tabId: 7 },
            },
          ),
      });

    await expect(
      malformed.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
    });

    const oversized =
      new TrustedRuntimeHttpClient({
        token: TOKEN,
        maxResponseBytes: 1_024,
        requestId: () => "req-large",
        fetchImpl: async () =>
          new Response(
            "x".repeat(2_048),
            { status: 200 },
          ),
      });

    await expect(
      oversized.observe({ tabId: 7 }),
    ).rejects.toMatchObject({
      code: "STATE_INCOMPLETE",
    });
  });

  it("MCP 侧只读 secure token，不创建、不接受 symlink 或宽权限", () => {
    const dir = mkdtempSync(
      join(
        tmpdir(),
        "browser-agent-next-mcp-token-",
      ),
    );
    dirs.push(dir);
    chmodSync(dir, 0o700);

    const tokenPath = join(
      dir,
      "trusted-rpc.token",
    );
    writeFileSync(
      tokenPath,
      TOKEN,
      { mode: 0o600 },
    );

    expect(
      readTrustedRpcToken(tokenPath),
    ).toBe(TOKEN);

    if (process.platform !== "win32") {
      chmodSync(tokenPath, 0o644);
      expect(
        () =>
          readTrustedRpcToken(
            tokenPath,
          ),
      ).toThrow(/permissions/);
      chmodSync(tokenPath, 0o600);

      const target = join(
        dir,
        "target.token",
      );
      writeFileSync(
        target,
        TOKEN,
        { mode: 0o600 },
      );
      const link = join(
        dir,
        "link.token",
      );
      symlinkSync(target, link);

      expect(
        () =>
          readTrustedRpcToken(link),
      ).toThrow(/symlink/);
    }
  });
});
