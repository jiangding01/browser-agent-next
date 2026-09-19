import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:4173";
const mainUrl = fixtureOrigin + "/main.html";
const hostName = "com.browser_agent_next.host";

async function freePort(): Promise<number> {
  const server = net.createServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("free port unavailable"));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function extensionIdOf(
  context: BrowserContext,
): Promise<string> {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent("serviceworker");
  }

  const id = worker.url().split("/")[2];
  if (!id) {
    throw new Error("extension id unavailable");
  }

  return id;
}

function browserEnv(
  home: string,
  port: number,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  env.HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.BROWSER_AGENT_NEXT_RPC_PORT = String(port);

  return env;
}

function writeNativeHostRegistration(
  home: string,
  extensionId: string,
): void {
  const wrapper = path.join(
    home,
    "browser-agent-next-native-host.sh",
  );

  const hostEntry = path.resolve(
    "apps/native-host/dist/index.js",
  );

  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      "exec " +
        JSON.stringify(process.execPath) +
        " " +
        JSON.stringify(hostEntry) +
        ' "$@"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(wrapper, 0o700);

  const manifest = JSON.stringify(
    {
      name: hostName,
      description:
        "Browser Agent Next E2E trusted host",
      path: wrapper,
      type: "stdio",
      allowed_origins: [
        "chrome-extension://" +
          extensionId +
          "/",
      ],
    },
    null,
    2,
  ) + "\n";

  const candidates =
    process.platform === "darwin"
      ? [
          path.join(
            home,
            "Library/Application Support/Chromium/NativeMessagingHosts",
          ),
          path.join(
            home,
            "Library/Application Support/Google/Chrome/NativeMessagingHosts",
          ),
        ]
      : [
          path.join(
            home,
            ".config/chromium/NativeMessagingHosts",
          ),
          path.join(
            home,
            ".config/google-chrome/NativeMessagingHosts",
          ),
        ];

  for (const dir of candidates) {
    mkdirSync(dir, {
      recursive: true,
      mode: 0o700,
    });

    writeFileSync(
      path.join(
        dir,
        hostName + ".json",
      ),
      manifest,
      { mode: 0o600 },
    );
  }
}

async function waitForTrustedHost(
  port: number,
  tokenPath: string,
): Promise<string> {
  let lastError = "not started";

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (existsSync(tokenPath)) {
        const response = await fetch(
          "http://127.0.0.1:" + port + "/health",
        );

        if (response.ok) {
          return readFileSync(
            tokenPath,
            "utf8",
          ).trim();
        }
      }
    } catch (error) {
      lastError =
        error instanceof Error
          ? error.message
          : String(error);
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 50)
    );
  }

  throw new Error(
    "trusted native host did not start: " +
      lastError,
  );
}

async function trustedRequest(
  port: number,
  token: string,
  body: unknown,
): Promise<any> {
  const response = await fetch(
    "http://127.0.0.1:" + port + "/trusted",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const json = await response.json();

  if (!response.ok) {
    throw new Error(
      "trusted RPC failed: " +
        response.status +
        " " +
        JSON.stringify(json),
    );
  }

  return json;
}

async function targetTabId(
  harness: Page,
): Promise<number> {
  return harness.evaluate(async (prefix) => {
    const chromeApi = (
      globalThis as unknown as {
        chrome: {
          tabs: {
            query(
              queryInfo: Record<string, unknown>,
            ): Promise<
              Array<{
                id?: number;
                url?: string;
              }>
            >;
          };
        };
      }
    ).chrome;

    const tabs = await chromeApi.tabs.query({});
    const target = tabs.find((tab) =>
      tab.url?.startsWith(prefix)
    );

    if (typeof target?.id !== "number") {
      throw new Error(
        "fixture tab id unavailable",
      );
    }

    return target.id;
  }, fixtureOrigin);
}

async function observe(
  harness: Page,
  tabId: number,
): Promise<{
  revision: { id: string };
  elements: Array<{
    ref: string;
    semantic: {
      name?: string;
    };
  }>;
}> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await harness.evaluate(
      async ({ tabId, requestId }) => {
        const chromeApi = (
          globalThis as unknown as {
            chrome: {
              runtime: {
                sendMessage(
                  message: unknown,
                ): Promise<any>;
              };
            };
          }
        ).chrome;

        return chromeApi.runtime.sendMessage({
          type: "perception.observe-tab",
          requestId,
          tabId,
          ownedBySession: true,
          options: {
            includeAx: true,
          },
        });
      },
      {
        tabId,
        requestId:
          "trusted-e2e-observe-" +
          attempt +
          "-" +
          Date.now(),
      },
    );

    if (
      response?.ok &&
      response.observation
    ) {
      return response.observation;
    }

    await harness.waitForTimeout(50);
  }

  throw new Error(
    "hybrid observation unavailable",
  );
}

