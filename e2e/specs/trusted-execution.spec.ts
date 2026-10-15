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
  profileDir: string,
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

  // Chromium 源码中的 DIR_USER_NATIVE_MESSAGING 基于当前
  // user-data-dir，而不是只看默认 HOME 配置目录。E2E 使用
  // launchPersistentContext 的独立 profile，因此首先写入 profile。
  const candidates = [
    path.join(
      profileDir,
      "NativeMessagingHosts",
    ),
    ...(process.platform === "darwin"
      ? [
          path.join(
            home,
            "Library/Application Support/Chromium/NativeMessagingHosts",
          ),
          path.join(
            home,
            "Library/Application Support/Google/Chrome/NativeMessagingHosts",
          ),
          path.join(
            home,
            "Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts",
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
          path.join(
            home,
            ".config/google-chrome-for-testing/NativeMessagingHosts",
          ),
        ]),
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

      const executeProfile = path.join(
        home,
        "profile-execute",
      );

      writeNativeHostRegistration(
        home,
        executeProfile,
        extensionId,
      );

      context =
        await chromium.launchPersistentContext(
          executeProfile,
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

      const harness = await context.newPage();
      await harness.goto(
        "chrome-extension://" +
          extensionId +
          "/e2e-harness.html",
      );

      // 先证明用户已有 Tab 不会被 caller 自报成 Agent-owned。
      const userTarget = await context.newPage();
      await userTarget.goto(mainUrl);
      await userTarget.waitForLoadState("load");

      const userTabId =
        await targetTabId(harness);

      const userObservation =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.observe",
            requestId: "browser-observe-user-tab",
            tabId: userTabId,
            options: {
              profile: "hybrid",
            },
          },
        );

      expect(userObservation).toMatchObject({
        ok: true,
        result: {
          tab: {
            tabId: userTabId,
            ownedBySession: false,
          },
        },
      });

      const userSave =
        userObservation.result.elements.find(
          (element) =>
            element.semantic.name === "Save",
        );
      if (!userSave) {
        throw new Error("user-tab Save ref unavailable");
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

      const rejectedUserTabAuth =
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId: "auth-user-tab-rejected",
            authorizationId: "auth-user-tab",
            tabId: userTabId,
            observedRevision:
              userObservation.result.revision.id,
            ref: userSave.ref,
            ttlMs: 5_000,
          },
        );

      expect(rejectedUserTabAuth).toMatchObject({
        ok: false,
        error: {
          code: "AUTHORIZATION_REQUIRED",
        },
      });

      await userTarget.close();

      // browser.open 是当前唯一可以 mint Agent-owned tab 的高层入口。
      const createdPage = context.waitForEvent("page");
      const openResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.open",
            requestId: "browser-open-1",
            url: mainUrl,
            active: false,
          },
        );

      expect(openResponse).toMatchObject({
        ok: true,
        result: {
          requestedUrl: mainUrl,
          ownedBySession: true,
        },
      });

      const target = await createdPage;
      await target.waitForLoadState("load");

      const tabId = openResponse.result.tabId;

      const currentResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.observe",
            requestId: "browser-observe-1",
            tabId,
            options: {
              profile: "hybrid",
            },
          },
        );

      expect(currentResponse).toMatchObject({
        ok: true,
        result: {
          tab: {
            tabId,
            ownedBySession: true,
          },
        },
      });

      const current = currentResponse.result;

      const save = current.elements.find(
        (element) =>
          element.semantic.name === "Save",
      );

      if (!save) {
        throw new Error(
          "Save ref unavailable",
        );
      }

      const extractResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.extract",
            requestId: "browser-extract-1",
            tabId,
            observedRevision:
              current.revision.id,
            refs: [save.ref],
            maxItems: 10,
          },
        );

      expect(extractResponse).toMatchObject({
        ok: true,
        result: {
          revision: current.revision.id,
          truncated: false,
          totalMatched: 1,
          items: [{
            ref: save.ref,
            semantic: {
              name: "Save",
            },
          }],
        },
      });

      const verifyResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.verify",
            requestId: "browser-verify-1",
            tabId,
            observedRevision:
              current.revision.id,
            verification: {
              mode: "all",
              conditions: [{
                type: "ref_exists",
                ref: save.ref,
              }],
            },
          },
        );

      expect(verifyResponse).toMatchObject({
        ok: true,
        result: {
          verified: true,
          conclusive: true,
          revision: current.revision.id,
        },
      });

      // 真实验证 event-assisted wait：
      // 使用一个稍后插入的 actionable button 触发 content MutationObserver，
      // browser.wait 应被 signal 提前唤醒，然后重新 Observe + Verify。
      await target.evaluate(() => {
        setTimeout(() => {
          const button = document.createElement("button");
          button.id = "wait-ready";
          button.textContent = "Wait Ready";
          document.body.appendChild(button);
        }, 150);
      });

      const waitResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.wait",
            requestId: "browser-wait-1",
            tabId,
            timeoutMs: 3_000,
            pollIntervalMs: 1_000,
            verification: {
              mode: "all",
              conditions: [{
                type: "text_present",
                text: "Wait Ready",
              }],
            },
          },
        );

      expect(waitResponse).toMatchObject({
        ok: true,
        result: {
          timedOut: false,
          observation: {
            tab: {
              tabId,
              ownedBySession: true,
            },
          },
          verification: {
            verified: true,
          },
        },
      });

      expect(
        waitResponse.result.signalWakeups,
      ).toBeGreaterThanOrEqual(1);

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

      // 授权签发后，把目标替换成外观完全相同的新节点。
      // 旧 ref / grant 绝不能因为 role/name 相同而点击 replacement。
      await target.evaluate(() => {
        const oldButton = document.querySelector(
          "#main-action",
        );
        if (!oldButton) {
          throw new Error("main action missing");
        }

        const replacement =
          oldButton.cloneNode(true) as HTMLElement;
        oldButton.replaceWith(replacement);
      });

      const rejectedReplacement =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId: "browser-act-replacement",
            tabId,
            action: {
              actionId: "action-replacement",
              kind: "click",
              authorizationId: "auth-1",
              observedRevision:
                current.revision.id,
              ref: save.ref,
            },
            verification: {
              mode: "all",
              conditions: [{
                type: "url_matches",
                pattern:
                  fixtureOrigin +
                  "/done.html",
              }],
            },
            verifyTimeoutMs: 500,
          },
        );

      expect(rejectedReplacement).toMatchObject({
        ok: false,
        error: {
          code: "TARGET_IDENTITY_MISMATCH",
        },
      });

      await expect(target).toHaveURL(mainUrl);

      const refreshedResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.observe",
            requestId: "browser-observe-2",
            tabId,
            options: {
              profile: "hybrid",
            },
          },
        );

      expect(refreshedResponse).toMatchObject({
        ok: true,
        result: {
          tab: {
            tabId,
            ownedBySession: true,
          },
        },
      });

      const refreshed =
        refreshedResponse.result;
      const replacementSave =
        refreshed.elements.find(
          (element) =>
            element.semantic.name === "Save",
        );

      if (!replacementSave) {
        throw new Error(
          "replacement Save ref unavailable",
        );
      }

      expect(replacementSave.ref).not.toBe(
        save.ref,
      );

      await target.evaluate(() => {
        const button = document.querySelector(
          "#main-action",
        );
        if (!button) {
          throw new Error(
            "replacement main action missing",
          );
        }

        document.addEventListener("mousemove", () => {
          const rect = button.getBoundingClientRect();
          const overlay = document.createElement("div");
          overlay.id = "strict-mousemove-overlay";
          Object.assign(overlay.style, {
            position: "fixed",
            left: rect.left + "px",
            top: rect.top + "px",
            width: rect.width + "px",
            height: rect.height + "px",
            zIndex: "2147483647",
          });
          overlay.addEventListener("click", () => {
            window.name = "strict-overlay-click";
          });
          document.body.append(overlay);
        }, { once: true });

        button.addEventListener("click", () => {
          window.name = document.querySelector(
            "#strict-mousemove-overlay",
          )
            ? "strict-target-click-after-move"
            : "strict-target-click-without-move";
          location.href = "/done.html";
        });
      });

      const secondAuth =
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId: "auth-req-2",
            authorizationId: "auth-2",
            tabId,
            observedRevision:
              refreshed.revision.id,
            ref: replacementSave.ref,
            ttlMs: 5_000,
          },
        );

      expect(secondAuth).toMatchObject({
        ok: true,
        result: {
          id: "auth-2",
          origin: fixtureOrigin,
        },
      });

      const executeResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId: "browser-act-2",
            tabId,
            action: {
              actionId: "action-2",
              kind: "click",
              authorizationId: "auth-2",
              observedRevision:
                refreshed.revision.id,
              ref: replacementSave.ref,
            },
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
            actionId: "action-2",
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
      expect(
        await target.evaluate(() => window.name),
      ).toBe("strict-target-click-without-move");
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

