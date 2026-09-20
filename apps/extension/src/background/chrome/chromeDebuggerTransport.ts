export interface ChromeDebuggerTarget {
  tabId?: number;
  sessionId?: string;
}

export interface ChromeDebuggerEventApi {
  addListener(
    listener: (
      source: ChromeDebuggerTarget,
      method: string,
      params?: unknown,
    ) => void,
  ): void;
}

export interface ChromeDebuggerApi {
  attach(target: ChromeDebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggerTarget): Promise<void>;
  sendCommand(
    target: ChromeDebuggerTarget,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>;
  onEvent?: ChromeDebuggerEventApi;
  onDetach: {
    addListener(
      listener: (
        source: ChromeDebuggerTarget,
        reason: string,
      ) => void,
    ): void;
  };
}

export interface RuntimeExecutionContext {
  id: number;
  origin?: string;
  name?: string;
  auxData?: {
    frameId?: string;
    isDefault?: boolean;
    type?: string;
  };
}

export interface RuntimeExecutionContextBinding {
  context: RuntimeExecutionContext;
  sessionId?: string;
}

export interface ChromeDebuggerChildSession {
  sessionId: string;
  targetId: string;
  targetType: string;
  parentSessionId?: string;
}

interface TargetAttachedToTargetParams {
  sessionId?: unknown;
  targetInfo?: {
    targetId?: unknown;
    type?: unknown;
  };
}

interface TargetDetachedFromTargetParams {
  sessionId?: unknown;
}

const ROOT_SESSION_KEY = "root";

function sessionKey(sessionId: string | undefined): string {
  return sessionId ?? ROOT_SESSION_KEY;
}

function childSessionKey(tabId: number, sessionId: string): string {
  return tabId + ":" + sessionId;
}

function boundedSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512
  );
}

function boundedTargetField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512
  );
}

export class ChromeDebuggerReadTransport {
  private readonly attached = new Set<number>();
  private readonly flatAutoAttachTabs = new Set<number>();
  private readonly contextsByTab = new Map<
    number,
    Map<string, Map<number, RuntimeExecutionContext>>
  >();
  private readonly childSessionsByTab = new Map<
    number,
    Map<string, ChromeDebuggerChildSession>
  >();
  private readonly childInitialization = new Map<
    string,
    Promise<void>
  >();

