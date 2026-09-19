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

interface PageFrameTreeResult {
  frameTree: {
    frame: {
      id: string;
    };
  };
}

export interface StrictCdpReadTransport {
  send<T>(
    tabId: number,
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
  frameEpoch: string;
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
 * PR #2 的第一版 live resolver 只支持 main-frame、DOM+AX linked identity 的
 * strict click。AX-only、DOM-only、child-frame target 均 fail closed。
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

    if (input.expected.frameId !== "web:0") {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason: "current Chrome strict resolver only supports main-frame targets",
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
      axIdentity.tabId !== input.tabId ||
      axIdentity.documentEpoch !==
        input.observation.revision.documentEpoch
    ) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason: "stored strong identity does not match observation/tab identity",
      };
    }

    const frameTree = await this.cdp.send<PageFrameTreeResult>(
      input.tabId,
      "Page.getFrameTree",
    );

    const currentCdpFrameId = frameTree.frameTree.frame.id;

    if (currentCdpFrameId !== axIdentity.cdpFrameId) {
      return {
        documentCompatible: true,
        identityMatches: false,
        reason:
          "CDP main-frame identity changed after observation",
      };
    }

    const stableIds =
      await this.identityResolver.stableIdsForBackendNodes({
        tabId: input.tabId,
        cdpFrameId: currentCdpFrameId,
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

    const axTree = await this.cdp.send<{ nodes: AxNode[] }>(
      input.tabId,
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

    return {
      documentCompatible: true,
      identityMatches: true,
      live: liveInspection(axNode, domInspection),
      prepared: {
        tabId: input.tabId,
        ref: input.expected.ref,
        stableId: domIdentity.stableId,
        backendNodeId: axIdentity.backendNodeId,
        cdpFrameId: currentCdpFrameId,
        frameEpoch: domIdentity.frameEpoch,
        point: domInspection.point,
      },
    };
  }
}