test(
  "真实 Chromium 中 Agent-owned OOPIF child 可通过投影后的 Strict Click 完成真实 dispatch",
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
        "browser-agent-next-oopif-e2e-home-",
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
              "--site-per-process",
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

      const executeProfile = path.join(
        home,
        "profile-execute",
      );

      writeNativeHostRegistration(
        home,
        executeProfile,
        extensionId,
      );

      context =
        await chromium.launchPersistentContext(
          executeProfile,
          {
            channel: "chromium",
            headless: true,
            env,
            args: [
              "--site-per-process",
              "--disable-extensions-except=" +
                extensionPath,
              "--load-extension=" +
                extensionPath,
            ],
          },
        );

      expect(
        await extensionIdOf(context),
      ).toBe(extensionId);

      const token = await waitForTrustedHost(
        rpcPort,
        path.join(
          home,
          ".browser-agent-next/trusted-rpc.token",
        ),
      );

      const harness = await context.newPage();
      await harness.goto(
        "chrome-extension://" +
          extensionId +
          "/e2e-harness.html",
      );

      const oopifUrl =
        fixtureOrigin +
        "/oopif-delayed-child-main.html";
      const createdPage =
        context.waitForEvent("page");

      const openResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.open",
            requestId: "browser-open-oopif",
            url: oopifUrl,
            active: false,
          },
        );

      expect(openResponse).toMatchObject({
        ok: true,
        result: {
          requestedUrl: oopifUrl,
          ownedBySession: true,
        },
      });

      const target = await createdPage;

      const tabId =
        openResponse.result.tabId;

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "policy.replace-autoact-origins",
            requestId: "policy-oopif",
            origins: [fixtureOrigin],
          },
        ),
      ).toMatchObject({
        ok: true,
        result: {
          origins: [fixtureOrigin],
        },
      });

      let observation: any;

      for (
        let attempt = 0;
        attempt < 40;
        attempt += 1
      ) {
        const response =
          await trustedRequest(
            rpcPort,
            token,
            {
              type: "browser.observe",
              requestId:
                "browser-observe-oopif-" +
                attempt,
              tabId,
              options: {
                profile: "hybrid",
              },
            },
          );

        if (response.ok) {
          observation = response.result;

          const candidate =
            observation.elements.find(
              (element: any) =>
                element.semantic.name ===
                "OOPIF Child Action",
            );

          if (
            observation.coverage
              .actionable.status ===
              "complete" &&
            candidate?.provenance?.dom ===
              true &&
            candidate.provenance.ax === true
          ) {
            break;
          }
        }

        await harness.waitForTimeout(100);
      }

      if (!observation) {
        throw new Error(
          "OOPIF hybrid observation unavailable",
        );
      }

      const child =
        observation.elements.find(
          (element: any) =>
            element.semantic.name ===
            "OOPIF Child Action",
        );

      if (!child) {
        throw new Error(
          "OOPIF child ref unavailable",
        );
      }

      expect(
        observation.coverage.actionable.status,
      ).toBe("complete");
      expect(child.provenance).toMatchObject({
        dom: true,
        ax: true,
      });

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId: "auth-oopif-child",
            authorizationId:
              "auth-oopif-child",
            tabId,
            observedRevision:
              observation.revision.id,
            ref: child.ref,
            ttlMs: 5_000,
          },
        ),
      ).toMatchObject({
        ok: true,
        result: {
          id: "auth-oopif-child",
          origin: fixtureOrigin,
          assurance: "control-plane",
        },
      });

      const executeResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId:
              "browser-act-oopif-child",
            tabId,
            action: {
              actionId:
                "action-oopif-child",
              kind: "click",
              authorizationId:
                "auth-oopif-child",
              observedRevision:
                observation.revision.id,
              ref: child.ref,
            },
            verification: {
              mode: "all",
              conditions: [{
                type: "text_present",
                text: "OOPIF Clicked",
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
            actionId:
              "action-oopif-child",
          },
          verification: {
            verified: true,
            conclusive: true,
          },
        },
      });

      const oopif = target.frames().find(
        (frame) =>
          frame.url().startsWith(
            "http://localhost:4173/oopif-child.html",
          ),
      );

      if (!oopif) {
        throw new Error(
          "OOPIF child frame missing after confirmed observe and act; frame URLs: " +
            target.frames().map((frame) => frame.url()).join(", "),
        );
      }

      await expect(
        oopif.locator(
          "#oopif-child-action",
        ),
      ).toHaveText("OOPIF Clicked");

      await expect(target).toHaveURL(
        oopifUrl,
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

test(
  "授权后的 OOPIF child reload 与 detach 必须在 dispatch 前 fail closed",
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
        "browser-agent-next-oopif-stale-e2e-home-",
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
              "--site-per-process",
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

      const executeProfile =
        path.join(
          home,
          "profile-execute",
        );

      writeNativeHostRegistration(
        home,
        executeProfile,
        extensionId,
      );

      context =
        await chromium.launchPersistentContext(
          executeProfile,
          {
            channel: "chromium",
            headless: true,
            env,
            args: [
              "--site-per-process",
              "--disable-extensions-except=" +
                extensionPath,
              "--load-extension=" +
                extensionPath,
            ],
          },
        );

      expect(
        await extensionIdOf(context),
      ).toBe(extensionId);

      const token = await waitForTrustedHost(
        rpcPort,
        path.join(
          home,
          ".browser-agent-next/trusted-rpc.token",
        ),
      );

      const harness = await context.newPage();
      await harness.goto(
        "chrome-extension://" +
          extensionId +
          "/e2e-harness.html",
      );

      const oopifUrl =
        fixtureOrigin +
        "/oopif-main.html";
      const createdPage =
        context.waitForEvent("page");

      const openResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.open",
            requestId:
              "browser-open-oopif-stale",
            url: oopifUrl,
            active: false,
          },
        );

      const target = await createdPage;
      await target.waitForLoadState("load");

      const tabId =
        openResponse.result.tabId;

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "policy.replace-autoact-origins",
            requestId:
              "policy-oopif-stale",
            origins: [fixtureOrigin],
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      async function observeChild(
        expectedName:
          "OOPIF Child Action" |
          "OOPIF Clicked" =
            "OOPIF Child Action",
      ): Promise<any> {
        let last: any;

        for (
          let attempt = 0;
          attempt < 40;
          attempt += 1
        ) {
          const response =
            await trustedRequest(
              rpcPort,
              token,
              {
                type: "browser.observe",
                requestId:
                  "browser-observe-oopif-stale-" +
                  expectedName +
                  "-" +
                  attempt,
                tabId,
                options: {
                  profile: "hybrid",
                },
              },
            );

          if (response.ok) {
            last = response.result;
            const child =
              last.elements.find(
                (element: any) =>
                  element.semantic.name ===
                  expectedName,
              );

            if (
              last.coverage.actionable
                .status === "complete" &&
              child?.provenance?.dom ===
                true &&
              child.provenance.ax === true
            ) {
              return last;
            }
          }

          await harness.waitForTimeout(
            100,
          );
        }

        throw new Error(
          "OOPIF child observation did not stabilize: " +
            JSON.stringify(
              last?.coverage,
            ),
        );
      }

      const first =
        await observeChild();
      const firstChild =
        first.elements.find(
          (element: any) =>
            element.semantic.name ===
            "OOPIF Child Action",
        );

      if (!firstChild) {
        throw new Error(
          "initial OOPIF child ref unavailable",
        );
      }

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId:
              "auth-oopif-before-reload",
            authorizationId:
              "auth-oopif-before-reload",
            tabId,
            observedRevision:
              first.revision.id,
            ref: firstChild.ref,
            ttlMs: 5_000,
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      const firstOopif =
        target.frames().find(
          (frame) =>
            frame.url().startsWith(
              "http://localhost:4173/oopif-child.html",
            ),
        );

      if (!firstOopif) {
        throw new Error(
          "initial cross-site OOPIF frame missing",
        );
      }

      await firstOopif.goto(
        "http://localhost:4173/oopif-child.html?reload-before-act=1",
      );

      const afterReload =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId:
              "browser-act-stale-after-child-reload",
            tabId,
            action: {
              actionId:
                "action-stale-after-child-reload",
              kind: "click",
              authorizationId:
                "auth-oopif-before-reload",
              observedRevision:
                first.revision.id,
              ref: firstChild.ref,
            },
            verification: {
              mode: "all",
              conditions: [{
                type: "text_present",
                text: "OOPIF Clicked",
              }],
            },
            verifyTimeoutMs: 500,
          },
        );

      expect(afterReload).toMatchObject({
        ok: false,
        error: {
          code:
            "TARGET_IDENTITY_MISMATCH",
        },
      });

      const reloaded =
        await observeChild();
      const reloadedChild =
        reloaded.elements.find(
          (element: any) =>
            element.semantic.name ===
            "OOPIF Child Action",
        );

      if (!reloadedChild) {
        throw new Error(
          "reloaded OOPIF child ref unavailable",
        );
      }

      expect(reloadedChild.ref)
        .not.toBe(firstChild.ref);

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId:
              "auth-oopif-before-detach",
            authorizationId:
              "auth-oopif-before-detach",
            tabId,
            observedRevision:
              reloaded.revision.id,
            ref: reloadedChild.ref,
            ttlMs: 5_000,
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      await target.evaluate(() => {
        document
          .querySelector(
            "#oopif-child-frame",
          )
          ?.remove();
      });

      await harness.waitForTimeout(100);

      const afterDetach =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId:
              "browser-act-stale-after-child-detach",
            tabId,
            action: {
              actionId:
                "action-stale-after-child-detach",
              kind: "click",
              authorizationId:
                "auth-oopif-before-detach",
              observedRevision:
                reloaded.revision.id,
              ref: reloadedChild.ref,
            },
            verification: {
              mode: "all",
              conditions: [{
                type: "text_present",
                text: "OOPIF Clicked",
              }],
            },
            verifyTimeoutMs: 500,
          },
        );

      expect(afterDetach).toMatchObject({
        ok: false,
        error: {
          code: "DOCUMENT_CHANGED",
        },
      });

      await expect(target).toHaveURL(
        oopifUrl,
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

test(
  "真实 Chromium 中滚动后的 affine transform OOPIF 可点击，而 perspective OOPIF 在 dispatch 前 fail closed",
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
        "browser-agent-next-oopif-transform-e2e-home-",
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
              "--site-per-process",
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

      const executeProfile =
        path.join(
          home,
          "profile-execute",
        );

      writeNativeHostRegistration(
        home,
        executeProfile,
        extensionId,
      );

      context =
        await chromium.launchPersistentContext(
          executeProfile,
          {
            channel: "chromium",
            headless: true,
            env,
            args: [
              "--site-per-process",
              "--disable-extensions-except=" +
                extensionPath,
              "--load-extension=" +
                extensionPath,
            ],
          },
        );

      expect(
        await extensionIdOf(context),
      ).toBe(extensionId);

      const token =
        await waitForTrustedHost(
          rpcPort,
          path.join(
            home,
            ".browser-agent-next/trusted-rpc.token",
          ),
        );

      const harness =
        await context.newPage();
      await harness.goto(
        "chrome-extension://" +
          extensionId +
          "/e2e-harness.html",
      );

      const transformUrl =
        fixtureOrigin +
        "/oopif-transform-main.html";
      const createdPage =
        context.waitForEvent("page");

      const openResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.open",
            requestId:
              "browser-open-oopif-transform",
            url: transformUrl,
            active: false,
          },
        );

      expect(openResponse)
        .toMatchObject({
          ok: true,
          result: {
            requestedUrl:
              transformUrl,
            ownedBySession: true,
          },
        });

      const target =
        await createdPage;
      await target.waitForLoadState(
        "load",
      );

      const tabId =
        openResponse.result.tabId;

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "policy.replace-autoact-origins",
            requestId:
              "policy-oopif-transform",
            origins: [
              fixtureOrigin,
            ],
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      await target.evaluate(() => {
        document
          .querySelector(
            "#oopif-transform-frame",
          )
          ?.scrollIntoView({
            block: "center",
            inline: "center",
          });
      });

      await harness.waitForTimeout(
        100,
      );

      async function observeAction():
        Promise<any> {
        let last: any;

        for (
          let attempt = 0;
          attempt < 40;
          attempt += 1
        ) {
          const response =
            await trustedRequest(
              rpcPort,
              token,
              {
                type:
                  "browser.observe",
                requestId:
                  "browser-observe-oopif-transform-" +
                  attempt,
                tabId,
                options: {
                  profile: "hybrid",
                },
              },
            );

          if (response.ok) {
            last =
              response.result;
            const child =
              last.elements.find(
                (element: any) =>
                  element.semantic
                    .name ===
                  "Transformed OOPIF Action",
              );

            if (
              last.coverage
                .actionable.status ===
                "complete" &&
              child?.provenance?.dom ===
                true &&
              child.provenance.ax ===
                true
            ) {
              return last;
            }
          }

          await harness.waitForTimeout(
            100,
          );
        }

        throw new Error(
          "transformed OOPIF observation did not stabilize: " +
            JSON.stringify(
              last?.coverage,
            ),
        );
      }

      const affineObservation =
        await observeAction();
      const affineChild =
        affineObservation
          .elements.find(
            (element: any) =>
              element.semantic
                .name ===
              "Transformed OOPIF Action",
          );

      if (!affineChild) {
        throw new Error(
          "transformed OOPIF child ref unavailable",
        );
      }

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId:
              "auth-oopif-affine",
            authorizationId:
              "auth-oopif-affine",
            tabId,
            observedRevision:
              affineObservation
                .revision.id,
            ref: affineChild.ref,
            ttlMs: 5_000,
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      const affineAct =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId:
              "browser-act-oopif-affine",
            tabId,
            action: {
              actionId:
                "action-oopif-affine",
              kind: "click",
              authorizationId:
                "auth-oopif-affine",
              observedRevision:
                affineObservation
                  .revision.id,
              ref: affineChild.ref,
            },
            verification: {
              mode: "all",
              conditions: [{
                type:
                  "text_present",
                text:
                  "Transformed OOPIF Clicked",
              }],
            },
            verifyTimeoutMs:
              3_000,
          },
        );

      expect(affineAct)
        .toMatchObject({
          ok: true,
          result: {
            execution: {
              status:
                "executed",
            },
          },
        });

      let childFrame =
        target.frames().find(
          (frame) =>
            frame.url().startsWith(
              "http://localhost:4173/oopif-transform-child.html",
            ),
        );

      for (
        let attempt = 0;
        !childFrame && attempt < 40;
        attempt += 1
      ) {
        await target.waitForTimeout(50);
        childFrame =
          target.frames().find(
            (frame) =>
              frame.url().startsWith(
                "http://localhost:4173/oopif-transform-child.html",
              ),
          );
      }

      if (!childFrame) {
        throw new Error(
          "transformed cross-site OOPIF frame missing after bounded wait",
        );
      }

      await expect(
        childFrame.locator(
          "#oopif-transform-action",
        ),
      ).toHaveText(
        "Transformed OOPIF Clicked",
      );

      await target.evaluate(() => {
        const frame =
          document.querySelector(
            "#oopif-transform-frame",
          );
        if (
          !(frame instanceof
            HTMLIFrameElement)
        ) {
          throw new Error(
            "transform frame missing",
          );
        }

        frame.style.transform =
          "perspective(500px) rotateY(28deg)";
      });

      await childFrame.goto(
        "http://localhost:4173/oopif-transform-child.html?perspective=1",
      );
      await harness.waitForTimeout(
        100,
      );

      const perspectiveObservation =
        await observeAction();
      const perspectiveChild =
        perspectiveObservation
          .elements.find(
            (element: any) =>
              element.semantic
                .name ===
              "Transformed OOPIF Action",
          );

      if (!perspectiveChild) {
        throw new Error(
          "perspective OOPIF child ref unavailable",
        );
      }

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId:
              "auth-oopif-perspective",
            authorizationId:
              "auth-oopif-perspective",
            tabId,
            observedRevision:
              perspectiveObservation
                .revision.id,
            ref:
              perspectiveChild.ref,
            ttlMs: 5_000,
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      const perspectiveAct =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId:
              "browser-act-oopif-perspective",
            tabId,
            action: {
              actionId:
                "action-oopif-perspective",
              kind: "click",
              authorizationId:
                "auth-oopif-perspective",
              observedRevision:
                perspectiveObservation
                  .revision.id,
              ref:
                perspectiveChild.ref,
            },
            verification: {
              mode: "all",
              conditions: [{
                type:
                  "text_present",
                text:
                  "Transformed OOPIF Clicked",
              }],
            },
            verifyTimeoutMs: 500,
          },
        );

      expect(perspectiveAct)
        .toMatchObject({
          ok: false,
          error: {
            code:
              "TARGET_IDENTITY_MISMATCH",
          },
        });

      await expect(
        childFrame.locator(
          "#oopif-transform-action",
        ),
      ).toHaveText(
        "Transformed OOPIF Action",
      );

      await expect(target)
        .toHaveURL(transformUrl);
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

