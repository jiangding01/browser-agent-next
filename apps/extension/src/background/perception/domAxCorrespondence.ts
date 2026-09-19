import type {
  PerceptionElementCandidate,
  PerceptionSourceResult,
} from "@browser-agent-next/perception";
import { DOM_IDENTITY_BRIDGE_KEY } from "../../protocol/identityBridge.js";
import type { ChromeDebuggerReadTransport } from "../chrome/chromeDebuggerTransport.js";
import type { CollectedDomSource } from "./domCollector.js";
import type { CollectedAxSource } from "./axSource.js";

interface RuntimeRemoteObject {
  objectId?: string;
  value?: unknown;
}

interface RuntimeCallResult {
  result: RuntimeRemoteObject;
  exceptionDetails?: unknown;
}

interface DomResolveNodeResult {
  object: RuntimeRemoteObject;
}

interface DomNodeDescription {
  node: {
    backendNodeId?: number;
  };
}

export interface BackendStableIdMapInput {
  tabId: number;
  cdpFrameId: string;
  frameEpoch: string;
  backendNodeIds: number[];
}

export interface DomAxIdentityResolver {
  stableIdsForBackendNodes(
    input: BackendStableIdMapInput,
  ): Promise<Map<number, string>>;
}

let objectGroupSequence = 0;

function nextObjectGroup(tabId: number): string {
  objectGroupSequence += 1;
  return "browser-agent-next-identity:t" + tabId + ":" + objectGroupSequence;
}

export class IsolatedWorldDomIdentityResolver implements DomAxIdentityResolver {
  constructor(
    private readonly transport: ChromeDebuggerReadTransport,
  ) {}

  async stableIdsForBackendNodes(
    input: BackendStableIdMapInput,
  ): Promise<Map<number, string>> {
    // attach + Runtime.enable 会让 transport 收到现有 execution contexts。
    await this.transport.attach(input.tabId);

    const contexts = this.transport
      .contextsForFrame(input.tabId, input.cdpFrameId)
      .filter((context) => context.auxData?.isDefault !== true);

    if (contexts.length === 0) {
      return new Map();
    }

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

        const value = meta.result.value as
          | { version?: unknown; frameEpoch?: unknown }
          | undefined;

        if (
          value?.version !== 1 ||
          value.frameEpoch !== input.frameEpoch
        ) {
          continue;
        }

        const result = new Map<number, string>();

        for (const backendNodeId of input.backendNodeIds) {
          let resolved: DomResolveNodeResult;

          try {
            resolved = await this.transport.send<DomResolveNodeResult>(
              input.tabId,
              "DOM.resolveNode",
              {
                backendNodeId,
                executionContextId: context.id,
                objectGroup,
              },
            );
          } catch {
            continue;
          }

          const nodeObjectId = resolved.object.objectId;
          if (!nodeObjectId) continue;

          const stableIdResult = await this.transport.send<RuntimeCallResult>(
            input.tabId,
            "Runtime.callFunctionOn",
            {
              objectId: bridgeObjectId,
              functionDeclaration:
                "function(element){return this.stableIdOf(element);}",
              arguments: [{ objectId: nodeObjectId }],
              objectGroup,
              returnByValue: true,
              silent: true,
            },
          );

          if (
            !stableIdResult.exceptionDetails &&
            typeof stableIdResult.result.value === "string"
          ) {
            result.set(
              backendNodeId,
              stableIdResult.result.value,
            );
          }
        }

        return result;
      }

      return new Map();
    } finally {
      try {
        await this.transport.send(
          input.tabId,
          "Runtime.releaseObjectGroup",
          { objectGroup },
        );
      } catch {
        // 只影响临时 remote object 回收，不改变 identity 结果。
      }
    }
  }
}

function backendMergeKey(
  identity: Extract<
    PerceptionElementCandidate["identity"],
    { source: "ax" }
  >,
): string {
  return [
    "backend",
    identity.cdpFrameId,
    identity.documentEpoch,
    identity.backendNodeId,
  ].join(":");
}

