// 单测辅助：observation 构造与脚本化的假 System One 响应。不从包入口导出。
import type {
  BrowserObservation,
  ElementState,
} from "@browser-agent-next/core";
import type { CandidateSet } from "@browser-agent-next/router";

export function button(
  ref: string,
  name: string,
  options: {
    description?: string;
    text?: string;
    role?: string;
    frameId?: string;
    hitTestable?: boolean;
    inViewport?: boolean;
    value?: string;
  } = {},
): ElementState {
  return {
    ref,
    kind: "element",
    semantic: {
      role: options.role ?? "button",
      name,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.text !== undefined ? { text: options.text } : {}),
    },
    state: { visible: true, enabled: true, focused: false },
    ...(options.value !== undefined
      ? { value: { kind: "text" as const, display: options.value } }
      : {}),
    geometry: {
      rect: { x: 10, y: 10, width: 100, height: 30 },
      inViewport: options.inViewport ?? true,
      ...(options.hitTestable !== undefined ? { hitTestable: options.hitTestable } : {}),
    },
    frameId: options.frameId ?? "main",
    capabilities: [{ kind: "click" }],
    provenance: { ax: true, dom: true },
  };
}

export function observation(
  elements: ElementState[],
  options: Partial<
    Pick<BrowserObservation, "forms" | "dialogs" | "overlays" | "frames">
  > & { revision?: string; url?: string } = {},
): BrowserObservation {
  const url = options.url ?? "https://shop.test/cart?session=SECRET-URL";
  return {
    schemaVersion: 1,
    tab: { tabId: 7, title: "SECRET-TITLE", url, origin: new URL(url).origin, ownedBySession: true },
    revision: {
      id: options.revision ?? "rev-1",
      stateEpoch: "s",
      documentEpoch: "d",
      sequence: 1,
    },
    scope: { kind: "page" },
    coverage: {
      actionable: { status: "complete", returned: elements.length, totalKnown: elements.length },
      forms: { status: "complete", returned: 0, totalKnown: 0 },
      text: { status: "unknown", returned: 0 },
      frames: { discovered: 1, accessible: 1, degraded: [] },
      shadowDom: { openRootsCovered: true, closedRootsUnknown: true },
      canvas: { present: false, semanticallyCovered: true },
    },
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, scrollWidth: 1280, scrollHeight: 720 },
    frames: options.frames ?? [{ frameId: "main", documentEpoch: "d", accessible: true }],
    elements,
    ...(options.forms !== undefined ? { forms: options.forms } : {}),
    ...(options.dialogs !== undefined ? { dialogs: options.dialogs } : {}),
    ...(options.overlays !== undefined ? { overlays: options.overlays } : {}),
  };
}

export function candidates(
  refs: string[],
  coverage: CandidateSet["coverage"] = "complete",
): CandidateSet {
  return { refs, coverage, totalKnown: refs.length };
}

export interface SentRequest {
  url: string;
  init: RequestInit;
  body: {
    model: string;
    state: { page: Record<string, unknown>; elements: Array<Record<string, unknown>> };
    questions: Record<string, { type: string; criteria?: Record<string, string>; instructions: unknown }>;
  };
}

export interface ScriptedAnswers {
  /** operation 的概率；默认 click 0.9。 */
  operation?: Partial<Record<"escalate" | "handoff_form" | "handoff_verify" | "click", number>>;
  hasTarget?: number;
  /** 按元素 name 选 target；两序可分别指定。 */
  forward?: { name: string; p?: number };
  reverse?: { name: string; p?: number };
}

function choiceAnswer(options: string[], probabilities: Record<string, number>) {
  let best = options[0]!;
  for (const option of options) {
    if ((probabilities[option] ?? 0) > (probabilities[best] ?? 0)) best = option;
  }
  const full = Object.fromEntries(options.map((option) => [option, probabilities[option] ?? 0]));
  const n = options.length;
  const pmax = full[best]!;
  return {
    type: "choice",
    choice: best,
    confidence: n === 1 ? 1 : Math.max(0, (pmax - 1 / n) / (1 - 1 / n)),
    probabilities: full,
  };
}

function spread(options: string[], winner: string | undefined, p: number): Record<string, number> {
  if (winner === undefined) return {};
  const rest = options.filter((option) => option !== winner);
  return Object.fromEntries([
    [winner, p],
    ...rest.map((option) => [option, rest.length === 0 ? 0 : (1 - p) / rest.length]),
  ]);
}

/** 按发出的请求构造合法响应。 */
export function scriptedResponse(body: SentRequest["body"], script: ScriptedAnswers = {}) {
  const labelOf = (name: string) =>
    body.state.elements.find((element) => element.name === name)?.id as string | undefined;
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: script.hasTarget ?? 0.9 };
      continue;
    }
    const options = Object.keys(question.criteria!);
    if (id === "operation") {
      const probabilities = script.operation ?? { click: 0.9, escalate: 0.1 };
      answers[id] = choiceAnswer(options, probabilities);
      continue;
    }
    const pick = id === "target_forward" ? script.forward : script.reverse ?? script.forward;
    const winner = pick === undefined ? options[0] : labelOf(pick.name);
    answers[id] = choiceAnswer(options, spread(options, winner, pick?.p ?? 0.9));
  }
  return { model: "jev-1.14.0", answers, usage: { input_tokens: 123, output_tokens: 0 } };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 记录请求并按 handler 返回响应的假 fetch。 */
export function fakeFetch(
  handler: (request: SentRequest) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: SentRequest[] } {
  const requests: SentRequest[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const request: SentRequest = {
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body)),
    };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetch: impl, requests };
}
