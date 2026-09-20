import type {
  BrowserAction,
  BrowserObservation,
  ElementState,
} from "@browser-agent-next/core";
import type {
  InMemoryPersistentRefStore,
  StrongIdentity,
} from "@browser-agent-next/refs";
import type {
  StrictLiveResolution,
  StrictLiveResolver,
} from "@browser-agent-next/runtime";
import {
  discoverChromeDomFrames,
  type ChromeWebNavigationApi,
} from "../chrome/chromeFrameDiscovery.js";
import type { DomAxIdentityResolver } from "../perception/domAxCorrespondence.js";
import type {
  DomStableIdInspection,
  DomStableIdInspector,
} from "../perception/domStableIdInspector.js";
import type {
  ObservedFrameBindingLookup,
} from "../chrome/domLifecycleRegistry.js";
import type {
  ChildFrameClickPointProjector,
} from "./childFrameCoordinateProjector.js";

interface AxValue {
  value?: unknown;
}

interface AxProperty {
  name: string;
  value?: AxValue;
}

interface AxNode {
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  properties?: AxProperty[];
  backendDOMNodeId?: number;
}

export interface StrictCdpReadTransport {
  send<T>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  sendInSession<T>(
    tabId: number,
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

export interface PreparedStrictClickTarget {
  tabId: number;
  ref: string;
  stableId: string;
  backendNodeId: number;
  cdpFrameId: string;
  cdpSessionId?: string;
  frameEpoch: string;
  coordinateSpace: "top-level-viewport";
  point: {
    x: number;
    y: number;
  };
}

function axString(value: AxValue | undefined): string {
  return typeof value?.value === "string"
    ? value.value.replace(/\s+/g, " ").trim()
    : "";
}

function axBooleanProperty(
  node: AxNode,
  name: string,
): boolean | undefined {
  const value = node.properties?.find(
    (entry) => entry.name === name,
  )?.value?.value;

  return typeof value === "boolean" ? value : undefined;
}

function linkedIdentity<TSource extends StrongIdentity["source"]>(
  identities: readonly StrongIdentity[],
  source: TSource,
): Extract<StrongIdentity, { source: TSource }> | undefined {
  return identities.find(
    (identity): identity is Extract<
      StrongIdentity,
      { source: TSource }
    > => identity.source === source,
  );
}

function liveInspection(
  axNode: AxNode,
  dom: DomStableIdInspection,
) {
  const role = axString(axNode.role).toLowerCase();
  const name = axString(axNode.name);
  const axDisabled = axBooleanProperty(axNode, "disabled");

  return {
    semantic: {
      role,
      ...(name ? { name } : {}),
    },
    state: {
      visible: dom.visible,
      enabled: dom.enabled && axDisabled !== true,
    },
    geometry: {
      inViewport: dom.inViewport,
      hitTestable: dom.hitTestable,
    },
  };
}

/**
 * Strict Click live resolver。
 *
 * Main frame 继续可生成 prepared target；child frame 当前先完成 exact
 * frame/session + DOM/AX live identity revalidation，但在 top-level coordinate
 * projection 完成前仍 fail closed，不会生成可 dispatch 的 prepared target。
 */
export class ChromeStrictMainFrameClickResolver
  implements StrictLiveResolver<PreparedStrictClickTarget>
{
  constructor(
    private readonly refs: InMemoryPersistentRefStore,
    private readonly webNavigation: ChromeWebNavigationApi,
    private readonly cdp: StrictCdpReadTransport,
    private readonly identityResolver: DomAxIdentityResolver,
    private readonly domInspector: DomStableIdInspector,
    private readonly frameBindings: ObservedFrameBindingLookup,
    private readonly childProjector?: ChildFrameClickPointProjector,
  ) {}

  async resolve(input: {
    tabId: number;
    action: BrowserAction;
    observation: BrowserObservation;
    expected: ElementState;
  }): Promise<StrictLiveResolution<PreparedStrictClickTarget>> {
    if (input.action.kind !== "click") {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason: "current Chrome strict resolver only supports click",
      };
    }

    const catalog = await discoverChromeDomFrames(
      this.webNavigation,
      input.tabId,
    );

    if (
      catalog.mainDocumentEpoch !==
      input.observation.revision.documentEpoch
    ) {
      return {
        documentCompatible: false,
        reason:
          "main document epoch changed from " +
          input.observation.revision.documentEpoch +
          " to " +
          catalog.mainDocumentEpoch,
      };
    }

    const record = this.refs.byRef(input.expected.ref);
    if (!record || record.tombstonedAtRevision) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason: "persistent ref is absent or tombstoned",
      };
    }

    const identities = [
      record.identity,
      ...record.aliases,
    ];

    const domIdentity = linkedIdentity(identities, "dom");
    const axIdentity = linkedIdentity(identities, "ax");

