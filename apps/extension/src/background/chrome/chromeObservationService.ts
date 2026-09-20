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
  collectMappedAxSource,
} from "../perception/axSource.js";
import {
  IsolatedWorldDomIdentityResolver,
  linkDomAxFrames,
} from "../perception/domAxCorrespondence.js";
import {
  mapDomFramesToCdp,
} from "../perception/frameCorrespondence.js";
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

    if (includeAx && !this.debuggerTransport) {
      throw new Error(
        "AX perception requested but debugger transport is unavailable",
      );
    }

    const debuggerTransport = this.debuggerTransport;

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
      ...(includeAx && debuggerTransport !== undefined
        ? {
            refineSources: async ({
              dom,
              extraSources,
            }: {
              dom: import("../perception/domCollector.js").CollectedDomSource;
              extraSources: import("@browser-agent-next/perception").PerceptionSourceResult[];
            }) => {
              const identityResolver =
                new IsolatedWorldDomIdentityResolver(
                  debuggerTransport,
                );

              const correspondence =
                await mapDomFramesToCdp({
                  tabId: input.tabId,
                  frames: catalog.frames,
                  dom,
                  transport: debuggerTransport,
                  resolver: identityResolver,
                });

              const ax = await collectMappedAxSource({
                tabId: input.tabId,
                mappings: correspondence.mappings,
                expectedFrameIds: catalog.frames
                  .filter((frame) => frame.accessible)
                  .map((frame) => frame.frameId),
                transport: debuggerTransport,
                ...(input.options?.maxAxElements !== undefined
                  ? {
                      maxElements:
                        input.options.maxAxElements,
                    }
                  : {}),
              });

              const axWithMappingWarnings = {
                ...ax,
                warnings: [
                  ...correspondence.warnings,
                  ...(ax.warnings ?? []),
                ],
              };

              const linked = await linkDomAxFrames({
                tabId: input.tabId,
                dom,
                ax: axWithMappingWarnings,
                resolver: identityResolver,
              });

              return {
                dom: linked.dom,
                extraSources: [
                  ...extraSources,
                  linked.ax,
                ],
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
                ? {
                    includeOpenShadowRoots:
                      input.options.includeOpenShadowRoots,
                  }
                : {}),
            },
          }
        : {}),
    });
  }
}
