import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import net from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Frame,
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

/**
 * 通过 iframe owner 元素解析 OOPIF 的 Playwright Frame。
 *
 * Runtime 用 chrome.tabs.create 打开的 Tab 不是 Playwright 创建的；CI 上
 * Playwright 为其中 OOPIF 建立的 Frame 对象可能长期保持 url() === ""，
 * 因此不能按 frame.url() 查找。content frame 由 owner 元素的 frameId 解析，
 * 只用于 Strict Click / Verify 之后的最终 DOM 断言或测试自身的页面操作。
 */
async function oopifContentFrame(
  owner: Page | Frame,
  selector: string,
): Promise<Frame> {
  const handle = await owner
    .locator(selector)
    .elementHandle();

  try {
    for (
      let attempt = 0;
      attempt < 50;
      attempt += 1
    ) {
      const frame =
        await handle.contentFrame();
      if (frame) return frame;

      await new Promise((resolve) =>
        setTimeout(resolve, 100)
      );
    }
  } finally {
    await handle.dispose();
  }

  throw new Error(
    "OOPIF content frame unavailable for " +
      selector,
  );
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
            // OOPIF dispatch 前的 presentation fence 在后台 Tab 中可能等待秒级。
            ttlMs: 15_000,
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

      const oopif =
        await oopifContentFrame(
          target,
          "#oopif-child-frame",
        );

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
        await oopifContentFrame(
          target,
          "#oopif-child-frame",
        );

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
            // OOPIF dispatch 前的 presentation fence 在后台 Tab 中可能等待秒级。
            ttlMs: 15_000,
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

      // 后台 Tab 的 root renderer 在 Linux CI 上约 1 fps；scroll 后若未等待
      // presentation，真实输入会被浏览器路由到 root frame 的 iframe owner。
      // 这里要求 Runtime 自己的 Verify 证明点击确实送达 child。
      expect(affineAct)
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

      const childFrame =
        await oopifContentFrame(
          target,
          "#oopif-transform-frame",
        );

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

      // Readiness 已由 hybrid Observe 证明；Playwright 对这些 OOPIF 的
      // frame.url() 可能长期为空，因此测试自身的页面操作只通过 owner
      // iframe 元素组成的 frameLocator 链定位，不按 URL 查找 Frame。
      const parentFrame =
        target.frameLocator(
          "#oopif-nested-parent-frame",
        );
      const nestedChildFrame =
        parentFrame.frameLocator(
          "#oopif-nested-child-frame",
        );

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

      await parentFrame
        .locator(
          "#oopif-nested-child-frame",
        )
        .evaluate((frame) => {
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

      await parentFrame
        .locator(
          "#nested-frame-overlay",
        )
        .evaluate((overlay) => {
          overlay.remove();
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
            // OOPIF dispatch 前的 presentation fence 在后台 Tab 中可能等待秒级。
            ttlMs: 15_000,
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
        writeAutoActOrigins(home);
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

function writeAutoActOrigins(home: string): void {
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
}

test(
  "审批角标随 pending 增减；审批页倒计时、标注不可信文本、自动刷新且不重排",
  async () => {
    test.skip(
      process.platform === "win32",
      "Windows Native Messaging 注册表安装将在独立安装器阶段覆盖",
    );

    const home = mkdtempSync(
      path.join(tmpdir(), "browser-agent-next-e2e-home-"),
    );
    let host: TrustedHostBrowser | undefined;

    try {
      host = await startTrustedHostBrowser(home, () => {
        writeAutoActOrigins(home);
      });
      const active = host;
      const extensionId = await extensionIdOf(active.context);
      const worker = active.context.serviceWorkers()[0];
      if (!worker) throw new Error("extension service worker unavailable");

      const badgeText = () =>
        worker.evaluate(() =>
          (globalThis as unknown as {
            chrome: {
              action: { getBadgeText(details: object): Promise<string> };
            };
          }).chrome.action.getBadgeText({})
        );

      await expect.poll(badgeText).toBe("");

      const target = await openAndObserveSave(active, "approval-ux");

      async function requestApproval(authorizationId: string) {
        const response = await trustedRequest(
          active.rpcPort,
          active.token,
          {
            type: "authorization.request-operator-approval",
            requestId: "request-" + authorizationId,
            authorizationId,
            tabId: target.tabId,
            observedRevision: target.revision,
            ref: target.saveRef,
            ttlMs: 5_000,
            approvalTtlMs: 60_000,
          },
        );
        expect(response, JSON.stringify(response)).toMatchObject({
          ok: true,
        });
        return response.result.approvalRequestId as string;
      }

      const approvalA = await requestApproval("auth-ux-a");
      await expect.poll(badgeText).toBe("1");

      const popup = await active.context.newPage();
      await popup.goto(
        "chrome-extension://" + extensionId + "/operator-approval.html",
      );
      await popup.bringToFront();

      const cardA = popup.locator(
        `[data-approval-id="${approvalA}"]`,
      );
      await expect(popup.locator(".approval-card")).toHaveCount(1);
      await expect(cardA.locator(".origin-value")).toHaveText(fixtureOrigin);
      await expect(cardA.locator(".untrusted-label")).toContainText("不可信");
      await expect(cardA.locator(".untrusted-text").first())
        .toContainText("「Save」");
      await expect(cardA.locator(".code"))
        .toHaveText("#" + approvalA.slice(-6));
      await expect(cardA.locator(".countdown")).toHaveText(/^剩余 /);

      const cardANode = await cardA.elementHandle();
      if (!cardANode) throw new Error("approval card unavailable");

      // 第二个请求由自动刷新追加到末尾。
      const approvalB = await requestApproval("auth-ux-b");
      await expect.poll(badgeText).toBe("2");
      await expect(popup.locator(".approval-card")).toHaveCount(2, {
        timeout: 10_000,
      });
      await expect(popup.locator(".approval-card").last())
        .toHaveAttribute("data-approval-id", approvalB);

      // 取消 B：卡片先原位标记失效，下一轮刷新才移除；A 的节点保持不变。
      const cancel = await trustedRequest(active.rpcPort, active.token, {
        type: "authorization.cancel-strict-click",
        requestId: "cancel-auth-ux-b",
        authorizationId: "auth-ux-b",
      });
      expect(cancel).toMatchObject({
        ok: true,
        result: { authorizationId: "auth-ux-b" },
      });
      await expect.poll(badgeText).toBe("1");

      const cardB = popup.locator(
        `[data-approval-id="${approvalB}"]`,
      );
      // stale 只持续一个刷新周期；按钮禁用与 stale 在同一次渲染内完成，由单测覆盖。
      await expect(cardB).toHaveClass(/stale/, { timeout: 10_000 });
      await expect(cardB).toHaveCount(0, { timeout: 10_000 });
      expect(
        await popup.evaluate(
          ([node, id]) =>
            node === document.querySelector(`[data-approval-id="${id}"]`),
          [cardANode, approvalA] as const,
        ),
      ).toBe(true);

      // operator 在审批页批准 A。
      await cardA.getByRole("button", { name: "批准一次" }).click();
      await expect(popup.locator("#status"))
        .toHaveText("已批准 #" + approvalA.slice(-6));
      await expect.poll(badgeText).toBe("");

      const status = await trustedRequest(active.rpcPort, active.token, {
        type: "authorization.operator-approval-status",
        requestId: "status-auth-ux-a",
        approvalRequestId: approvalA,
      });
      expect(status).toMatchObject({
        ok: true,
        result: { state: "approved" },
      });

      await expect(popup.locator("#empty-state")).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await host?.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  },
);

type JsonRpcMessage = Record<string, unknown>;

interface McpProcessClient {
  request(
    method: string,
    params: Record<string, unknown>,
  ): { id: number; response: Promise<JsonRpcMessage> };
  notify(method: string, params: Record<string, unknown>): void;
  notifications: JsonRpcMessage[];
  /** 结束子进程，返回 stdout 上出现过的非 JSON 行。 */
  close(): Promise<string[]>;
}

const mcpCliPath = path.resolve("apps/mcp-server/dist/cli.js");

// 以真实子进程运行构建产物，经 stdin / stdout 走 MCP JSON-RPC。
function startMcpProcess(env: Record<string, string>): McpProcessClient {
  if (!existsSync(mcpCliPath)) {
    throw new Error(
      "apps/mcp-server/dist/cli.js 不存在，请先运行 pnpm build",
    );
  }

  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [mcpCliPath],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map<
    number,
    (message: JsonRpcMessage | undefined) => void
  >();
  const notifications: JsonRpcMessage[] = [];
  const stderr: string[] = [];
  const protocolErrors: string[] = [];
  let nextId = 1;

  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // stdout 只属于 MCP wire，任何非 JSON 行都是协议污染。
      protocolErrors.push(line.slice(0, 200));
      return;
    }

    if (typeof message.id === "number" && pending.has(message.id)) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    notifications.push(message);
  });

  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      // 进程退出时一次性拒绝所有未完成请求，避免每个请求各挂一个 exit listener。
      for (const [id, settle] of pending) {
        pending.delete(id);
        settle(undefined);
      }
      resolve();
    });
  });

  function send(message: JsonRpcMessage): void {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  return {
    request(method, params) {
      const id = nextId++;
      const response = new Promise<JsonRpcMessage>((resolve, reject) => {
        pending.set(id, (message) => {
          if (message) {
            resolve(message);
            return;
          }
          reject(
            new Error(
              "MCP process exited (" + exitCode + "): " +
                stderr.join("").slice(0, 1_000),
            ),
          );
        });
      });
      send({ id, method, params });
      return { id, response };
    },
    notify(method, params) {
      send({ method, params });
    },
    notifications,
    async close() {
      child.stdin.end();
      child.kill();
      // SIGTERM 后 5 秒仍未退出就强制结束，避免把失败拖成用例超时。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const forced = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
      });
      await Promise.race([exited, forced]);
      clearTimeout(timer);
      await exited;
      return [...protocolErrors];
    },
  };
}

