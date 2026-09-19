import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

const fixtureOrigin = "http://127.0.0.1:4173";
const mainUrl = fixtureOrigin + "/main.html";

type Observation = {
  revision: { id: string; documentEpoch: string };
  coverage: { actionable: { status: string } };
  elements: Array<{
    ref: string;
    semantic: { name?: string; role: string };
  }>;
};

async function extensionIdOf(context: BrowserContext): Promise<string> {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const id = worker.url().split("/")[2];
  if (!id) throw new Error("extension id unavailable");
  return id;
}

async function targetTabId(harness: Page): Promise<number> {
  return harness.evaluate(async (prefix) => {
    const chromeApi = (globalThis as unknown as {
      chrome: {
        tabs: {
          query(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
        };
      };
    }).chrome;

    const tabs = await chromeApi.tabs.query({});
    const target = tabs.find((tab) => tab.url?.startsWith(prefix));

    if (typeof target?.id !== "number") {
      throw new Error("fixture tab id unavailable");
    }

    return target.id;
  }, fixtureOrigin);
}

async function observe(
  harness: Page,
  tabId: number,
  sinceRevision?: string,
): Promise<Observation> {
  let lastError = "unknown";

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await harness.evaluate(
      async ({ tabId, sinceRevision, requestId }) => {
        const chromeApi = (globalThis as unknown as {
          chrome: {
            runtime: {
              sendMessage(message: unknown): Promise<unknown>;
            };
          };
        }).chrome;

        return chromeApi.runtime.sendMessage({
          type: "perception.observe-tab",
          requestId,
          tabId,
          ownedBySession: true,
          ...(sinceRevision !== undefined ? { sinceRevision } : {}),
        });
      },
      {
        tabId,
        sinceRevision,
        requestId: "e2e-" + attempt + "-" + Date.now(),
      },
    ) as {
      ok?: boolean;
      observation?: Observation;
      error?: { message?: string };
    } | undefined;

    if (response?.ok && response.observation) {
      return response.observation;
    }

    lastError = response?.error?.message ?? "no response";
    await harness.waitForTimeout(50);
  }

  throw new Error("observation never became available: " + lastError);
}

function refByName(observation: Observation, name: string): string {
  const element = observation.elements.find(
    (candidate) => candidate.semantic.name === name,
  );

  if (!element) {
    throw new Error(
      "element not found: " + name + "; got " +
        observation.elements.map((candidate) => candidate.semantic.name).join(", "),
    );
  }

  return element.ref;
}

test("真实 Chromium 中 Persistent Ref 遵守同节点、替换节点和导航生命周期", async () => {
  const extensionPath = path.resolve("apps/extension/dist");

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      "--disable-extensions-except=" + extensionPath,
      "--load-extension=" + extensionPath,
    ],
  });

  try {
    const extensionId = await extensionIdOf(context);

    const target = await context.newPage();
    await target.goto(mainUrl);
    await target.waitForLoadState("load");

    const harness = await context.newPage();
    await harness.goto("chrome-extension://" + extensionId + "/e2e-harness.html");

    const tabId = await targetTabId(harness);

    const first = await observe(harness, tabId);
    expect(first.coverage.actionable.status).toBe("complete");

    const firstMain = refByName(first, "Save");
    const firstChild = refByName(first, "Child Action");

    const same = await observe(harness, tabId, first.revision.id);
    expect(refByName(same, "Save")).toBe(firstMain);
    expect(refByName(same, "Child Action")).toBe(firstChild);

    await target.evaluate(() => {
      const current = document.querySelector("#main-action");
      if (!current) throw new Error("main action missing");
      current.replaceWith(current.cloneNode(true));
    });

    const replaced = await observe(harness, tabId, same.revision.id);
    const replacedMain = refByName(replaced, "Save");

    expect(replacedMain).not.toBe(firstMain);
    expect(refByName(replaced, "Child Action")).toBe(firstChild);

    const child = target.frames().find((frame) =>
      frame.url().includes("/child.html"),
    );
    if (!child) throw new Error("child frame missing");

    await child.goto(fixtureOrigin + "/child.html?reload=1");

    const childReloaded = await observe(
      harness,
      tabId,
      replaced.revision.id,
    );

    expect(refByName(childReloaded, "Save")).toBe(replacedMain);
    const reloadedChild = refByName(childReloaded, "Child Action");
    expect(reloadedChild).not.toBe(firstChild);

    const previousDocumentEpoch = childReloaded.revision.documentEpoch;

    await target.reload();
    await target.waitForLoadState("load");

    const mainReloaded = await observe(
      harness,
      tabId,
      childReloaded.revision.id,
    );

    expect(mainReloaded.revision.documentEpoch).not.toBe(
      previousDocumentEpoch,
    );
    expect(refByName(mainReloaded, "Save")).not.toBe(replacedMain);
    expect(refByName(mainReloaded, "Child Action")).not.toBe(reloadedChild);
  } finally {
    await context.close();
  }
});