export interface LinkMainFrameDomAxInput {
  tabId: number;
  mainFrameId: string;
  dom: CollectedDomSource;
  ax: CollectedAxSource;
  resolver: DomAxIdentityResolver;
  maxLinks?: number;
}

export interface LinkedDomAxSources {
  dom: CollectedDomSource;
  ax: CollectedAxSource;
  linkedCount: number;
  warnings: string[];
}

/**
 * 使用 content isolated-world object identity + CDP backendDOMNodeId 建立
 * exact correspondence。role/name/geometry 只作为最终状态字段，不参与身份判定。
 */
export async function linkMainFrameDomAx(
  input: LinkMainFrameDomAxInput,
): Promise<LinkedDomAxSources> {
  const frameEpoch = input.dom.frameEpochByFrame[input.mainFrameId];
  if (!frameEpoch) {
    return {
      dom: input.dom,
      ax: input.ax,
      linkedCount: 0,
      warnings: ["main frame DOM frameEpoch 不可用，跳过 DOM↔AX identity linking"],
    };
  }

  const axCandidates = input.ax.elements.filter(
    (candidate) =>
      candidate.frameId === input.mainFrameId &&
      candidate.identity.source === "ax",
  );

  const maxLinks = input.maxLinks ?? 200;
  const limitedAx = axCandidates.slice(0, maxLinks);

  const stableIds = await input.resolver.stableIdsForBackendNodes({
    tabId: input.tabId,
    cdpFrameId: input.ax.mainCdpFrameId,
    frameEpoch,
    backendNodeIds: limitedAx.map((candidate) => {
      if (candidate.identity.source !== "ax") {
        throw new Error("unexpected non-AX identity");
      }
      return candidate.identity.backendNodeId;
    }),
  });

  const domIndexByStableId = new Map<string, number>();

  input.dom.elements.forEach((candidate, index) => {
    if (
      candidate.frameId !== input.mainFrameId ||
      candidate.identity.source !== "dom" ||
      candidate.identity.frameEpoch !== frameEpoch
    ) {
      return;
    }

    domIndexByStableId.set(candidate.identity.stableId, index);
  });

  const domElements = input.dom.elements.map((candidate) => ({ ...candidate }));
  const axElements = input.ax.elements.map((candidate) => ({ ...candidate }));
  let linkedCount = 0;
  const warnings: string[] = [];

  for (let axIndex = 0; axIndex < axElements.length; axIndex += 1) {
    const axCandidate = axElements[axIndex]!;
    if (
      axCandidate.frameId !== input.mainFrameId ||
      axCandidate.identity.source !== "ax"
    ) {
      continue;
    }

    const stableId = stableIds.get(axCandidate.identity.backendNodeId);
    if (!stableId) continue;

    const domIndex = domIndexByStableId.get(stableId);
    if (domIndex === undefined) continue;

    const domCandidate = domElements[domIndex]!;
    const mergeKey = backendMergeKey(axCandidate.identity);

    domElements[domIndex] = {
      ...domCandidate,
      mergeKey,
    };
    axElements[axIndex] = {
      ...axCandidate,
      mergeKey,
    };
    linkedCount += 1;
  }

  if (axCandidates.length > maxLinks) {
    warnings.push(
      "DOM↔AX linking cap 命中：" +
        axCandidates.length +
        " 个 AX candidate 中仅尝试前 " +
        maxLinks +
        " 个；未链接 candidate 仍保持独立 identity",
    );
  }

  return {
    dom: {
      ...input.dom,
      elements: domElements,
      warnings: [
        ...(input.dom.warnings ?? []),
        ...warnings,
      ],
    },
    ax: {
      ...input.ax,
      elements: axElements,
      warnings: [
        ...(input.ax.warnings ?? []),
        ...warnings,
      ],
    },
    linkedCount,
    warnings,
  };
}

export type HybridSourcePair = {
  dom: PerceptionSourceResult;
  ax: PerceptionSourceResult;
};
