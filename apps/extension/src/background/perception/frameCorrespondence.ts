import type { FrameState } from "@browser-agent-next/core";
import type { ChromeDebuggerReadTransport } from "../chrome/chromeDebuggerTransport.js";
import type { CollectedDomSource } from "./domCollector.js";
import type { DomFrameEpochResolver } from "./domAxCorrespondence.js";

interface PageFrame {
  id: string;
  parentId?: string;
}

interface PageFrameTree {
  frame: PageFrame;
  childFrames?: PageFrameTree[];
}

export interface ExactFrameMapping {
  webFrameId: string;
  cdpFrameId: string;
  frameEpoch: string;
  documentEpoch: string;
}

export interface ExactFrameCorrespondence {
  mappings: ExactFrameMapping[];
  unmappedWebFrameIds: string[];
  unmappedCdpFrameIds: string[];
  warnings: string[];
}

export interface MapDomFramesToCdpInput {
  tabId: number;
  frames: FrameState[];
  dom: CollectedDomSource;
  transport: ChromeDebuggerReadTransport;
  resolver: DomFrameEpochResolver;
}

function flattenFrameTree(tree: PageFrameTree): PageFrame[] {
  return [
    tree.frame,
    ...(tree.childFrames ?? []).flatMap(flattenFrameTree),
  ];
}

/**
 * webNavigation.frameId 与 CDP Page.FrameId 属于不同命名空间。
 *
 * 本函数只使用 content isolated-world 随文档生成的 frameEpoch 做 exact
 * correspondence；URL、frame 顺序、parent index、role/name 均不参与映射。
 */
export async function mapDomFramesToCdp(
  input: MapDomFramesToCdpInput,
): Promise<ExactFrameCorrespondence> {
  const frameTree = await input.transport.send<{
    frameTree: PageFrameTree;
  }>(
    input.tabId,
    "Page.getFrameTree",
  );

  const cdpFrames = flattenFrameTree(frameTree.frameTree);
  const warnings: string[] = [];

  const webFramesByEpoch = new Map<string, string[]>();

  for (const frame of input.frames) {
    if (!frame.accessible) continue;

    const epoch = input.dom.frameEpochByFrame[frame.frameId];
    if (!epoch) {
      warnings.push(
        "DOM frameEpoch 不可用，无法建立 exact CDP mapping: " +
          frame.frameId,
      );
      continue;
    }

    const existing = webFramesByEpoch.get(epoch);
    if (existing) existing.push(frame.frameId);
    else webFramesByEpoch.set(epoch, [frame.frameId]);
  }

  const documentEpochByWebFrame = new Map(
    input.frames.map((frame) => [
      frame.frameId,
      frame.documentEpoch,
    ]),
  );

  const mappingByWebFrame = new Map<string, ExactFrameMapping>();
  const mappedCdpFrames = new Set<string>();
  const cdpEpochOwners = new Map<string, string[]>();

  for (const cdpFrame of cdpFrames) {
    const frameEpoch =
      await input.resolver.frameEpochForCdpFrame({
        tabId: input.tabId,
        cdpFrameId: cdpFrame.id,
      });

    if (!frameEpoch) continue;

    const owners = cdpEpochOwners.get(frameEpoch);
    if (owners) owners.push(cdpFrame.id);
    else cdpEpochOwners.set(frameEpoch, [cdpFrame.id]);
  }

  for (const [frameEpoch, webFrameIds] of webFramesByEpoch) {
    const cdpFrameIds = cdpEpochOwners.get(frameEpoch) ?? [];

    if (webFrameIds.length !== 1) {
      warnings.push(
        "frameEpoch 在 webNavigation frame 中非唯一，拒绝猜测映射: " +
          frameEpoch,
      );
      continue;
    }

    if (cdpFrameIds.length !== 1) {
      if (cdpFrameIds.length > 1) {
        warnings.push(
          "frameEpoch 在 CDP frame 中非唯一，拒绝猜测映射: " +
            frameEpoch,
        );
      }
      continue;
    }

    const webFrameId = webFrameIds[0]!;
    const cdpFrameId = cdpFrameIds[0]!;
    const documentEpoch = documentEpochByWebFrame.get(webFrameId);

    if (!documentEpoch) {
      warnings.push(
        "documentEpoch 不可用，拒绝建立 CDP mapping: " +
          webFrameId,
      );
      continue;
    }

    mappingByWebFrame.set(webFrameId, {
      webFrameId,
      cdpFrameId,
      frameEpoch,
      documentEpoch,
    });
    mappedCdpFrames.add(cdpFrameId);
  }

  const expectedWebFrameIds = input.frames
    .filter((frame) => frame.accessible)
    .map((frame) => frame.frameId);

  return {
    mappings: [...mappingByWebFrame.values()].sort(
      (a, b) => a.webFrameId.localeCompare(b.webFrameId),
    ),
    unmappedWebFrameIds: expectedWebFrameIds.filter(
      (frameId) => !mappingByWebFrame.has(frameId),
    ),
    unmappedCdpFrameIds: cdpFrames
      .map((frame) => frame.id)
      .filter((frameId) => !mappedCdpFrames.has(frameId)),
    warnings,
  };
}
