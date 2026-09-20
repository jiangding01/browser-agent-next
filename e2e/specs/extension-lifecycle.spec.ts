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
    provenance?: {
      ax?: boolean;
      dom?: boolean;
      adapter?: string;
    };
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
  options?: {
    includeAx?: boolean;
    maxAxElements?: number;
    includeOpenShadowRoots?: boolean;
  },
): Promise<Observation> {
  let lastError = "unknown";

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await harness.evaluate(
      async ({ tabId, sinceRevision, requestId, options }) => {
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
          ...(sinceRevision !== undefined ? { sinceRevision } : {}),
          ...(options !== undefined ? { options } : {}),
        });
      },
      {
        tabId,
        sinceRevision,
        requestId: "e2e-" + attempt + "-" + Date.now(),
        options,
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


type StrictPrepareResponse =
  | {
      ok: true;
      prepared: {
        ref: string;
        point: { x: number; y: number };
      };
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

async function prepareStrictClick(
  harness: Page,
  tabId: number,
  observedRevision: string,
  ref: string,
): Promise<StrictPrepareResponse> {
  return harness.evaluate(
    async ({ tabId, observedRevision, ref, requestId }) => {
      const chromeApi = (globalThis as unknown as {
        chrome: {
          runtime: {
            sendMessage(message: unknown): Promise<unknown>;
          };
        };
      }).chrome;

      return chromeApi.runtime.sendMessage({
        type: "execution.prepare-strict-click",
        requestId,
        tabId,
        actionId: "e2e-strict-click",
        observedRevision,
        ref,
      });
    },
    {
      tabId,
      observedRevision,
      ref,
      requestId: "strict-" + Date.now(),
    },
  ) as Promise<StrictPrepareResponse>;
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

test("真实 Chromium 中排除 open Shadow Root 不会 tombstone 仍存活的 ref", async () => {
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
    await target.evaluate(() => {
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.textContent = "Shadow Save";
      shadow.appendChild(button);
      document.body.appendChild(host);
    });

    const harness = await context.newPage();
    await harness.goto(
      "chrome-extension://" + extensionId + "/e2e-harness.html",
    );

    const tabId = await targetTabId(harness);
    const first = await observe(harness, tabId);
    const shadowRef = refByName(first, "Shadow Save");

    const withoutOpenRoots = await observe(
      harness,
      tabId,
      first.revision.id,
      { includeOpenShadowRoots: false },
    );

    expect(
      withoutOpenRoots.elements.some((element) => element.ref === shadowRef),
    ).toBe(false);

    const restored = await observe(
      harness,
      tabId,
      withoutOpenRoots.revision.id,
      { includeOpenShadowRoots: true },
    );

    expect(refByName(restored, "Shadow Save")).toBe(shadowRef);
  } finally {
    await context.close();
  }
});


test("真实 Chromium 中 DOM↔AX exact correspondence 合并为单一 Persistent Ref", async () => {
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
    await harness.goto(
      "chrome-extension://" + extensionId + "/e2e-harness.html",
    );

    const tabId = await targetTabId(harness);

    const domOnly = await observe(harness, tabId);
    const domOnlySave = domOnly.elements.filter(
      (element) => element.semantic.name === "Save",
    );

    expect(domOnlySave).toHaveLength(1);
    expect(domOnlySave[0]?.provenance).toMatchObject({
      dom: true,
    });

    const hybrid = await observe(
      harness,
      tabId,
      domOnly.revision.id,
      { includeAx: true },
    );

    const hybridSave = hybrid.elements.filter(
      (element) => element.semantic.name === "Save",
    );

    expect(hybridSave).toHaveLength(1);
    expect(hybridSave[0]?.ref).toBe(domOnlySave[0]?.ref);
    expect(hybridSave[0]?.provenance).toMatchObject({
      dom: true,
      ax: true,
    });

    const hybridChild = hybrid.elements.filter(
      (element) => element.semantic.name === "Child Action",
    );

    expect(hybridChild).toHaveLength(1);
    expect(hybridChild[0]?.provenance).toMatchObject({
      dom: true,
      ax: true,
    });
    expect(hybrid.coverage.actionable.status).toBe("complete");

    const firstHybridRef = hybridSave[0]!.ref;
    const firstHybridChildRef = hybridChild[0]!.ref;

    const child = target.frames().find((frame) =>
      frame.url().includes("/child.html"),
    );
    if (!child) throw new Error("child frame missing");

    await child.goto(fixtureOrigin + "/child.html?hybrid-reload=1");

    const childReloaded = await observe(
      harness,
      tabId,
      hybrid.revision.id,
      { includeAx: true },
    );

    const childAfterReload = childReloaded.elements.filter(
      (element) => element.semantic.name === "Child Action",
    );
    expect(childAfterReload).toHaveLength(1);
    expect(childAfterReload[0]?.provenance).toMatchObject({
      dom: true,
      ax: true,
    });
    expect(childAfterReload[0]?.ref).not.toBe(firstHybridChildRef);

    const saveAfterChildReload = childReloaded.elements.filter(
      (element) => element.semantic.name === "Save",
    );
    expect(saveAfterChildReload).toHaveLength(1);
    expect(saveAfterChildReload[0]?.ref).toBe(firstHybridRef);

    const childStrict = await prepareStrictClick(
      harness,
      tabId,
      childReloaded.revision.id,
      childAfterReload[0]!.ref,
    );
    expect(childStrict).toMatchObject({
      ok: false,
      error: {
        code: "TARGET_IDENTITY_MISMATCH",
      },
    });

    await target.evaluate(() => {
      const current = document.querySelector("#main-action");
      if (!current) throw new Error("main action missing");
      current.replaceWith(current.cloneNode(true));
    });

    const replaced = await observe(
      harness,
      tabId,
      hybrid.revision.id,
      { includeAx: true },
    );

    const replacedSave = replaced.elements.filter(
      (element) => element.semantic.name === "Save",
    );

    expect(replacedSave).toHaveLength(1);
    expect(replacedSave[0]?.provenance).toMatchObject({
      dom: true,
      ax: true,
    });
    expect(replacedSave[0]?.ref).not.toBe(firstHybridRef);
  } finally {
    await context.close();
  }
});


test("真实 Chromium OOPIF 使用 flat child session 完成 Hybrid exact mapping", async () => {
  const extensionPath = path.resolve("apps/extension/dist");

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      "--site-per-process",
      "--disable-extensions-except=" + extensionPath,
      "--load-extension=" + extensionPath,
    ],
  });

  try {
    const extensionId = await extensionIdOf(context);

    const target = await context.newPage();
    await target.goto(fixtureOrigin + "/oopif-main.html");
    await target.waitForLoadState("load");

    const oopif = target.frames().find(
      (frame) =>
        frame.url().startsWith(
          "http://localhost:4173/oopif-child.html",
        ),
    );
    if (!oopif) {
      throw new Error("cross-site OOPIF frame missing");
    }

    const harness = await context.newPage();
    await harness.goto(
      "chrome-extension://" + extensionId + "/e2e-harness.html",
    );

    const tabId = await targetTabId(harness);

    let hybrid: Observation | undefined;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const observed = await observe(
        harness,
        tabId,
        hybrid?.revision.id,
        { includeAx: true },
      );

      const child = observed.elements.find(
        (element) =>
          element.semantic.name === "OOPIF Child Action",
      );

      hybrid = observed;

      if (
        observed.coverage.actionable.status === "complete" &&
        child?.provenance?.dom === true &&
        child.provenance.ax === true
      ) {
        break;
      }

      await harness.waitForTimeout(100);
    }

    if (!hybrid) {
      throw new Error("OOPIF hybrid observation unavailable");
    }

    expect(hybrid.coverage.actionable.status).toBe("complete");

    const main = hybrid.elements.filter(
      (element) => element.semantic.name === "OOPIF Main",
    );
    const child = hybrid.elements.filter(
      (element) =>
        element.semantic.name === "OOPIF Child Action",
    );

    expect(main).toHaveLength(1);
    expect(main[0]?.provenance).toMatchObject({
      dom: true,
      ax: true,
    });
    expect(child).toHaveLength(1);
    expect(child[0]?.provenance).toMatchObject({
      dom: true,
      ax: true,
    });

    const mainRef = main[0]!.ref;
    const childRef = child[0]!.ref;

    await oopif.goto(
      "http://localhost:4173/oopif-child.html?reload=1",
    );

    let reloaded: Observation | undefined;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const observed = await observe(
        harness,
        tabId,
        reloaded?.revision.id ?? hybrid.revision.id,
        { includeAx: true },
      );
      const nextChild = observed.elements.find(
        (element) =>
          element.semantic.name === "OOPIF Child Action",
      );

      reloaded = observed;

      if (
        observed.coverage.actionable.status === "complete" &&
        nextChild?.provenance?.dom === true &&
        nextChild.provenance.ax === true &&
        nextChild.ref !== childRef
      ) {
        break;
      }

      await harness.waitForTimeout(100);
    }

    if (!reloaded) {
      throw new Error("reloaded OOPIF observation unavailable");
    }

    expect(refByName(reloaded, "OOPIF Main")).toBe(mainRef);
    expect(refByName(reloaded, "OOPIF Child Action")).not.toBe(
      childRef,
    );
  } finally {
    await context.close();
  }
});