function toolPayload(message: JsonRpcMessage): {
  isError: boolean;
  value: Record<string, unknown>;
} {
  const result = message.result as {
    isError?: boolean;
    content?: Array<{ type: string; text: string }>;
  };
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("unexpected tool result: " + JSON.stringify(message));
  }
  return {
    isError: result.isError === true,
    value: JSON.parse(text) as Record<string, unknown>,
  };
}

test(
  "模型经 MCP 子进程 stdio 发起 browser.act：operator 在审批页批准后真实点击；客户端取消则不点击",
  async () => {
    test.skip(
      process.platform === "win32",
      "Windows Native Messaging 注册表安装将在独立安装器阶段覆盖",
    );
    test.setTimeout(90_000);

    const home = mkdtempSync(
      path.join(tmpdir(), "browser-agent-next-e2e-home-"),
    );
    let host: TrustedHostBrowser | undefined;
    let mcp: McpProcessClient | undefined;

    try {
      host = await startTrustedHostBrowser(home, () => {
        writeAutoActOrigins(home);
      });
      const active = host;
      const extensionId = await extensionIdOf(active.context);
      const worker = active.context.serviceWorkers()[0];
      if (!worker) throw new Error("extension service worker unavailable");
      const badgeText = () =>
        worker.evaluate(() =>
          (globalThis as unknown as {
            chrome: {
              action: { getBadgeText(details: object): Promise<string> };
            };
          }).chrome.action.getBadgeText({})
        );

      // 不继承开发机上的 BROWSER_AGENT_NEXT_*，子进程配置只由下面显式给出。
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (
          value !== undefined &&
          !key.startsWith("BROWSER_AGENT_NEXT_")
        ) {
          env[key] = value;
        }
      }
      Object.assign(env, {
        HOME: home,
        BROWSER_AGENT_NEXT_RPC_PORT: String(active.rpcPort),
        BROWSER_AGENT_NEXT_RPC_TOKEN_PATH: path.join(
          home,
          ".browser-agent-next/trusted-rpc.token",
        ),
        BROWSER_AGENT_NEXT_MODEL_READ_ORIGINS: fixtureOrigin,
        BROWSER_AGENT_NEXT_MODEL_NAVIGATION_ORIGINS: fixtureOrigin,
        BROWSER_AGENT_NEXT_MODEL_ACT_ORIGINS: fixtureOrigin,
        BROWSER_AGENT_NEXT_MODEL_TOOLS:
          "browser.open,browser.observe,browser.act,browser.verify",
        BROWSER_AGENT_NEXT_MODEL_ACT_APPROVAL: "operator",
        BROWSER_AGENT_NEXT_MODEL_APPROVAL_TIMEOUT_MS: "30000",
      });

      mcp = startMcpProcess(env);
      const client = mcp;

      const initialized = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "browser-agent-next-e2e", version: "0.0.0" },
      }).response;
      expect(initialized.result).toBeTruthy();
      client.notify("notifications/initialized", {});

      const listed = await client.request("tools/list", {}).response;
      const toolNames = (
        (listed.result as { tools: Array<{ name: string }> }).tools
      ).map((tool) => tool.name);
      expect(toolNames).toContain("browser.act");

      async function callTool(
        name: string,
        args: Record<string, unknown>,
      ) {
        const { response } = client.request("tools/call", {
          name,
          arguments: args,
        });
        const payload = toolPayload(await response);
        expect(payload.isError, JSON.stringify(payload.value)).toBe(false);
        return payload.value;
      }

      async function openAndObserve(suffix: string) {
        const createdPage = active.context.waitForEvent("page");
        const opened = await callTool("browser.open", {
          url: mainUrl,
          active: false,
        });
        const page = await createdPage;
        await page.waitForLoadState("load");
        // 点击 Save 后跳转到 done.html，作为真实副作用的证据。
        await page.evaluate((marker) => {
          document
            .querySelector("#main-action")
            ?.addEventListener("click", () => {
              document.body.dataset.clicked = marker;
              location.href = "/done.html";
            });
        }, suffix);

        const tabId = opened.tabId as number;
        const observed = await callTool("browser.observe", { tabId });
        const elements = observed.elements as Array<{
          ref: string;
          semantic: { name?: string };
        }>;
        const save = elements.find(
          (element) => element.semantic.name === "Save",
        );
        if (!save) throw new Error("Save ref unavailable");

        return {
          page,
          tabId,
          revision: (observed.revision as { id: string }).id,
          ref: save.ref,
        };
      }

      const popup = await active.context.newPage();
      await popup.goto(
        "chrome-extension://" + extensionId + "/operator-approval.html",
      );

      // 1. 批准路径：progress → 审批页批准 → 真实点击 → 本地 Verify 通过。
      const approved = await openAndObserve("approved");
      await popup.bringToFront();
      const approveCall = client.request("tools/call", {
        name: "browser.act",
        arguments: {
          tabId: approved.tabId,
          observedRevision: approved.revision,
          ref: approved.ref,
          kind: "click",
          verification: {
            mode: "all",
            conditions: [
              {
                type: "url_matches",
                pattern: fixtureOrigin + "/done.html",
              },
            ],
          },
          verifyTimeoutMs: 5_000,
        },
        _meta: { progressToken: "act-approved" },
      });

      const pendingCard = popup.locator(".approval-card:not(.stale)");
      await expect(pendingCard).toHaveCount(1, { timeout: 15_000 });
      await expect.poll(badgeText).toBe("1");
      await expect.poll(
        () =>
          client.notifications.filter(
            (message) =>
              message.method === "notifications/progress" &&
              (message.params as { progressToken?: unknown })
                .progressToken === "act-approved",
          ).length,
        { timeout: 10_000 },
      ).toBeGreaterThan(0);

      await pendingCard
        .getByRole("button", { name: "批准一次" })
        .click();

      const actResult = toolPayload(await approveCall.response);
      expect(actResult.isError, JSON.stringify(actResult.value)).toBe(false);
      expect(actResult.value).toMatchObject({
        status: "executed",
        effectClass: "unknown",
        verification: { verified: true },
      });
      await expect(approved.page).toHaveURL(fixtureOrigin + "/done.html");
      await expect.poll(badgeText).toBe("");

      // 2. 客户端取消：审批未决时取消 tools/call，不得发生点击。
      const cancelled = await openAndObserve("cancelled");
      await popup.bringToFront();
      const cancelCall = client.request("tools/call", {
        name: "browser.act",
        arguments: {
          tabId: cancelled.tabId,
          observedRevision: cancelled.revision,
          ref: cancelled.ref,
          kind: "click",
          verification: {
            mode: "all",
            conditions: [
              {
                type: "url_matches",
                pattern: fixtureOrigin + "/done.html",
              },
            ],
          },
        },
      });
      // 被取消的请求可能不会收到响应，避免未处理的 rejection。
      void cancelCall.response.catch(() => undefined);

      await expect(pendingCard).toHaveCount(1, { timeout: 15_000 });
      await expect.poll(badgeText).toBe("1");

      client.notify("notifications/cancelled", {
        requestId: cancelCall.id,
        reason: "e2e client cancel",
      });

      await expect.poll(badgeText, { timeout: 10_000 }).toBe("");
      await expect(pendingCard).toHaveCount(0, { timeout: 10_000 });
      await expect(cancelled.page).toHaveURL(mainUrl);
      expect(
        await cancelled.page.evaluate(() => document.body.dataset.clicked),
      ).toBeUndefined();

      const protocolErrors = await client.close();
      mcp = undefined;
      expect(protocolErrors, "MCP stdout 出现非 JSON 行").toEqual([]);
    } finally {
      await mcp?.close().catch(() => undefined);
      await host?.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "Strict setValue：isolated world 单 task 写入、参数绑定、敏感字段与焦点竞态 fail closed、审批页显示完整值",
  async () => {
    test.skip(
      process.platform === "win32",
      "Windows Native Messaging 注册表安装将在独立安装器阶段覆盖",
    );
    // Playwright 对接管的页面开启焦点模拟（document.hasFocus() 恒为 true），
    // 因此本用例证明的是扩展 isolated world 中的写入链路，不能证明真实后台标签页的焦点行为。

    const home = mkdtempSync(
      path.join(tmpdir(), "browser-agent-next-e2e-home-"),
    );
    let host: TrustedHostBrowser | undefined;

    try {
      host = await startTrustedHostBrowser(home, () => {
        writeAutoActOrigins(home);
      });
      const active = host;

      const createdPage = active.context.waitForEvent("page");
      const open = await trustedRequest(active.rpcPort, active.token, {
        type: "browser.open",
        requestId: "open-strict-write",
        url: fixtureOrigin + "/strict-write.html",
        active: false,
      });
      expect(open, JSON.stringify(open)).toMatchObject({ ok: true });
      const page = await createdPage;
      await page.waitForLoadState("load");
      const tabId: number = open.result.tabId;

      let sequence = 0;
      async function observe(): Promise<{
        revision: string;
        refOf(name: string): string;
      }> {
        sequence += 1;
        const observed = await trustedRequest(active.rpcPort, active.token, {
          type: "browser.observe",
          requestId: "observe-strict-write-" + sequence,
          tabId,
          options: {
            profile: "hybrid",
            includeOpenShadowRoots: true,
            maxElements: 200,
            maxAxElements: 200,
          },
        });
        expect(observed, JSON.stringify(observed)).toMatchObject({ ok: true });
        const elements: Array<{ ref: string; semantic: { name?: string } }> =
          observed.result.elements;
        return {
          revision: observed.result.revision.id,
          refOf(name: string) {
            const found = elements.filter((element) => element.semantic.name === name);
            if (found.length !== 1) {
              throw new Error("expected exactly one element named " + name + ", got " + found.length);
            }
            return found[0]!.ref;
          },
        };
      }

      const verification = (ref: string) => ({
        mode: "all",
        conditions: [{ type: "ref_exists", ref }],
      });

      async function issue(name: string, value: string, suffix: string) {
        const { revision, refOf } = await observe();
        const ref = refOf(name);
        const response = await trustedRequest(active.rpcPort, active.token, {
          type: "authorization.issue-strict-action",
          requestId: "issue-" + suffix,
          authorizationId: "auth-" + suffix,
          tabId,
          observedRevision: revision,
          ref,
          ttlMs: 30_000,
          action: { kind: "setValue", value },
        });
        return { response, revision, ref };
      }

      async function write(
        name: string,
        value: string,
        suffix: string,
        grantValue = value,
      ) {
        const issued = await issue(name, grantValue, suffix);
        expect(issued.response, JSON.stringify(issued.response)).toMatchObject({ ok: true });
        return trustedRequest(active.rpcPort, active.token, {
          type: "execution.execute-strict-action",
          requestId: "execute-" + suffix,
          actionId: "act-" + suffix,
          authorizationId: "auth-" + suffix,
          tabId,
          observedRevision: issued.revision,
          ref: issued.ref,
          action: { kind: "setValue", value },
          verification: verification(issued.ref),
          verifyTimeoutMs: 0,
        });
      }

      const valueOf = (selector: string) => page.locator(selector).inputValue();

      // 1. 普通文本框：覆盖原值，页面收到可信的 insertText 输入事件。
      const name = await write("Full name", "张三 Zhang", "name");
      expect(name, JSON.stringify(name)).toMatchObject({
        ok: true,
        result: { execution: { status: "executed", valueMatched: true } },
      });
      expect(JSON.stringify(name)).not.toContain("张三");
      expect(await valueOf("#name")).toBe("张三 Zhang");
      const log = await page.evaluate(
        () => (window as unknown as { inputLog: unknown[] }).inputLog,
      );
      expect(log).toContainEqual({ id: "name", trusted: true, inputType: "insertText" });

      // 2. textarea、email、清空非空字段、已为空字段写空值。
      for (const [label, selector, value, suffix] of [
        ["Notes", "#notes", "single line note", "notes"],
        ["Email", "#email", "someone@example.test", "email"],
        ["Clear me", "#clearme", "", "clear"],
        ["Already empty", "#empty", "", "empty"],
      ] as const) {
        const result = await write(label, value, suffix);
        expect(result, label + " " + JSON.stringify(result)).toMatchObject({
          ok: true,
          result: { execution: { valueMatched: true } },
        });
        expect(await valueOf(selector)).toBe(value);
      }

      // 3. open shadow root 与同进程 child frame 中的输入框。
      const shadowResult = await write("Shadow field", "inside shadow", "shadow");
      expect(shadowResult, JSON.stringify(shadowResult)).toMatchObject({
        ok: true,
        result: { execution: { valueMatched: true } },
      });
      expect(await valueOf("#shadow-input")).toBe("inside shadow");
      // 命中测试在 shadow root 上进行，但覆盖在其上的光照 DOM 遮罩仍判为遮挡。
      await page.evaluate(() => {
        const rect = document.querySelector("#shadow-host")!.getBoundingClientRect();
        const veil = document.createElement("div");
        veil.id = "shadow-veil";
        Object.assign(veil.style, {
          position: "fixed",
          left: rect.left + "px",
          top: rect.top + "px",
          width: rect.width + "px",
          height: rect.height + "px",
          background: "white",
        });
        document.body.appendChild(veil);
      });
      expect(await write("Shadow field", "veiled", "shadow-veiled")).toMatchObject({
        ok: false,
        error: { code: "TARGET_OCCLUDED" },
      });
      expect(await valueOf("#shadow-input")).toBe("inside shadow");
      await page.evaluate(() => document.querySelector("#shadow-veil")!.remove());

      // 同一 shadow root 内的遮罩同样判为遮挡，字段从未获得焦点。
      expect(await write("Shadow covered", "nope", "shadow-covered")).toMatchObject({
        ok: false,
        error: { code: "TARGET_OCCLUDED" },
      });
      expect(
        await page.evaluate(() =>
          (document.querySelector("#shadow-host")!.shadowRoot!
            .getElementById("shadow-covered") as HTMLInputElement).value,
        ),
      ).toBe("");

      // 命中测试修正同样让 Strict click 能作用于 open shadow root 内的按钮。
      const shadowClick = await observe();
      const shadowButtonRef = shadowClick.refOf("Shadow button");
      expect(
        await trustedRequest(active.rpcPort, active.token, {
          type: "authorization.issue-strict-action",
          requestId: "issue-shadow-click",
          authorizationId: "auth-shadow-click",
          tabId,
          observedRevision: shadowClick.revision,
          ref: shadowButtonRef,
          ttlMs: 30_000,
          action: { kind: "click" },
        }),
      ).toMatchObject({ ok: true });
      const clicked = await trustedRequest(active.rpcPort, active.token, {
        type: "execution.execute-strict-action",
        requestId: "execute-shadow-click",
        actionId: "act-shadow-click",
        authorizationId: "auth-shadow-click",
        tabId,
        observedRevision: shadowClick.revision,
        ref: shadowButtonRef,
        action: { kind: "click" },
        verification: verification(shadowButtonRef),
        verifyTimeoutMs: 0,
      });
      expect(clicked, JSON.stringify(clicked)).toMatchObject({ ok: true });
      expect(
        await page.evaluate(() => (window as unknown as { shadowClicks: number }).shadowClicks),
      ).toBe(1);
      expect(await write("Child field", "inside child", "child")).toMatchObject({
        ok: true,
        result: { execution: { valueMatched: true } },
      });
      expect(
        await page.frameLocator("#child-frame").locator("#child-input").inputValue(),
      ).toBe("inside child");

      // 4. maxlength：写入成功但 valueMatched 如实为 false。
      expect(await write("Code", "abcdef", "limited")).toMatchObject({
        ok: true,
        result: { execution: { valueMatched: false } },
      });
      expect(await valueOf("#limited")).toBe("abc");

      // 5. focus 回调把焦点移到另一个输入框：两个字段都保持为空，结果为 outcome unknown。
      expect(await write("Focus thief", "stolen?", "victim")).toMatchObject({
        ok: false,
        error: { code: "ACTION_OUTCOME_UNKNOWN", outcomeMayHaveChanged: true },
      });
      expect(await valueOf("#victim")).toBe("");
      expect(await valueOf("#thief")).toBe("");

      // 6. focus 回调把字段改成 password：不写入，outcome unknown。
      expect(await write("Flips to password", "secret", "flip")).toMatchObject({
        ok: false,
        error: { code: "ACTION_OUTCOME_UNKNOWN" },
      });
      expect(await valueOf("#flip")).toBe("");

      // 7. 签发阶段就拒绝：password、只读、number。
      for (const [label, code] of [
        ["Password", "POLICY_BLOCKED"],
        ["One-time code", "POLICY_BLOCKED"],
        ["Masked", "POLICY_BLOCKED"],
        ["Read only", "ACTION_NOT_SUPPORTED"],
        ["Age", "ACTION_NOT_SUPPORTED"],
      ] as const) {
        const issued = await issue(label, "x", "refuse-" + label.replace(/\s/g, ""));
        expect(issued.response, label).toMatchObject({ ok: false, error: { code } });
      }
      expect(await valueOf("#password")).toBe("");
      expect(await valueOf("#readonly")).toBe("fixed");
      const focused = () =>
        page.evaluate(() => (window as unknown as { focusLog: string[] }).focusLog);
      // 对照：确实写入过的字段出现在 focusLog 中，证明该断言不是空转。
      expect(await focused()).toContain("name");
      for (const id of ["password", "otp", "masked", "readonly", "age"]) {
        expect(await focused(), id).not.toContain(id);
      }

      // focus 回调给字段加上 -webkit-text-security：同一 task 内复核拒绝，outcome unknown。
      expect(await write("Masks on focus", "secret", "masks")).toMatchObject({
        ok: false,
        error: { code: "ACTION_OUTCOME_UNKNOWN" },
      });
      expect(await valueOf("#masks")).toBe("");

      // 8. 被遮罩覆盖：prepare 阶段拒绝，不写入。
      expect(await write("Covered", "hidden", "covered")).toMatchObject({
        ok: false,
        error: { code: "TARGET_OCCLUDED" },
      });
      expect(await valueOf("#covered")).toBe("");
      expect(await focused()).not.toContain("covered");

      // 9. 用“A”的 grant 执行“B”：授权不匹配，不写入。
      expect(await write("Full name", "B", "mismatch", "A")).toMatchObject({
        ok: false,
        error: { code: "AUTHORIZATION_REQUIRED" },
      });
      expect(await valueOf("#name")).toBe("张三 Zhang");

      // 10. 旧 click 消息携带 action：协议层拒绝，不会被当成 click 执行。
      const legacy = await observe();
      const legacyResponse = await trustedRequest(active.rpcPort, active.token, {
        type: "authorization.issue-strict-click",
        requestId: "legacy-with-action",
        authorizationId: "auth-legacy",
        tabId,
        observedRevision: legacy.revision,
        ref: legacy.refOf("Full name"),
        ttlMs: 30_000,
        action: { kind: "setValue", value: "legacy" },
      });
      expect(legacyResponse).toMatchObject({
        ok: false,
        error: { code: "INVALID_TRUSTED_HOST_REQUEST" },
      });

      // 11. operator 审批页显示“待批准的填写”与完整值，页内批准后执行。
      const approvalTarget = await observe();
      const notesRef = approvalTarget.refOf("Notes");
      const approvalValue = "  approved  text ";
      const requested = await trustedRequest(active.rpcPort, active.token, {
        type: "authorization.request-strict-action-approval",
        requestId: "approval-request",
        authorizationId: "auth-approval",
        tabId,
        observedRevision: approvalTarget.revision,
        ref: notesRef,
        ttlMs: 30_000,
        approvalTtlMs: 60_000,
        action: { kind: "setValue", value: approvalValue },
      });
      expect(requested, JSON.stringify(requested)).toMatchObject({ ok: true });
      const approvalId: string = requested.result.approvalRequestId;

      const extensionId = await extensionIdOf(active.context);
      const popup = await active.context.newPage();
      await popup.goto("chrome-extension://" + extensionId + "/operator-approval.html");
      await popup.bringToFront();
      const card = popup.locator(`[data-approval-id="${approvalId}"]`);
      await expect(card.locator("h2")).toHaveText("待批准的填写");
      await expect(card.locator(".write-value-text")).toHaveText(approvalValue, {
        useInnerText: false,
      });
      await expect(card.locator(".write-value-caption")).toHaveText(
        "共 17 个字符；开头有空格；结尾有空格；含连续空格",
      );
      await expect(card.locator("button.primary")).toBeEnabled({ timeout: 5_000 });
      await card.locator("button.primary").click();

      await expect.poll(async () => {
        const status = await trustedRequest(active.rpcPort, active.token, {
          type: "authorization.operator-approval-status",
          requestId: "approval-status-" + Date.now(),
          approvalRequestId: approvalId,
        });
        return status.result?.state;
      }).toBe("approved");

      const approvedExecution = await trustedRequest(active.rpcPort, active.token, {
        type: "execution.execute-strict-action",
        requestId: "approval-execute",
        actionId: "act-approval",
        authorizationId: "auth-approval",
        tabId,
        observedRevision: approvalTarget.revision,
        ref: notesRef,
        action: { kind: "setValue", value: approvalValue },
        verification: verification(notesRef),
        verifyTimeoutMs: 0,
      });
      expect(approvedExecution, JSON.stringify(approvedExecution)).toMatchObject({
        ok: true,
        result: { execution: { valueMatched: true } },
      });
      expect(await valueOf("#notes")).toBe(approvalValue);
    } finally {
      await host?.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
