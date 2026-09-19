import type { BrowserObservation } from "@browser-agent-next/core";
import {
  discoverChromeDomFrames,
  sameChromeDocumentCatalog,
  type ChromeWebNavigationApi,
} from "./chromeFrameDiscovery.js";
import {
  ChromeDomFrameTransport,
  type ChromeTabsMessagingApi,
} from "./chromeDomTransport.js";
import type { ChromeDebuggerReadTransport } from "./chromeDebuggerTransport.js";
import {
  collectMainAxSource,
  type CollectedAxSource,
} from "../perception/axSource.js";
import {
  IsolatedWorldDomIdentityResolver,
  linkMainFrameDomAx,
} from "../perception/domAxCorrespondence.js";
import type { DomObservationCoordinator } from "../perception/observationCoordinator.js";

export interface ChromeTabRecord {
  id?: number;
  title?: string;
  url?: string;
}

export interface ChromeTabsApi extends ChromeTabsMessagingApi {
  get(tabId: number): Promise<ChromeTabRecord>;
}

export interface ObserveChromeTabInput {
  tabId: number;
  ownedBySession: boolean;
  sinceRevision?: string;
  options?: {
    maxElements?: number;
    includeValues?: boolean;
    includeOpenShadowRoots?: boolean;
    includeAx?: boolean;
    maxAxElements?: number;
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

export class ChromeDomObservationService {
  private readonly transport: ChromeDomFrameTransport;

  constructor(
    private readonly tabs: ChromeTabsApi,
    private readonly webNavigation: ChromeWebNavigationApi,
    private readonly coordinator: DomObservationCoordinator,
    private readonly debuggerTransport?: ChromeDebuggerReadTransport,
  ) {
    this.transport = new ChromeDomFrameTransport(tabs);
  }

  async observe(
    input: ObserveChromeTabInput,
  ): Promise<BrowserObservation> {
    const [tab, catalog] = await Promise.all([
      this.tabs.get(input.tabId),
      discoverChromeDomFrames(this.webNavigation, input.tabId),
    ]);

    const url = catalog.mainUrl;
    if (!url) {
      throw new Error("main frame URL is unavailable");
    }

    const includeAx = input.options?.includeAx === true;
    let extraSources = undefined;
    let collectedAx: CollectedAxSource | undefined;

    if (includeAx) {
      if (!this.debuggerTransport) {
        throw new Error("AX perception requested but debugger transport is unavailable");
      }

      collectedAx = await collectMainAxSource({
        tabId: input.tabId,
        mainDocumentEpoch: catalog.mainDocumentEpoch,
        transport: this.debuggerTransport,
        hasChildFrames: catalog.frames.length > 1,
        ...(input.options?.maxAxElements !== undefined
          ? { maxElements: input.options.maxAxElements }
          : {}),
      });

      extraSources = [collectedAx];
    }

    return this.coordinator.observe({
      tab: {
        tabId: input.tabId,
        title: tab.title ?? "",
        url,
        origin: originOf(url),
        ownedBySession: input.ownedBySession,
      },
      frames: catalog.frames,
      domFrames: catalog.domFrames,
      mainFrameId: catalog.mainFrameId,
      mainDocumentEpoch: catalog.mainDocumentEpoch,
      transport: this.transport,
      ...(extraSources !== undefined ? { extraSources } : {}),
      ...(collectedAx !== undefined && this.debuggerTransport !== undefined
        ? {
            refineSources: async ({
              dom,
              extraSources: sources,
            }: {
              dom: import("../perception/domCollector.js").CollectedDomSource;
              extraSources: import("@browser-agent-next/perception").PerceptionSourceResult[];
            }) => {
              const linked = await linkMainFrameDomAx({
                tabId: input.tabId,
                mainFrameId: catalog.mainFrameId,
                dom,
                ax: collectedAx!,
                resolver: new IsolatedWorldDomIdentityResolver(
                  this.debuggerTransport!,
                ),
              });

              return {
                dom: linked.dom,
                extraSources: sources.map((source) =>
                  source === collectedAx ? linked.ax : source,
                ),
              };
            },
          }
        : {}),
      validateBeforeCommit: async () => {
        const current = await discoverChromeDomFrames(
          this.webNavigation,
          input.tabId,
        );

        if (!sameChromeDocumentCatalog(catalog, current)) {
          throw new Error(
            "Chrome frame/document catalog changed during observation",
          );
        }
      },
      ...(input.sinceRevision !== undefined
        ? { sinceRevision: input.sinceRevision }
        : {}),
      ...(input.options !== undefined
        ? {
            domOptions: {
              ...(input.options.maxElements !== undefined
                ? { maxElements: input.options.maxElements }
                : {}),
              ...(input.options.includeValues !== undefined
                ? { includeValues: input.options.includeValues }
                : {}),
              ...(input.options.includeOpenShadowRoots !== undefined
                ? { includeOpenShadowRoots: input.options.includeOpenShadowRoots }
                : {}),
            },
          }
        : {}),
    });
  }
}
