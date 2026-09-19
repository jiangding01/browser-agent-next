export interface ChromeDebuggerTarget {
  tabId?: number;
}

export interface ChromeDebuggerApi {
  attach(target: ChromeDebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggerTarget): Promise<void>;
  sendCommand(
    target: ChromeDebuggerTarget,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>;
  onDetach: {
    addListener(
      listener: (
        source: ChromeDebuggerTarget,
        reason: string,
      ) => void,
    ): void;
  };
}

export class ChromeDebuggerReadTransport {
  private readonly attached = new Set<number>();

  constructor(private readonly debuggerApi: ChromeDebuggerApi) {
    this.debuggerApi.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
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

    // AX perception only needs read-oriented domains. Keep the transport
    // deliberately narrower than the legacy browser-agent CDP wrapper.
    await this.safeSend(tabId, "DOM.enable");
    await this.safeSend(tabId, "Accessibility.enable");
    await this.safeSend(tabId, "Page.enable");
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    await this.debuggerApi.detach({ tabId });
    this.attached.delete(tabId);
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

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  private async safeSend(
    tabId: number,
    method: string,
  ): Promise<void> {
    try {
      await this.debuggerApi.sendCommand({ tabId }, method, {});
    } catch {
      // Restricted pages / unsupported domains must not leave a half-created
      // in-memory session. The actual read will surface a concrete error.
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
