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

export interface BackendStableIdMapInput {
  tabId: number;
  cdpFrameId: string;
  cdpSessionId?: string;
  frameEpoch: string;
  backendNodeIds: number[];
}

export interface DomAxIdentityResolver {
  stableIdsForBackendNodes(
    input: BackendStableIdMapInput,
  ): Promise<Map<number, string>>;
}

export interface DomFrameEpochResolver {
  frameEpochForCdpFrame(input: {
    tabId: number;
    cdpFrameId: string;
    cdpSessionId?: string;
  }): Promise<string | undefined>;
}

let objectGroupSequence = 0;

function nextObjectGroup(tabId: number): string {
  objectGroupSequence += 1;
  return "browser-agent-next-identity:t" + tabId + ":" + objectGroupSequence;
}

export class IsolatedWorldDomIdentityResolver
  implements DomAxIdentityResolver, DomFrameEpochResolver
{
  constructor(
    private readonly transport: ChromeDebuggerReadTransport,
  ) {}

  async frameEpochForCdpFrame(input: {
    tabId: number;
    cdpFrameId: string;
    cdpSessionId?: string;
  }): Promise<string | undefined> {
    await this.transport.attach(input.tabId);

    const bindings = this.contextBindings(
      input.tabId,
      input.cdpFrameId,
      input.cdpSessionId,
    );

    const epochs = new Set<string>();

    for (const binding of bindings) {
      const result = await this.sendForSession<RuntimeCallResult>(
        input.tabId,
        binding.sessionId,
        "Runtime.evaluate",
        {
          expression:
            "globalThis[" +
            JSON.stringify(DOM_IDENTITY_BRIDGE_KEY) +
            "]?.version === 1 ? globalThis[" +
            JSON.stringify(DOM_IDENTITY_BRIDGE_KEY) +
            "].frameEpoch : null",
          contextId: binding.context.id,
          returnByValue: true,
          silent: true,
        },
      );

      if (
        !result.exceptionDetails &&
        typeof result.result.value === "string"
      ) {
        epochs.add(result.result.value);
      }
    }

    return epochs.size === 1
      ? [...epochs][0]
      : undefined;
  }

  async stableIdsForBackendNodes(
    input: BackendStableIdMapInput,
  ): Promise<Map<number, string>> {
    await this.transport.attach(input.tabId);

    const bindings = this.contextBindings(
      input.tabId,
      input.cdpFrameId,
      input.cdpSessionId,
    );

    if (bindings.length === 0) {
      return new Map();
    }

    const objectGroup = nextObjectGroup(input.tabId);
    const matchingBridges: Array<{
      objectId: string;
      sessionId?: string;
      contextId: number;
    }> = [];

    try {
      for (const binding of bindings) {
        const bridge = await this.sendForSession<RuntimeCallResult>(
          input.tabId,
          binding.sessionId,
          "Runtime.evaluate",
          {
            expression:
              "globalThis[" +
              JSON.stringify(DOM_IDENTITY_BRIDGE_KEY) +
              "] ?? null",
            contextId: binding.context.id,
            objectGroup,
            returnByValue: false,
            silent: true,
          },
        );

        const bridgeObjectId = bridge.result.objectId;
        if (!bridgeObjectId || bridge.exceptionDetails) continue;

        const meta = await this.sendForSession<RuntimeCallResult>(
          input.tabId,
          binding.sessionId,
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
          value?.version === 1 &&
          value.frameEpoch === input.frameEpoch
        ) {
          matchingBridges.push({
            objectId: bridgeObjectId,
            contextId: binding.context.id,
            ...(binding.sessionId !== undefined
              ? { sessionId: binding.sessionId }
              : {}),
          });
        }
      }

      // 一个 frameEpoch 在指定 CDP session/frame 中必须唯一。
      if (matchingBridges.length !== 1) {
        return new Map();
      }

      const bridge = matchingBridges[0]!;
      const result = new Map<number, string>();

      for (const backendNodeId of input.backendNodeIds) {
        let resolved: DomResolveNodeResult;

        try {
          resolved = await this.sendForSession<DomResolveNodeResult>(
            input.tabId,
            bridge.sessionId,
            "DOM.resolveNode",
            {
              backendNodeId,
              executionContextId: bridge.contextId,
              objectGroup,
            },
          );
        } catch {
          continue;
        }

        const nodeObjectId = resolved.object.objectId;
        if (!nodeObjectId) continue;

        const stableIdResult =
          await this.sendForSession<RuntimeCallResult>(
            input.tabId,
            bridge.sessionId,
            "Runtime.callFunctionOn",
            {
              objectId: bridge.objectId,
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
    } finally {
      const sessions = new Set(
        bindings.map((binding) => binding.sessionId),
      );

      for (const sessionId of sessions) {
        try {
          await this.sendForSession(
            input.tabId,
            sessionId,
            "Runtime.releaseObjectGroup",
            { objectGroup },
          );
        } catch {
          // 只影响临时 remote object 回收，不改变 identity 结果。
        }
      }
    }
  }

  private contextBindings(
    tabId: number,
    cdpFrameId: string,
    cdpSessionId?: string,
  ): Array<{
    context: {
      id: number;
      auxData?: {
        isDefault?: boolean;
      };
    };
    sessionId?: string;
  }> {
    if (cdpSessionId === undefined) {
      return this.transport
        .contextsForFrame(tabId, cdpFrameId)
        .filter((context) => context.auxData?.isDefault !== true)
        .map((context) => ({ context }));
    }

    return this.transport
      .contextBindingsForFrame(tabId, cdpFrameId)
      .filter(
        (binding) =>
          binding.sessionId === cdpSessionId &&
          binding.context.auxData?.isDefault !== true,
      );
  }

  private sendForSession<T>(
    tabId: number,
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return sessionId === undefined
      ? this.transport.send<T>(tabId, method, params)
      : this.transport.sendInSession<T>(
          tabId,
          sessionId,
          method,
          params,
        );
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

export interface LinkDomAxInput {
  tabId: number;
  dom: CollectedDomSource;
  ax: CollectedAxSource;
  resolver: DomAxIdentityResolver;
  frameIds?: string[];
  maxLinks?: number;
}

export interface LinkedDomAxSources {
  dom: CollectedDomSource;
  ax: CollectedAxSource;
  linkedCount: number;
  warnings: string[];
}

export async function linkDomAxFrames(
  input: LinkDomAxInput,
): Promise<LinkedDomAxSources> {
  const allowed = input.frameIds
    ? new Set(input.frameIds)
    : undefined;
  const axCandidates = input.ax.elements.filter(
    (candidate) =>
      candidate.identity.source === "ax" &&
      (allowed?.has(candidate.frameId) ?? true),
  );

  // AX collection 已经有明确 maxElements 上限。默认 linking 必须覆盖全部
  // 已收集 candidate，不能额外引入一个静默的第二重截断。
  const maxLinks = input.maxLinks ?? input.ax.elements.length;
  const limited = axCandidates.slice(0, maxLinks);
  const byFrame = new Map<string, typeof limited>();

  for (const candidate of limited) {
    const group = byFrame.get(candidate.frameId);
    if (group) group.push(candidate);
    else byFrame.set(candidate.frameId, [candidate]);
  }

  const domElements = input.dom.elements.map((candidate) => ({ ...candidate }));
  const axElements = input.ax.elements.map((candidate) => ({ ...candidate }));
  const warnings: string[] = [];
  let linkedCount = 0;

  for (const [frameId, frameCandidates] of byFrame) {
    const frameEpoch = input.dom.frameEpochByFrame[frameId];
    if (!frameEpoch) {
      warnings.push(
        "DOM frameEpoch 不可用，跳过 DOM↔AX linking: " +
          frameId,
      );
      continue;
    }

    const cdpFrameIds = new Set(
      frameCandidates.flatMap((candidate) =>
        candidate.identity.source === "ax"
          ? [candidate.identity.cdpFrameId]
          : [],
      ),
    );

    if (cdpFrameIds.size !== 1) {
      warnings.push(
        "同一 web frame 对应多个 CDP frame identity，拒绝 linking: " +
          frameId,
      );
      continue;
    }

    const cdpFrameId = [...cdpFrameIds][0]!;
    const cdpSessionId =
      input.ax.cdpSessionIdByFrame?.[frameId];

    const stableIds = await input.resolver.stableIdsForBackendNodes({
      tabId: input.tabId,
      cdpFrameId,
      ...(cdpSessionId !== undefined
        ? { cdpSessionId }
        : {}),
      frameEpoch,
      backendNodeIds: frameCandidates.flatMap((candidate) =>
        candidate.identity.source === "ax"
          ? [candidate.identity.backendNodeId]
          : [],
      ),
    });

    const domIndexByStableId = new Map<string, number>();

    domElements.forEach((candidate, index) => {
      if (
        candidate.frameId !== frameId ||
        candidate.identity.source !== "dom" ||
        candidate.identity.frameEpoch !== frameEpoch
      ) {
        return;
      }
      domIndexByStableId.set(
        candidate.identity.stableId,
        index,
      );
    });

    for (let axIndex = 0; axIndex < axElements.length; axIndex += 1) {
      const axCandidate = axElements[axIndex]!;
      if (
        axCandidate.frameId !== frameId ||
        axCandidate.identity.source !== "ax" ||
        axCandidate.identity.cdpFrameId !== cdpFrameId
      ) {
        continue;
      }

      const stableId = stableIds.get(
        axCandidate.identity.backendNodeId,
      );
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

export interface LinkMainFrameDomAxInput {
  tabId: number;
  mainFrameId: string;
  dom: CollectedDomSource;
  ax: CollectedAxSource;
  resolver: DomAxIdentityResolver;
  maxLinks?: number;
}

export async function linkMainFrameDomAx(
  input: LinkMainFrameDomAxInput,
): Promise<LinkedDomAxSources> {
  return linkDomAxFrames({
    tabId: input.tabId,
    dom: input.dom,
    ax: input.ax,
    resolver: input.resolver,
    frameIds: [input.mainFrameId],
    ...(input.maxLinks !== undefined
      ? { maxLinks: input.maxLinks }
      : {}),
  });
}

export type HybridSourcePair = {
  dom: PerceptionSourceResult;
  ax: PerceptionSourceResult;
};