test("真实 Chromium Strict Prepare 对语义漂移、遮挡和同名替换 fail closed", async () => {
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
    await harness.goto(
      "chrome-extension://" + extensionId + "/e2e-harness.html",
    );

    const tabId = await targetTabId(harness);
    const observation = await observe(
      harness,
      tabId,
      undefined,
      { includeAx: true },
    );

    const saveRef = refByName(observation, "Save");

    const valid = await prepareStrictClick(
      harness,
      tabId,
      observation.revision.id,
      saveRef,
    );

    expect(valid).toMatchObject({
      ok: true,
      prepared: {
        ref: saveRef,
      },
    });

    if (valid.ok) {
      expect(Number.isFinite(valid.prepared.point.x)).toBe(true);
      expect(Number.isFinite(valid.prepared.point.y)).toBe(true);
    }

    await target.evaluate(() => {
      const button = document.querySelector("#main-action");
      if (!button) throw new Error("main action missing");
      button.textContent = "Delete";
    });

    const semanticChanged = await prepareStrictClick(
      harness,
      tabId,
      observation.revision.id,
      saveRef,
    );

    expect(semanticChanged).toMatchObject({
      ok: false,
      error: {
        code: "TARGET_SEMANTIC_CHANGED",
      },
    });

    await target.evaluate(() => {
      const button = document.querySelector("#main-action");
      if (!button) throw new Error("main action missing");
      button.textContent = "Save";

      const rect = button.getBoundingClientRect();
      const overlay = document.createElement("div");
      overlay.id = "strict-overlay";
      Object.assign(overlay.style, {
        position: "fixed",
        left: rect.left + "px",
        top: rect.top + "px",
        width: rect.width + "px",
        height: rect.height + "px",
        zIndex: "2147483647",
        background: "rgba(0,0,0,0.01)",
      });
      document.body.appendChild(overlay);
    });

    const occluded = await prepareStrictClick(
      harness,
      tabId,
      observation.revision.id,
      saveRef,
    );

    expect(occluded).toMatchObject({
      ok: false,
      error: {
        code: "TARGET_OCCLUDED",
      },
    });

    await target.evaluate(() => {
      document.querySelector("#strict-overlay")?.remove();
      const current = document.querySelector("#main-action");
      if (!current) throw new Error("main action missing");
      current.replaceWith(current.cloneNode(true));
    });

    const replaced = await prepareStrictClick(
      harness,
      tabId,
      observation.revision.id,
      saveRef,
    );

    expect(replaced).toMatchObject({
      ok: false,
      error: {
        code: "TARGET_IDENTITY_MISMATCH",
      },
    });
  } finally {
    await context.close();
  }
});