test(
  "真实 Chromium 中 trusted host 授权后执行一次 Strict Click 并独立验证结果",
  async () => {
    test.skip(
      process.platform === "win32",
      "Windows Native Messaging 注册表安装将在独立安装器阶段覆盖",
    );

    const extensionPath = path.resolve(
      "apps/extension/dist",
    );
    const home = mkdtempSync(
      path.join(
        tmpdir(),
        "browser-agent-next-e2e-home-",
      ),
    );
    const rpcPort = await freePort();
    const env = browserEnv(home, rpcPort);

    let discovery:
      | BrowserContext
      | undefined;
    let context:
      | BrowserContext
      | undefined;

    try {
      discovery =
        await chromium.launchPersistentContext(
          path.join(home, "profile-discovery"),
          {
            channel: "chromium",
            headless: true,
            env,
            args: [
              "--disable-extensions-except=" +
                extensionPath,
              "--load-extension=" +
                extensionPath,
            ],
          },
        );

      const extensionId =
        await extensionIdOf(discovery);

      await discovery.close();
      discovery = undefined;

      writeNativeHostRegistration(
        home,
        extensionId,
      );

      context =
        await chromium.launchPersistentContext(
          path.join(home, "profile-execute"),
          {
            channel: "chromium",
            headless: true,
            env,
            args: [
              "--disable-extensions-except=" +
                extensionPath,
              "--load-extension=" +
                extensionPath,
            ],
          },
        );

      const loadedId =
        await extensionIdOf(context);

      expect(loadedId).toBe(extensionId);

      const token = await waitForTrustedHost(
        rpcPort,
        path.join(
          home,
          ".browser-agent-next/trusted-rpc.token",
        ),
      );

      const target = await context.newPage();
      await target.goto(mainUrl);
      await target.waitForLoadState("load");

      await target.evaluate(() => {
        const button = document.querySelector(
          "#main-action",
        );
        if (!button) {
          throw new Error(
            "main action missing",
          );
        }

        button.addEventListener("click", () => {
          location.href = "/done.html";
        });
      });

      const harness = await context.newPage();
      await harness.goto(
        "chrome-extension://" +
          extensionId +
          "/e2e-harness.html",
      );

      const tabId =
        await targetTabId(harness);
      const current =
        await observe(harness, tabId);

      const save = current.elements.find(
        (element) =>
          element.semantic.name === "Save",
      );

      if (!save) {
        throw new Error(
          "Save ref unavailable",
        );
      }

      const policyResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "policy.replace-autoact-origins",
            requestId: "policy-1",
            origins: [fixtureOrigin],
          },
        );

      expect(policyResponse).toMatchObject({
        ok: true,
        result: {
          origins: [fixtureOrigin],
        },
      });

      const authResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId: "auth-req-1",
            authorizationId: "auth-1",
            tabId,
            observedRevision:
              current.revision.id,
            ref: save.ref,
            ttlMs: 5_000,
          },
        );

      expect(authResponse).toMatchObject({
        ok: true,
        result: {
          id: "auth-1",
          origin: fixtureOrigin,
        },
      });

      const executeResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "execution.execute-strict-click",
            requestId: "execute-1",
            actionId: "action-1",
            authorizationId: "auth-1",
            tabId,
            observedRevision:
              current.revision.id,
            ref: save.ref,
            verification: {
              mode: "all",
              conditions: [{
                type: "url_matches",
                pattern:
                  fixtureOrigin +
                  "/done.html",
              }],
            },
            verifyTimeoutMs: 3_000,
          },
        );

      expect(executeResponse).toMatchObject({
        ok: true,
        result: {
          execution: {
            status: "executed",
            actionId: "action-1",
          },
          verification: {
            verified: true,
            conclusive: true,
          },
        },
      });

      await expect(target).toHaveURL(
        fixtureOrigin + "/done.html",
      );
    } finally {
      await context?.close();
      await discovery?.close();

      rmSync(home, {
        recursive: true,
        force: true,
      });
    }
  },
);
