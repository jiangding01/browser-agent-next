import type { BrowserObservation } from "@browser-agent-next/core";
import { discoverChromeDomFrames, type ChromeWebNavigationApi } from "./chromeFrameDiscovery.js";
import { ChromeDomFrameTransport, type ChromeTabsMessagingApi } from "./chromeDomTransport.js";
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
  ) {
    this.transport = new ChromeDomFrameTransport(tabs);
  }

  async observe(input: ObserveChromeTabInput): Promise<BrowserObservation> {
    const [tab, catalog] = await Promise.all([
      this.tabs.get(input.tabId),
      discoverChromeDomFrames(this.webNavigation, input.tabId),
    ]);

    const url = tab.url ?? "";
    if (!url) {
      throw new Error("tab URL is unavailable");
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
      ...(input.sinceRevision !== undefined
        ? { sinceRevision: input.sinceRevision }
        : {}),
      ...(input.options !== undefined
        ? { domOptions: input.options }
        : {}),
    });
  }
}