    if (!domIdentity || !axIdentity) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason:
          "strict click currently requires linked DOM and AX strong identities",
      };
    }

    if (
      domIdentity.tabId !== input.tabId ||
      axIdentity.tabId !== input.tabId
    ) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason: "stored strong identity does not match observation/tab identity",
      };
    }

    const observedFrame = input.observation.frames.find(
      (frame) => frame.frameId === input.expected.frameId,
    );

    if (!observedFrame || !observedFrame.accessible) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason:
          "target frame is absent or inaccessible in the retained observation",
      };
    }

    const currentFrame = catalog.frames.find(
      (frame) => frame.frameId === input.expected.frameId,
    );

    if (
      !currentFrame ||
      !currentFrame.accessible ||
      currentFrame.documentEpoch !== observedFrame.documentEpoch
    ) {
      return {
        documentCompatible: false,
        reason:
          "target frame document changed after observation",
      };
    }

    const binding = this.frameBindings.bindingForFrame(
      input.tabId,
      input.expected.frameId,
    );

    if (
      !binding ||
      !binding.cdpFrameId ||
      !binding.documentEpoch
    ) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason:
          "exact CDP frame/session binding is unavailable for target frame",
      };
    }

    if (
      binding.frameEpoch !== domIdentity.frameEpoch ||
      binding.cdpFrameId !== axIdentity.cdpFrameId ||
      binding.documentEpoch !== axIdentity.documentEpoch ||
      binding.documentEpoch !== observedFrame.documentEpoch
    ) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason:
          "stored exact frame binding does not match retained strong identity",
      };
    }

    const currentCdpFrameId = binding.cdpFrameId;
    const currentCdpSessionId = binding.cdpSessionId;

    const stableIds =
      await this.identityResolver.stableIdsForBackendNodes({
        tabId: input.tabId,
        cdpFrameId: currentCdpFrameId,
        ...(currentCdpSessionId !== undefined
          ? { cdpSessionId: currentCdpSessionId }
          : {}),
        frameEpoch: domIdentity.frameEpoch,
        backendNodeIds: [axIdentity.backendNodeId],
      });

    if (
      stableIds.get(axIdentity.backendNodeId) !==
      domIdentity.stableId
    ) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason:
          "backend node no longer resolves to the observed DOM stableId",
      };
    }

    const domInspection = await this.domInspector.inspect({
      tabId: input.tabId,
      cdpFrameId: currentCdpFrameId,
      ...(currentCdpSessionId !== undefined
        ? { cdpSessionId: currentCdpSessionId }
        : {}),
      frameEpoch: domIdentity.frameEpoch,
      stableId: domIdentity.stableId,
    });

    if (!domInspection) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason:
          "observed DOM stableId no longer resolves to a connected live element",
      };
    }

    const axTree =
      currentCdpSessionId === undefined
        ? await this.cdp.send<{ nodes: AxNode[] }>(
            input.tabId,
            "Accessibility.getPartialAXTree",
            {
              backendNodeId: axIdentity.backendNodeId,
              fetchRelatives: false,
            },
          )
        : await this.cdp.sendInSession<{ nodes: AxNode[] }>(
            input.tabId,
            currentCdpSessionId,
            "Accessibility.getPartialAXTree",
            {
              backendNodeId: axIdentity.backendNodeId,
              fetchRelatives: false,
            },
          );

    const axNode = axTree.nodes.find(
      (node) =>
        !node.ignored &&
        node.backendDOMNodeId === axIdentity.backendNodeId,
    );

    if (!axNode) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason:
          "observed backend node is no longer present in the live AX tree",
      };
    }

    const live = liveInspection(
      axNode,
      domInspection,
    );

    if (input.expected.frameId !== "web:0") {
      if (!this.childProjector) {
        return {
          documentCompatible: true,
          identityMatches: false,
          reason:
            "child-frame coordinate projector is unavailable",
        };
      }

      const projected =
        await this.childProjector.project({
          tabId: input.tabId,
          targetFrameId:
            input.expected.frameId,
          point: domInspection.point,
          frames:
            input.observation.frames,
        });

      if (!projected.ok) {
        return {
          documentCompatible: true,
          identityMatches: false,
          reason:
            "child-frame coordinate projection failed: " +
            projected.reason,
        };
      }

      return {
        documentCompatible: true,
        identityMatches: true,
        live,
        prepared: {
          tabId: input.tabId,
          ref: input.expected.ref,
          stableId:
            domIdentity.stableId,
          backendNodeId:
            axIdentity.backendNodeId,
          cdpFrameId:
            currentCdpFrameId,
          ...(currentCdpSessionId !== undefined
            ? {
                cdpSessionId:
                  currentCdpSessionId,
              }
            : {}),
          frameEpoch:
            domIdentity.frameEpoch,
          coordinateSpace:
            "top-level-viewport",
          point: projected.point,
        },
      };
    }

    return {
      documentCompatible: true,
      identityMatches: true,
      live,
      prepared: {
        tabId: input.tabId,
        ref: input.expected.ref,
        stableId: domIdentity.stableId,
        backendNodeId: axIdentity.backendNodeId,
        cdpFrameId: currentCdpFrameId,
        ...(currentCdpSessionId !== undefined
          ? { cdpSessionId: currentCdpSessionId }
          : {}),
        frameEpoch: domIdentity.frameEpoch,
        coordinateSpace:
          "top-level-viewport",
        point: domInspection.point,
      },
    };
  }
}