test(
  "真实 Chromium nested OOPIF 在中间 owner 被遮挡时 fail closed，解除遮挡后可完成 Strict Click",
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
        "browser-agent-next-nested-oopif-e2e-home-",
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
              "--site-per-process",
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

      const executeProfile =
        path.join(
          home,
          "profile-execute",
        );

      writeNativeHostRegistration(
        home,
        executeProfile,
        extensionId,
      );

      context =
        await chromium.launchPersistentContext(
          executeProfile,
          {
            channel: "chromium",
            headless: true,
            env,
            args: [
              "--site-per-process",
              "--disable-extensions-except=" +
                extensionPath,
              "--load-extension=" +
                extensionPath,
            ],
          },
        );

      expect(
        await extensionIdOf(context),
      ).toBe(extensionId);

      const token =
        await waitForTrustedHost(
          rpcPort,
          path.join(
            home,
            ".browser-agent-next/trusted-rpc.token",
          ),
        );

      const harness =
        await context.newPage();
      await harness.goto(
        "chrome-extension://" +
          extensionId +
          "/e2e-harness.html",
      );

      const nestedUrl =
        fixtureOrigin +
        "/oopif-nested-main.html";
      const createdPage =
        context.waitForEvent("page");

      const openResponse =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.open",
            requestId:
              "browser-open-nested-oopif",
            url: nestedUrl,
            active: false,
          },
        );

      expect(openResponse)
        .toMatchObject({
          ok: true,
          result: {
            requestedUrl:
              nestedUrl,
            ownedBySession: true,
          },
        });

      const target =
        await createdPage;
      await target.waitForLoadState(
        "load",
      );

      const tabId =
        openResponse.result.tabId;

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "policy.replace-autoact-origins",
            requestId:
              "policy-nested-oopif",
            origins: [
              fixtureOrigin,
            ],
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      async function observeNested():
        Promise<any> {
        let last: any;

        for (
          let attempt = 0;
          attempt < 50;
          attempt += 1
        ) {
          const response =
            await trustedRequest(
              rpcPort,
              token,
              {
                type:
                  "browser.observe",
                requestId:
                  "browser-observe-nested-oopif-" +
                  attempt,
                tabId,
                options: {
                  profile: "hybrid",
                },
              },
            );

          if (response.ok) {
            last =
              response.result;
            const child =
              last.elements.find(
                (element: any) =>
                  element.semantic
                    .name ===
                  "Nested OOPIF Action",
              );

            if (
              last.coverage
                .actionable.status ===
                "complete" &&
              child?.provenance?.dom ===
                true &&
              child.provenance.ax ===
                true
            ) {
              return last;
            }
          }

          await harness.waitForTimeout(
            100,
          );
        }

        throw new Error(
          "nested OOPIF observation did not stabilize: " +
            JSON.stringify(
              last?.coverage,
            ),
        );
      }

      const first =
        await observeNested();
      const firstChild =
        first.elements.find(
          (element: any) =>
            element.semantic.name ===
            "Nested OOPIF Action",
        );

      if (!firstChild) {
        throw new Error(
          "nested OOPIF child ref unavailable",
        );
      }

      let parentFrame =
        target.frames().find(
          (frame) =>
            frame.url().startsWith(
              "http://localhost:4173/oopif-nested-parent.html",
            ),
        );
      let nestedChildFrame =
        target.frames().find(
          (frame) =>
            frame.url().startsWith(
              "http://127.0.0.1:4173/oopif-nested-child.html",
            ),
        );

      for (
        let attempt = 0;
        (
          !parentFrame ||
          !nestedChildFrame
        ) &&
        attempt < 40;
        attempt += 1
      ) {
        await target.waitForTimeout(50);
        parentFrame =
          target.frames().find(
            (frame) =>
              frame.url().startsWith(
                "http://localhost:4173/oopif-nested-parent.html",
              ),
          );
        nestedChildFrame =
          target.frames().find(
            (frame) =>
              frame.url().startsWith(
                "http://127.0.0.1:4173/oopif-nested-child.html",
              ),
          );
      }

      if (
        !parentFrame ||
        !nestedChildFrame
      ) {
        throw new Error(
          "nested OOPIF frame chain missing after bounded wait",
        );
      }

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId:
              "auth-nested-before-overlay",
            authorizationId:
              "auth-nested-before-overlay",
            tabId,
            observedRevision:
              first.revision.id,
            ref: firstChild.ref,
            ttlMs: 5_000,
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      await parentFrame.evaluate(() => {
        const frame =
          document.querySelector(
            "#oopif-nested-child-frame",
          );
        if (
          !(frame instanceof
            HTMLIFrameElement)
        ) {
          throw new Error(
            "nested child frame missing",
          );
        }

        const rect =
          frame.getBoundingClientRect();
        const overlay =
          document.createElement(
            "div",
          );
        overlay.id =
          "nested-frame-overlay";
        overlay.style.position =
          "fixed";
        overlay.style.left =
          rect.left + "px";
        overlay.style.top =
          rect.top + "px";
        overlay.style.width =
          rect.width + "px";
        overlay.style.height =
          rect.height + "px";
        overlay.style.zIndex =
          "999999";
        overlay.style.pointerEvents =
          "auto";
        overlay.style.background =
          "rgba(255,0,0,0.2)";
        document.body.append(
          overlay,
        );
      });

      const blocked =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId:
              "browser-act-nested-overlay",
            tabId,
            action: {
              actionId:
                "action-nested-overlay",
              kind: "click",
              authorizationId:
                "auth-nested-before-overlay",
              observedRevision:
                first.revision.id,
              ref: firstChild.ref,
            },
            verification: {
              mode: "all",
              conditions: [{
                type:
                  "text_present",
                text:
                  "Nested OOPIF Clicked",
              }],
            },
            verifyTimeoutMs: 500,
          },
        );

      expect(blocked)
        .toMatchObject({
          ok: false,
          error: {
            code:
              "TARGET_IDENTITY_MISMATCH",
          },
        });

      await expect(
        nestedChildFrame.locator(
          "#oopif-nested-action",
        ),
      ).toHaveText(
        "Nested OOPIF Action",
      );

      await parentFrame.evaluate(() => {
        document
          .querySelector(
            "#nested-frame-overlay",
          )
          ?.remove();
      });

      const second =
        await observeNested();
      const secondChild =
        second.elements.find(
          (element: any) =>
            element.semantic.name ===
            "Nested OOPIF Action",
        );

      if (!secondChild) {
        throw new Error(
          "nested OOPIF ref after overlay removal unavailable",
        );
      }

      expect(
        await trustedRequest(
          rpcPort,
          token,
          {
            type:
              "authorization.issue-strict-click",
            requestId:
              "auth-nested-after-overlay",
            authorizationId:
              "auth-nested-after-overlay",
            tabId,
            observedRevision:
              second.revision.id,
            ref: secondChild.ref,
            ttlMs: 5_000,
          },
        ),
      ).toMatchObject({
        ok: true,
      });

      const executed =
        await trustedRequest(
          rpcPort,
          token,
          {
            type: "browser.act",
            requestId:
              "browser-act-nested-after-overlay",
            tabId,
            action: {
              actionId:
                "action-nested-after-overlay",
              kind: "click",
              authorizationId:
                "auth-nested-after-overlay",
              observedRevision:
                second.revision.id,
              ref: secondChild.ref,
            },
            verification: {
              mode: "all",
              conditions: [{
                type:
                  "text_present",
                text:
                  "Nested OOPIF Clicked",
              }],
            },
            verifyTimeoutMs:
              3_000,
          },
        );

      expect(executed)
        .toMatchObject({
          ok: true,
          result: {
            execution: {
              status:
                "executed",
            },
            verification: {
              verified: true,
              conclusive: true,
            },
          },
        });

      await expect(
        nestedChildFrame.locator(
          "#oopif-nested-action",
        ),
      ).toHaveText(
        "Nested OOPIF Clicked",
      );

      await expect(target)
        .toHaveURL(nestedUrl);
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

