import type { FrameState } from "@browser-agent-next/core";
import type { DomFrameTarget } from "../perception/domCollector.js";

export interface ChromeNavigationFrame {
  frameId: number;
  parentFrameId: number;
  url: string;
  documentId?: string;
}

export interface ChromeWebNavigationApi {
  getAllFrames(
    details: { tabId: number },
  ): Promise<ChromeNavigationFrame[] | undefined>;
}

export interface ChromeDomFrameCatalog {
  frames: FrameState[];
  domFrames: DomFrameTarget[];
  mainFrameId: string;
  mainDocumentEpoch: string;
  mainUrl: string;
}

function canonicalFrameId(frameId: number): string {
  return "web:" + frameId;
}

export async function discoverChromeDomFrames(
  api: ChromeWebNavigationApi,
  tabId: number,
): Promise<ChromeDomFrameCatalog> {
  const discovered = await api.getAllFrames({ tabId });

  if (!discovered?.length) {
    throw new Error(
      "Chrome returned no webNavigation frames for tab " + tabId,
    );
  }

  const main = discovered.find((frame) => frame.frameId === 0);
  if (!main) {
    throw new Error("Chrome frame catalog has no main frame");
  }
  if (!main.documentId) {
    throw new Error(
      "main frame documentId is unavailable; Chrome 106+ is required",
    );
  }

  const frames: FrameState[] = discovered.map((frame) => ({
    frameId: canonicalFrameId(frame.frameId),
    ...(frame.parentFrameId >= 0
      ? { parentFrameId: canonicalFrameId(frame.parentFrameId) }
      : {}),
    url: frame.url,
    documentEpoch: frame.documentId
      ? "chrome-document:" + frame.documentId
      : "chrome-document:unknown:" + frame.frameId,
    accessible: Boolean(frame.documentId),
    ...(!frame.documentId
      ? { degradedReason: "document-id-unavailable" }
      : {}),
  }));

  const domFrames: DomFrameTarget[] = discovered.map((frame) => ({
    frameId: canonicalFrameId(frame.frameId),
    transportFrameId: frame.frameId,
    ...(frame.documentId !== undefined
      ? { documentId: frame.documentId }
      : {}),
    accessible: Boolean(frame.documentId),
  }));

  return {
    frames,
    domFrames,
    mainFrameId: canonicalFrameId(0),
    mainDocumentEpoch: "chrome-document:" + main.documentId,
    mainUrl: main.url,
  };
}

function documentCatalogKey(
  catalog: ChromeDomFrameCatalog,
): string {
  return catalog.domFrames
    .map((frame) => ({
      frameId: frame.frameId,
      documentId: frame.documentId ?? null,
      accessible: frame.accessible,
    }))
    .sort((a, b) => a.frameId.localeCompare(b.frameId))
    .map(
      (frame) =>
        frame.frameId +
        "=" +
        String(frame.documentId) +
        ":" +
        String(frame.accessible),
    )
    .join("|");
}

export function sameChromeDocumentCatalog(
  before: ChromeDomFrameCatalog,
  after: ChromeDomFrameCatalog,
): boolean {
  return (
    before.mainDocumentEpoch === after.mainDocumentEpoch &&
    before.mainUrl === after.mainUrl &&
    documentCatalogKey(before) === documentCatalogKey(after)
  );
}