  constructor(private readonly debuggerApi: ChromeDebuggerApi) {
    this.debuggerApi.onEvent?.addListener((source, method, params) => {
      const tabId = source.tabId;
      if (
        tabId === undefined ||
        !this.attached.has(tabId)
      ) {
        return;
      }

      if (method === "Target.attachedToTarget") {
        this.recordAttachedChildSession(tabId, source.sessionId, params);
        return;
      }

      if (method === "Target.detachedFromTarget") {
        this.recordDetachedChildSession(tabId, params);
        return;
      }

      if (
        source.sessionId !== undefined &&
        !this.childSessionsByTab
          .get(tabId)
          ?.has(source.sessionId)
      ) {
        return;
      }

      if (method === "Runtime.executionContextsCleared") {
        this.contextsByTab
          .get(tabId)
          ?.delete(sessionKey(source.sessionId));
        return;
      }

      if (method === "Runtime.executionContextDestroyed") {
        const id = (
          params as { executionContextId?: unknown } | undefined
        )?.executionContextId;

        if (typeof id === "number") {
          this.contextsByTab
            .get(tabId)
            ?.get(sessionKey(source.sessionId))
            ?.delete(id);
        }
        return;
      }

      if (method !== "Runtime.executionContextCreated") return;

      const context = (
        params as { context?: RuntimeExecutionContext } | undefined
      )?.context;

      if (!context || typeof context.id !== "number") return;

      this.contextMap(tabId, source.sessionId)
        .set(context.id, context);
    });

    this.debuggerApi.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.clearTabSessionState(source.tabId);
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;

    try {
      await this.debuggerApi.attach({ tabId }, "1.3");
    } catch (error) {
      throw new Error(friendlyAttachError(error));
    }

    this.attached.add(tabId);

    await this.safeSend(tabId, "DOM.enable");
    await this.safeSend(tabId, "Accessibility.enable");
    await this.safeSend(tabId, "Page.enable");
    await this.safeSend(tabId, "Runtime.enable");

    // Chrome 125+ browser.debugger supports flat child protocol sessions.
    // Older/unsupported environments remain usable for root-session features;
    // OOPIF mapping simply stays unavailable and therefore fail-closed.
    try {
      await this.debuggerApi.sendCommand(
        { tabId },
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }],
        },
      );
      this.flatAutoAttachTabs.add(tabId);
    } catch {
      this.flatAutoAttachTabs.delete(tabId);
    }
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    await this.debuggerApi.detach({ tabId });
    this.clearTabSessionState(tabId);
  }

  async send<T>(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.attach(tabId);
    return this.debuggerApi.sendCommand(
      { tabId },
      method,
      params,
    ) as Promise<T>;
  }

  async sendInSession<T>(
    tabId: number,
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.attach(tabId);

    if (!this.childSessionsByTab.get(tabId)?.has(sessionId)) {
      throw new Error(
        "Chrome debugger child session is not attached: " +
          sessionId.slice(0, 128),
      );
    }

    return this.debuggerApi.sendCommand(
      { tabId, sessionId },
      method,
      params,
    ) as Promise<T>;
  }

  contextsForFrame(
    tabId: number,
    cdpFrameId: string,
  ): RuntimeExecutionContext[] {
    return [
      ...(
        this.contextsByTab
          .get(tabId)
          ?.get(ROOT_SESSION_KEY)
          ?.values() ?? []
      ),
    ].filter(
      (context) => context.auxData?.frameId === cdpFrameId,
    );
  }

  contextBindingsForFrame(
    tabId: number,
    cdpFrameId: string,
  ): RuntimeExecutionContextBinding[] {
    const sessions = this.contextsByTab.get(tabId);
    if (!sessions) return [];

    const bindings: RuntimeExecutionContextBinding[] = [];
    const childSessions =
      this.childSessionsByTab.get(tabId);

    for (const [key, contexts] of sessions) {
      if (
        key !== ROOT_SESSION_KEY &&
        !childSessions?.has(key)
      ) {
        continue;
      }

      for (const context of contexts.values()) {
        if (context.auxData?.frameId !== cdpFrameId) continue;

        bindings.push({
          context,
          ...(key !== ROOT_SESSION_KEY
            ? { sessionId: key }
            : {}),
        });
      }
    }

    return bindings;
  }

  childSessions(tabId: number): ChromeDebuggerChildSession[] {
    return [
      ...(this.childSessionsByTab.get(tabId)?.values() ?? []),
    ].map((session) => ({ ...session }));
  }

  flatAutoAttachEnabled(tabId: number): boolean {
    return this.flatAutoAttachTabs.has(tabId);
  }

  async waitForChildSessionInitialization(
    tabId: number,
  ): Promise<void> {
    // Nested OOPIF auto-attach is recursive only after each child session has
    // received its own Target.setAutoAttach. Loop over a bounded number of
    // waves so sessions attached while awaiting a parent are also initialized.
    for (let wave = 0; wave < 8; wave += 1) {
      const pending = [...this.childInitialization.entries()]
        .filter(([key]) => key.startsWith(tabId + ":"))
        .map(([, promise]) => promise);

      if (pending.length === 0) return;
      await Promise.all(pending);

      const remaining = [...this.childInitialization.keys()]
        .some((key) => key.startsWith(tabId + ":"));

      if (!remaining) return;
    }
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  private contextMap(
    tabId: number,
    sessionId?: string,
  ): Map<number, RuntimeExecutionContext> {
    let bySession = this.contextsByTab.get(tabId);
    if (!bySession) {
      bySession = new Map();
      this.contextsByTab.set(tabId, bySession);
    }

    const key = sessionKey(sessionId);
    let contexts = bySession.get(key);
    if (!contexts) {
      contexts = new Map();
      bySession.set(key, contexts);
    }

    return contexts;
  }

  private recordAttachedChildSession(
    tabId: number,
    parentSessionId: string | undefined,
    params: unknown,
  ): void {
    const candidate = params as TargetAttachedToTargetParams | undefined;
    const sessionId = candidate?.sessionId;
    const targetId = candidate?.targetInfo?.targetId;
    const targetType = candidate?.targetInfo?.type;

    if (
      !boundedSessionId(sessionId) ||
      !boundedTargetField(targetId) ||
      targetType !== "iframe" ||
      (
        parentSessionId !== undefined &&
        !boundedSessionId(parentSessionId)
      )
    ) {
      return;
    }

    let sessions =
      this.childSessionsByTab.get(tabId);

    if (
      parentSessionId !== undefined &&
      !sessions?.has(parentSessionId)
    ) {
      return;
    }

    if (!sessions) {
      sessions = new Map();
      this.childSessionsByTab.set(tabId, sessions);
    }

    sessions.set(sessionId, {
      sessionId,
      targetId,
      targetType,
      ...(parentSessionId !== undefined
        ? { parentSessionId }
        : {}),
    });

    const key = childSessionKey(tabId, sessionId);
    if (this.childInitialization.has(key)) return;

    const initialization = this.initializeChildSession(
      tabId,
      sessionId,
    ).finally(() => {
      this.childInitialization.delete(key);
    });

    this.childInitialization.set(key, initialization);
  }

  private recordDetachedChildSession(
    tabId: number,
    params: unknown,
  ): void {
    const sessionId = (
      params as TargetDetachedFromTargetParams | undefined
    )?.sessionId;

    if (!boundedSessionId(sessionId)) return;

    this.removeChildSessionTree(tabId, sessionId);
  }

  private removeChildSessionTree(
    tabId: number,
    sessionId: string,
  ): void {
    const sessions = this.childSessionsByTab.get(tabId);
    if (!sessions) return;

    const children = [...sessions.values()]
      .filter((session) => session.parentSessionId === sessionId)
      .map((session) => session.sessionId);

    for (const childId of children) {
      this.removeChildSessionTree(tabId, childId);
    }

    sessions.delete(sessionId);
    this.contextsByTab.get(tabId)?.delete(sessionId);
    this.childInitialization.delete(
      childSessionKey(tabId, sessionId),
    );

    if (sessions.size === 0) {
      this.childSessionsByTab.delete(tabId);
    }
  }

  private async initializeChildSession(
    tabId: number,
    sessionId: string,
  ): Promise<void> {
    await this.safeSendInSession(tabId, sessionId, "DOM.enable");
    await this.safeSendInSession(
      tabId,
      sessionId,
      "Accessibility.enable",
    );
    await this.safeSendInSession(tabId, sessionId, "Page.enable");
    await this.safeSendInSession(tabId, sessionId, "Runtime.enable");

    // Auto-attach is not recursive in CDP. Configure every iframe target so a
    // nested OOPIF can attach as its child session as well.
    await this.safeSendInSession(
      tabId,
      sessionId,
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }],
      },
    );
  }

  private async safeSend(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.debuggerApi.sendCommand({ tabId }, method, params);
    } catch {
      // Restricted pages / unsupported domains must not leave a half-created
      // in-memory session. The actual read will surface a concrete error.
    }
  }

  private async safeSendInSession(
    tabId: number,
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.debuggerApi.sendCommand(
        { tabId, sessionId },
        method,
        params,
      );
    } catch {
      // Child-session capability is optional until exact OOPIF mapping uses it.
      // Failure leaves that child session observable but unusable, so later
      // mapping will fail closed rather than falling back to root commands.
    }
  }

  private clearTabSessionState(tabId: number): void {
    this.attached.delete(tabId);
    this.flatAutoAttachTabs.delete(tabId);
    this.contextsByTab.delete(tabId);
    this.childSessionsByTab.delete(tabId);

    for (const key of this.childInitialization.keys()) {
      if (key.startsWith(tabId + ":")) {
        this.childInitialization.delete(key);
      }
    }
  }
}

function friendlyAttachError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (
    /another debugger|debugger is already attached|cannot attach|target closed|devtools/i.test(
      message,
    )
  ) {
    return (
      "Chrome debugger attach 失败：" +
      message +
      "。请关闭目标 Tab 上的 DevTools 或其他 debugger 后重试。"
    );
  }

  if (/Cannot access a chrome:\/\//i.test(message)) {
    return (
      "Chrome debugger attach 失败：" +
      message +
      "。受限制的 chrome:// 页面不属于自动化目标。"
    );
  }

  return "Chrome debugger attach 失败：" + message;
}