interface TrustedHostBrowser {
  context: BrowserContext;
  token: string;
  rpcPort: number;
  close(): Promise<void>;
}

// 与上面各用例相同的启动流程：先用 discovery profile 取得 extension id，
// 再注册 native host 并用 execute profile 启动。`beforeHostStart` 在
// native host 被拉起之前执行（此时 HOME 已就绪、浏览器尚未连接 host）。
async function startTrustedHostBrowser(
  home: string,
  beforeHostStart?: () => void,
): Promise<TrustedHostBrowser> {
  const extensionPath = path.resolve("apps/extension/dist");
  const rpcPort = await freePort();
  const env = browserEnv(home, rpcPort);
  const launchArgs = [
    "--disable-extensions-except=" + extensionPath,
    "--load-extension=" + extensionPath,
  ];

  const discovery = await chromium.launchPersistentContext(
    path.join(home, "profile-discovery"),
    {
      channel: "chromium",
      headless: true,
      env,
      args: launchArgs,
    },
  );

  let extensionId: string;
  try {
    extensionId = await extensionIdOf(discovery);
  } finally {
    await discovery.close();
  }

  const executeProfile = path.join(home, "profile-execute");
  writeNativeHostRegistration(home, executeProfile, extensionId);
  beforeHostStart?.();

  const context = await chromium.launchPersistentContext(
    executeProfile,
    {
      channel: "chromium",
      headless: true,
      env,
      args: launchArgs,
    },
  );

  try {
    expect(await extensionIdOf(context)).toBe(extensionId);

    const token = await waitForTrustedHost(
      rpcPort,
      path.join(home, ".browser-agent-next/trusted-rpc.token"),
    );

    return {
      context,
      token,
      rpcPort,
      close: () => context.close(),
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function openAndObserveSave(
  host: TrustedHostBrowser,
  suffix: string,
): Promise<{
  page: Page;
  tabId: number;
  revision: string;
  saveRef: string;
}> {
  const createdPage = host.context.waitForEvent("page");
  const open = await trustedRequest(host.rpcPort, host.token, {
    type: "browser.open",
    requestId: "browser-open-" + suffix,
    url: mainUrl,
    active: false,
  });
  expect(open).toMatchObject({
    ok: true,
    result: { ownedBySession: true },
  });

  const page = await createdPage;
  await page.waitForLoadState("load");

  const tabId: number = open.result.tabId;
  const observed = await trustedRequest(host.rpcPort, host.token, {
    type: "browser.observe",
    requestId: "browser-observe-" + suffix,
    tabId,
    options: { profile: "hybrid" },
  });
  expect(observed, JSON.stringify(observed)).toMatchObject({
    ok: true,
  });

  const save = observed.result.elements.find(
    (element: { semantic: { name?: string } }) =>
      element.semantic.name === "Save",
  );
  if (!save) throw new Error("Save ref unavailable");

  return {
    page,
    tabId,
    revision: observed.result.revision.id,
    saveRef: save.ref,
  };
}

test(
  "native host 启动时从 autoact-origins.json 下发 allowlist；缺失配置时 fail closed",
  async () => {
    test.skip(
      process.platform === "win32",
      "Windows Native Messaging 注册表安装将在独立安装器阶段覆盖",
    );

    const homes: string[] = [];
    const hosts: TrustedHostBrowser[] = [];

    try {
      // 对照组：不写配置文件，allowlist 为空，签发必须被拒绝。
      const controlHome = mkdtempSync(
        path.join(tmpdir(), "browser-agent-next-e2e-home-"),
      );
      homes.push(controlHome);

      const control = await startTrustedHostBrowser(controlHome);
      hosts.push(control);

      const controlTarget = await openAndObserveSave(
        control,
        "control",
      );
      const controlAuth = await trustedRequest(
        control.rpcPort,
        control.token,
        {
          type: "authorization.issue-strict-click",
          requestId: "auth-control",
          authorizationId: "auth-control",
          tabId: controlTarget.tabId,
          observedRevision: controlTarget.revision,
          ref: controlTarget.saveRef,
          ttlMs: 5_000,
        },
      );

      expect(controlAuth).toMatchObject({
        ok: false,
        error: { code: "ORIGIN_NOT_ALLOWED" },
      });

      await control.close();
      hosts.splice(hosts.indexOf(control), 1);

      // 实验组：host 启动前写入配置文件，不通过 RPC 调用 replace。
      const home = mkdtempSync(
        path.join(tmpdir(), "browser-agent-next-e2e-home-"),
      );
      homes.push(home);

      const host = await startTrustedHostBrowser(home, () => {
        const stateDir = path.join(home, ".browser-agent-next");
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        chmodSync(stateDir, 0o700);

        const file = path.join(stateDir, "autoact-origins.json");
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            origins: [fixtureOrigin],
          }) + "\n",
          { mode: 0o600 },
        );
        chmodSync(file, 0o600);
      });
      hosts.push(host);

      const target = await openAndObserveSave(host, "configured");
      const page = target.page;

      // 观察之后注册页面侧导航，点击后跳到 done.html 供 Verify 使用。
      await page.evaluate(() => {
        document
          .querySelector("#main-action")
          ?.addEventListener("click", () => {
            location.href = "/done.html";
          });
      });

      const auth = await trustedRequest(host.rpcPort, host.token, {
        type: "authorization.issue-strict-click",
        requestId: "auth-configured",
        authorizationId: "auth-configured",
        tabId: target.tabId,
        observedRevision: target.revision,
        ref: target.saveRef,
        ttlMs: 5_000,
      });

      expect(auth).toMatchObject({
        ok: true,
        result: {
          id: "auth-configured",
          origin: fixtureOrigin,
        },
      });

      const act = await trustedRequest(host.rpcPort, host.token, {
        type: "browser.act",
        requestId: "browser-act-configured",
        tabId: target.tabId,
        action: {
          actionId: "action-configured",
          kind: "click",
          authorizationId: "auth-configured",
          observedRevision: target.revision,
          ref: target.saveRef,
        },
        verification: {
          mode: "all",
          conditions: [
            {
              type: "url_matches",
              pattern: fixtureOrigin + "/done.html",
            },
          ],
        },
        verifyTimeoutMs: 3_000,
      });

      expect(act).toMatchObject({
        ok: true,
        result: {
          execution: {
            status: "executed",
            actionId: "action-configured",
          },
          verification: {
            verified: true,
            conclusive: true,
          },
        },
      });

      await expect(page).toHaveURL(fixtureOrigin + "/done.html");
    } finally {
      for (const host of hosts) {
        await host.close().catch(() => undefined);
      }

      for (const home of homes) {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);
