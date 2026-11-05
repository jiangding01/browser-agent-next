import {
  effectiveFrameUrl,
  type BrowserObservation,
  type ElementState,
  type Ref,
} from "@browser-agent-next/core";
import { exactKey, looseKey } from "./nameMatch.js";
import { parseStepIntent, type StepIntent } from "./stepIntent.js";

export type DeferReason =
  | "no-intent"
  | "opaque-origin"
  | "coverage-incomplete"
  | "blocking-overlay"
  | "no-match"
  | "ambiguous"
  | "target-disabled"
  | "target-not-clickable"
  | "target-occluded"
  | "target-out-of-viewport"
  | "invalid-observation";

export type RouteResult =
  | { route: "resolved"; operation: "CLICK"; ref: Ref; rule: "unique-exact-name" }
  | { route: "defer"; reason: DeferReason };

export interface RouteStepInput {
  observation: BrowserObservation;
  intent?: StepIntent;
}

/** DOM 源的名称截断长度：原文达到它的名称可能被截断，不参与匹配。 */
export const ELEMENT_NAME_TRUNCATION_LENGTH = 240;

function defer(reason: DeferReason): RouteResult {
  return { route: "defer", reason };
}

/**
 * 完整性闸门（不变量 158）：唯一性需要“看全了”才能证明，
 * 任何表示可能没看全的信号都单独 fail closed。
 */
function isProvablyComplete(observation: BrowserObservation): boolean {
  const { coverage } = observation;
  return (
    observation.scope.kind === "page" &&
    coverage.actionable.status === "complete" &&
    coverage.shadowDom.openRootsCovered === true &&
    coverage.frames.degraded.length === 0 &&
    observation.frames.every((frame) => frame.accessible === true)
  );
}

function hasBlockingLayer(observation: BrowserObservation): boolean {
  return (
    (observation.overlays ?? []).some((overlay) => overlay.blocking) ||
    (observation.dialogs ?? []).some((dialog) => dialog.modal)
  );
}

/**
 * frame 的 origin 是否要经过 about:blank 才能推出。
 *
 * about:blank 的真实 origin 来自发起导航的一方：跨源 frame 可以把同源的兄弟 frame
 * 导航到 about:blank 再写入内容，此时它与父 frame 并不同源，observation 无法证明。
 * about:srcdoc 的内容只能由父文档经 srcdoc 属性写入，继承父 frame 是成立的。
 */
function inheritsThroughAboutBlank(
  frames: ReadonlyMap<string, BrowserObservation["frames"][number]>,
  frameId: string,
): boolean {
  const seen = new Set<string>();
  let current = frames.get(frameId);
  while (current && !seen.has(current.frameId)) {
    seen.add(current.frameId);
    if (current.url === "about:blank") return true;
    if (current.url !== "about:srcdoc" || current.parentFrameId === undefined) {
      return false;
    }
    current = frames.get(current.parentFrameId);
  }
  return false;
}

/** 元素所在 frame 的有效 origin；无法判定（opaque、经 about:blank 推出、无法解析）时为 undefined。 */
function frameOriginResolver(
  observation: BrowserObservation,
): (frameId: string) => string | undefined {
  const frames = new Map(observation.frames.map((frame) => [frame.frameId, frame]));
  const cache = new Map<string, string | undefined>();
  return (frameId) => {
    if (cache.has(frameId)) return cache.get(frameId);
    let origin: string | undefined;
    const url = inheritsThroughAboutBlank(frames, frameId)
      ? undefined
      : effectiveFrameUrl(observation, frameId);
    if (url !== undefined) {
      try {
        const parsed = new URL(url).origin;
        origin = parsed === "null" ? undefined : parsed;
      } catch {
        origin = undefined;
      }
    }
    cache.set(frameId, origin);
    return origin;
  };
}

function safeIntent(intent: unknown): StepIntent | undefined {
  if (intent === undefined) return undefined;
  try {
    return parseStepIntent(intent);
  } catch {
    return undefined;
  }
}

/**
 * 确定性解析一步（docs/DETERMINISTIC-ROUTER.md「routeStep」）。
 *
 * 只在可证明唯一时返回 CLICK，其余一律 defer 给下一层；结果不是授权（不变量 156）。
 * 不解析自然语言（不变量 157），作用域默认是顶层 tab origin（不变量 159）。
 * 不抛错：trusted client 不校验 observation 的全部字段形态，形态不符时 defer。
 */
export function routeStep(input: RouteStepInput): RouteResult {
  try {
    return routeWellFormedStep(input);
  } catch {
    return defer("invalid-observation");
  }
}

function routeWellFormedStep(input: RouteStepInput): RouteResult {
  const intent = safeIntent(input.intent);
  if (intent === undefined) return defer("no-intent");

  const { observation } = input;
  if (observation.tab.origin === "null") return defer("opaque-origin");
  if (!isProvablyComplete(observation)) return defer("coverage-incomplete");
  if (hasBlockingLayer(observation)) return defer("blocking-overlay");

  const scopeOrigin = intent.target.frameOrigin ?? observation.tab.origin;
  const originOf = frameOriginResolver(observation);
  const targetExact = exactKey(intent.target.name);
  const targetLoose = looseKey(intent.target.name);

  const matches: ElementState[] = [];
  let ambiguous = false;

  for (const element of observation.elements) {
    const name = element.semantic.name;
    if (name === undefined || name.length >= ELEMENT_NAME_TRUNCATION_LENGTH) continue;
    if (element.state.visible !== true) continue;
    if (
      intent.target.role !== undefined &&
      element.semantic.role !== intent.target.role
    ) {
      continue;
    }

    const exact = exactKey(name) === targetExact;
    const lookalike = !exact && looseKey(name) === targetLoose;
    if (!exact && !lookalike) continue;

    const origin = originOf(element.frameId);
    if (origin === undefined) {
      // origin 无法判定的同名元素可能就在作用域内。
      ambiguous = true;
      continue;
    }
    if (origin !== scopeOrigin) continue;

    if (lookalike || element.provenance.dom !== true) {
      // 页面上看起来同名，或可见性无法证明（AX-only）。
      ambiguous = true;
      continue;
    }
    matches.push(element);
  }

  if (matches.length >= 2 || ambiguous) return defer("ambiguous");

  const [target] = matches;
  if (target === undefined) return defer("no-match");
  if (!target.state.enabled) return defer("target-disabled");
  if (!target.capabilities.some((capability) => capability.kind === "click")) {
    return defer("target-not-clickable");
  }
  if (target.geometry?.hitTestable === false) return defer("target-occluded");
  if (target.geometry?.inViewport === false) return defer("target-out-of-viewport");

  return {
    route: "resolved",
    operation: "CLICK",
    ref: target.ref,
    rule: "unique-exact-name",
  };
}
