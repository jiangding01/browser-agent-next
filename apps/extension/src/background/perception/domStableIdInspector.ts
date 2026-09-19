import { DOM_IDENTITY_BRIDGE_KEY } from "../../protocol/identityBridge.js";
import type { ChromeDebuggerReadTransport } from "../chrome/chromeDebuggerTransport.js";

interface RuntimeRemoteObject {
  objectId?: string;
  value?: unknown;
}

interface RuntimeCallResult {
  result: RuntimeRemoteObject;
  exceptionDetails?: unknown;
}

export interface DomStableIdInspection {
  visible: boolean;
  enabled: boolean;
  inViewport: boolean;
  hitTestable: boolean;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  point: {
    x: number;
    y: number;
  };
}

export interface InspectDomStableIdInput {
  tabId: number;
  cdpFrameId: string;
  frameEpoch: string;
  stableId: string;
}

export interface DomStableIdInspector {
  inspect(
    input: InspectDomStableIdInput,
  ): Promise<DomStableIdInspection | undefined>;
}

let inspectionGroupSequence = 0;

function nextObjectGroup(tabId: number): string {
  inspectionGroupSequence += 1;
  return (
    "browser-agent-next-strict-inspection:t" +
    tabId +
    ":" +
    inspectionGroupSequence
  );
}

/**
 * 使用 Extension isolated world 中已经存在的 stable-id bridge 读取 live DOM
 * actionability。整个流程不写 DOM attribute，也不接受模型提供的 JS。
 */
export class IsolatedWorldDomStableIdInspector
  implements DomStableIdInspector
{
  constructor(
    private readonly transport: ChromeDebuggerReadTransport,
  ) {}

  async inspect(
    input: InspectDomStableIdInput,
  ): Promise<DomStableIdInspection | undefined> {
    await this.transport.attach(input.tabId);

    const contexts = this.transport
      .contextsForFrame(input.tabId, input.cdpFrameId)
      .filter((context) => context.auxData?.isDefault !== true);

    if (contexts.length === 0) return undefined;

    const objectGroup = nextObjectGroup(input.tabId);

    try {
      for (const context of contexts) {
        const bridge = await this.transport.send<RuntimeCallResult>(
          input.tabId,
          "Runtime.evaluate",
          {
            expression:
              "globalThis[" +
              JSON.stringify(DOM_IDENTITY_BRIDGE_KEY) +
              "] ?? null",
            contextId: context.id,
            objectGroup,
            returnByValue: false,
            silent: true,
          },
        );

        const bridgeObjectId = bridge.result.objectId;
        if (!bridgeObjectId || bridge.exceptionDetails) continue;

        const meta = await this.transport.send<RuntimeCallResult>(
          input.tabId,
          "Runtime.callFunctionOn",
          {
            objectId: bridgeObjectId,
            functionDeclaration:
              "function(){return {version:this.version,frameEpoch:this.frameEpoch};}",
            objectGroup,
            returnByValue: true,
            silent: true,
          },
        );

        const metaValue = meta.result.value as
          | { version?: unknown; frameEpoch?: unknown }
          | undefined;

        if (
          metaValue?.version !== 1 ||
          metaValue.frameEpoch !== input.frameEpoch
        ) {
          continue;
        }

        const inspected = await this.transport.send<RuntimeCallResult>(
          input.tabId,
          "Runtime.callFunctionOn",
          {
            objectId: bridgeObjectId,
            functionDeclaration: String.raw`function(stableId){
              const element = this.resolve(stableId);
              if (!element || !element.isConnected) return null;

              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const hiddenByTree = !!element.closest("[hidden]");
              const visible =
                !hiddenByTree &&
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                style.visibility !== "collapse" &&
                rect.width > 0 &&
                rect.height > 0;

              const disabled =
                (typeof element.matches === "function" &&
                  element.matches(":disabled")) ||
                element.getAttribute("aria-disabled") === "true" ||
                !!element.closest("[inert]");

              const left = Math.max(rect.left, 0);
              const top = Math.max(rect.top, 0);
              const right = Math.min(rect.right, innerWidth);
              const bottom = Math.min(rect.bottom, innerHeight);
              const inViewport =
                visible &&
                right > left &&
                bottom > top;

              const x = inViewport ? (left + right) / 2 : rect.left + rect.width / 2;
              const y = inViewport ? (top + bottom) / 2 : rect.top + rect.height / 2;

              const hit = inViewport
                ? document.elementFromPoint(x, y)
                : null;

              const hitTestable =
                !!hit &&
                (hit === element || element.contains(hit));

              return {
                visible,
                enabled: !disabled,
                inViewport,
                hitTestable,
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                point: { x, y },
              };
            }`,
            arguments: [{ value: input.stableId }],
            objectGroup,
            returnByValue: true,
            silent: true,
          },
        );

        if (inspected.exceptionDetails) continue;

        const value = inspected.result.value;
        if (
          typeof value !== "object" ||
          value === null
        ) {
          return undefined;
        }

        const candidate = value as Partial<DomStableIdInspection>;

        if (
          typeof candidate.visible !== "boolean" ||
          typeof candidate.enabled !== "boolean" ||
          typeof candidate.inViewport !== "boolean" ||
          typeof candidate.hitTestable !== "boolean" ||
          typeof candidate.point?.x !== "number" ||
          typeof candidate.point?.y !== "number" ||
          typeof candidate.rect?.x !== "number" ||
          typeof candidate.rect?.y !== "number" ||
          typeof candidate.rect?.width !== "number" ||
          typeof candidate.rect?.height !== "number"
        ) {
          return undefined;
        }

        return candidate as DomStableIdInspection;
      }

      return undefined;
    } finally {
      try {
        await this.transport.send(
          input.tabId,
          "Runtime.releaseObjectGroup",
          { objectGroup },
        );
      } catch {
        // 仅影响临时 remote object 回收。
      }
    }
  }
}
