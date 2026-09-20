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

interface CdpFrameCandidate {
  cdpFrameId: string;
  cdpSessionId?: string;
}

export interface ExactFrameMapping {
  webFrameId: string;
  cdpFrameId: string;
  cdpSessionId?: string;
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

function candidateKey(candidate: CdpFrameCandidate): string {
  return (
    (candidate.cdpSessionId ?? "root") +
    ":" +
    candidate.cdpFrameId
  );
}

async function discoverCdpFrameCandidates(
  input: MapDomFramesToCdpInput,
  warnings: string[],
): Promise<CdpFrameCandidate[]> {
  await input.transport.attach(input.tabId);
  await input.transport.waitForChildSessionInitialization(
    input.tabId,
  );

  const rootTree = await input.transport.send<{
    frameTree: PageFrameTree;
  }>(
    input.tabId,
    "Page.getFrameTree",
  );

  const candidates: CdpFrameCandidate[] =
    flattenFrameTree(rootTree.frameTree).map(
      (frame) => ({
        cdpFrameId: frame.id,
      }),
    );

  const childSessions =
    input.transport.childSessions(input.tabId);

  const childTrees = await Promise.all(
    childSessions.map(async (session) => {
      try {
        const tree = await input.transport.sendInSession<{
          frameTree: PageFrameTree;
        }>(
          input.tabId,
          session.sessionId,
          "Page.getFrameTree",
        );

        return {
          ok: true as const,
          sessionId: session.sessionId,
          frames: flattenFrameTree(tree.frameTree),
        };
      } catch (error) {
        return {
          ok: false as const,
          sessionId: session.sessionId,
          warning:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "child session frame tree unavailable",
        };
      }
    }),
  );

  for (const child of childTrees) {
    if (!child.ok) {
      warnings.push(
        "OOPIF child session frame tree 不可用，保持 unmapped: " +
          child.sessionId.slice(0, 128) +
          " (" +
          child.warning +
          ")",
      );
      continue;
    }

    for (const frame of child.frames) {
      candidates.push({
        cdpFrameId: frame.id,
        cdpSessionId: child.sessionId,
      });
    }
  }

  const unique = new Map<string, CdpFrameCandidate>();
  for (const candidate of candidates) {
    unique.set(candidateKey(candidate), candidate);
  }

  return [...unique.values()];
}

/**
 * webNavigation.frameId 与 CDP Page.FrameId 属于不同命名空间。
 *
 * 本函数只使用 content isolated-world 随文档生成的 frameEpoch 做 exact
 * correspondence；URL、frame 顺序、parent index、role/name 均不参与映射。
 *
 * OOPIF 额外保留 flat debugger sessionId。相同 cdpFrameId 出现在不同
 * protocol session 时仍视为不同候选，只有 frameEpoch exact proof 唯一时才映射。
 */
export async function mapDomFramesToCdp(
  input: MapDomFramesToCdpInput,
): Promise<ExactFrameCorrespondence> {
  const warnings: string[] = [];
  const cdpFrames =
    await discoverCdpFrameCandidates(input, warnings);

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

  const mappingByWebFrame =
    new Map<string, ExactFrameMapping>();
  const mappedCdpFrames = new Set<string>();
  const cdpEpochOwners =
    new Map<string, CdpFrameCandidate[]>();

  for (const cdpFrame of cdpFrames) {
    const frameEpoch =
      await input.resolver.frameEpochForCdpFrame({
        tabId: input.tabId,
        cdpFrameId: cdpFrame.cdpFrameId,
        ...(cdpFrame.cdpSessionId !== undefined
          ? { cdpSessionId: cdpFrame.cdpSessionId }
          : {}),
      });

    if (!frameEpoch) continue;

    const owners = cdpEpochOwners.get(frameEpoch);
    if (owners) owners.push(cdpFrame);
    else cdpEpochOwners.set(frameEpoch, [cdpFrame]);
  }

  for (const [frameEpoch, webFrameIds] of webFramesByEpoch) {
    const cdpCandidates =
      cdpEpochOwners.get(frameEpoch) ?? [];

    if (webFrameIds.length !== 1) {
      warnings.push(
        "frameEpoch 在 webNavigation frame 中非唯一，拒绝猜测映射: " +
          frameEpoch,
      );
      continue;
    }

    if (cdpCandidates.length !== 1) {
      if (cdpCandidates.length > 1) {
        warnings.push(
          "frameEpoch 在 CDP session/frame 中非唯一，拒绝猜测映射: " +
            frameEpoch,
        );
      }
      continue;
    }

    const webFrameId = webFrameIds[0]!;
    const cdpCandidate = cdpCandidates[0]!;
    const documentEpoch =
      documentEpochByWebFrame.get(webFrameId);

    if (!documentEpoch) {
      warnings.push(
        "documentEpoch 不可用，拒绝建立 CDP mapping: " +
          webFrameId,
      );
      continue;
    }

    mappingByWebFrame.set(webFrameId, {
      webFrameId,
      cdpFrameId: cdpCandidate.cdpFrameId,
      ...(cdpCandidate.cdpSessionId !== undefined
        ? { cdpSessionId: cdpCandidate.cdpSessionId }
        : {}),
      frameEpoch,
      documentEpoch,
    });
    mappedCdpFrames.add(candidateKey(cdpCandidate));
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
    unmappedCdpFrameIds: [
      ...new Set(
        cdpFrames
          .filter(
            (candidate) =>
              !mappedCdpFrames.has(candidateKey(candidate)),
          )
          .map((candidate) => candidate.cdpFrameId),
      ),
    ],
    warnings,
  };
}
