import type {
  FrameState,
} from "@browser-agent-next/core";
import { DOM_IDENTITY_BRIDGE_KEY } from "../../protocol/identityBridge.js";
import type {
  ChromeDebuggerReadTransport,
  RuntimeExecutionContextBinding,
} from "../chrome/chromeDebuggerTransport.js";
import type {
  ObservedFrameBinding,
  ObservedFrameBindingLookup,
} from "../chrome/domLifecycleRegistry.js";

export interface ProjectedClickPoint {
  x: number;
  y: number;
}

export type ChildFrameCoordinateProjection =
  | {
      ok: true;
      point: ProjectedClickPoint;
      rootFrameOwnerBackendNodeId: number;
    }
  | {
      ok: false;
      reason: string;
    };

export interface ProjectChildFramePointInput {
  tabId: number;
  targetFrameId: string;
  point: ProjectedClickPoint;
  frames: readonly FrameState[];
}

export interface ChildFrameClickPointProjector {
  project(
    input: ProjectChildFramePointInput,
  ): Promise<ChildFrameCoordinateProjection>;
}

interface RuntimeValueResult {
  result: {
    objectId?: string;
    value?: unknown;
  };
  exceptionDetails?: unknown;
}

interface FrameRuntimeSnapshot {
  contextId: number;
  width: number;
  height: number;
}

interface DomFrameOwnerResult {
  backendNodeId?: number;
}

interface DomBoxModelResult {
  model?: {
    content?: number[];
  };
}

interface DomResolveNodeResult {
  object: {
    objectId?: string;
  };
}

function finitePoint(
  point: ProjectedClickPoint,
): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
}

function boundedReason(
  error: unknown,
): string {
  return (
    error instanceof Error
      ? error.message
      : "coordinate projection failed"
  ).slice(0, 300);
}

function completeBinding(
  binding: ObservedFrameBinding | undefined,
): binding is ObservedFrameBinding & {
  cdpFrameId: string;
  documentEpoch: string;
} {
  return (
    binding !== undefined &&
    typeof binding.cdpFrameId === "string" &&
    binding.cdpFrameId.length > 0 &&
    typeof binding.documentEpoch === "string" &&
    binding.documentEpoch.length > 0
  );
}

function pointFromQuad(
  point: ProjectedClickPoint,
  viewport: {
    width: number;
    height: number;
  },
  quad: readonly number[],
): ChildFrameCoordinateProjection {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height)
  ) {
    return {
      ok: false,
      reason: "child frame viewport is invalid",
    };
  }

  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x > viewport.width ||
    point.y > viewport.height
  ) {
    return {
      ok: false,
      reason: "child click point is outside the live frame viewport",
    };
  }

  if (
    quad.length !== 8 ||
    quad.some((value) => !Number.isFinite(value))
  ) {
    return {
      ok: false,
      reason: "frame owner content quad is invalid",
    };
  }

  const p0 = { x: quad[0]!, y: quad[1]! };
  const p1 = { x: quad[2]!, y: quad[3]! };
  const p2 = { x: quad[4]!, y: quad[5]! };
  const p3 = { x: quad[6]!, y: quad[7]! };

  const residualX =
    p0.x + p2.x - p1.x - p3.x;
  const residualY =
    p0.y + p2.y - p1.y - p3.y;

  // CSS 2D rotate/scale/skew 仍保持平行四边形；透视/3D transform
  // 不能用简单 affine viewport projection，必须 fail closed。
  if (
    Math.abs(residualX) > 1 ||
    Math.abs(residualY) > 1
  ) {
    return {
      ok: false,
      reason:
        "frame owner content quad is not affine; perspective projection is unsupported",
    };
  }

  const edgeX = {
    x: p1.x - p0.x,
    y: p1.y - p0.y,
  };
  const edgeY = {
    x: p3.x - p0.x,
    y: p3.y - p0.y,
  };
  const area =
    Math.abs(
      edgeX.x * edgeY.y -
      edgeX.y * edgeY.x,
    );

  if (area < 1e-4) {
    return {
      ok: false,
      reason: "frame owner content quad is degenerate",
    };
  }

  const u = point.x / viewport.width;
  const v = point.y / viewport.height;

  return {
    ok: true,
    point: {
      x:
        p0.x +
        u * edgeX.x +
        v * edgeY.x,
      y:
        p0.y +
        u * edgeX.y +
        v * edgeY.y,
    },
    // Caller replaces this while walking the chain.
    rootFrameOwnerBackendNodeId: -1,
  };
}

/**
 * 把 child frame viewport-local point 严格投影到 top-level viewport。
 *
 * Identity 来源只有：
 * - retained observation 的 parentFrameId/documentEpoch；
 * - lifecycle 中由 frameEpoch exact mapping 得到的 cdpFrameId/sessionId；
 * - 对应 session 中 live isolated-world frameEpoch。
 *
 * URL、frame 顺序、名称、几何相似度都不参与 identity mapping。
 */
export class ChildFrameCoordinateProjector
  implements ChildFrameClickPointProjector
{
  constructor(
    private readonly transport:
      ChromeDebuggerReadTransport,
    private readonly bindings:
      ObservedFrameBindingLookup,
  ) {}

  async project(
    input: ProjectChildFramePointInput,
  ): Promise<ChildFrameCoordinateProjection> {
    if (
      input.targetFrameId === "web:0" ||
      !finitePoint(input.point)
    ) {
      return {
        ok: false,
        reason:
          input.targetFrameId === "web:0"
            ? "child frame projector requires a non-root target"
            : "child click point is invalid",
      };
    }

    const byFrame = new Map(
      input.frames.map((frame) => [
        frame.frameId,
        frame,
      ]),
    );
    let current =
      byFrame.get(input.targetFrameId);

    if (!current || !current.accessible) {
      return {
        ok: false,
        reason:
          "target frame is absent or inaccessible",
      };
    }

    let point = { ...input.point };
    let rootFrameOwnerBackendNodeId:
      number | undefined;
    const visited = new Set<string>();

    try {
      for (let depth = 0; depth < 32; depth += 1) {
        if (current.frameId === "web:0") {
          break;
        }

        if (visited.has(current.frameId)) {
          return {
            ok: false,
            reason:
              "frame parent chain contains a cycle",
          };
        }
        visited.add(current.frameId);

        const parentFrameId =
          current.parentFrameId;
        if (!parentFrameId) {
          return {
            ok: false,
            reason:
              "child frame has no parent in retained observation",
          };
        }

        const parent =
          byFrame.get(parentFrameId);
        if (!parent || !parent.accessible) {
          return {
            ok: false,
            reason:
              "parent frame is absent or inaccessible",
          };
        }

        const childBinding =
          this.bindings.bindingForFrame(
            input.tabId,
            current.frameId,
          );
        const parentBinding =
          this.bindings.bindingForFrame(
            input.tabId,
            parent.frameId,
          );

        if (
          !completeBinding(childBinding) ||
          !completeBinding(parentBinding)
        ) {
          return {
            ok: false,
            reason:
              "exact frame binding is unavailable for projection chain",
          };
        }

        if (
          childBinding.documentEpoch !==
            current.documentEpoch ||
          parentBinding.documentEpoch !==
            parent.documentEpoch
        ) {
          return {
            ok: false,
            reason:
              "projection chain document binding is stale",
          };
        }

        const childRuntime =
          await this.frameRuntimeSnapshot(
            input.tabId,
            childBinding,
          );

        if (!childRuntime) {
          return {
            ok: false,
            reason:
              "live child viewport identity is unavailable",
          };
        }

        const owner =
          await this.sendForSession<DomFrameOwnerResult>(
            input.tabId,
            parentBinding.cdpSessionId,
            "DOM.getFrameOwner",
            {
              frameId:
                childBinding.cdpFrameId,
            },
          );

        if (
          !Number.isInteger(
            owner.backendNodeId,
          ) ||
          owner.backendNodeId! <= 0
        ) {
          return {
            ok: false,
            reason:
              "frame owner backend node is unavailable",
          };
        }

        const box =
          await this.sendForSession<DomBoxModelResult>(
            input.tabId,
            parentBinding.cdpSessionId,
            "DOM.getBoxModel",
            {
              backendNodeId:
                owner.backendNodeId,
            },
          );

        const projected = pointFromQuad(
          point,
          {
            width: childRuntime.width,
            height: childRuntime.height,
          },
          box.model?.content ?? [],
        );

        if (!projected.ok) {
          return projected;
        }

        point = projected.point;

        const parentRuntime =
          await this.frameRuntimeSnapshot(
            input.tabId,
            parentBinding,
          );

        if (!parentRuntime) {
          return {
            ok: false,
            reason:
              "live parent viewport identity is unavailable",
          };
        }

        if (
          point.x < 0 ||
          point.y < 0 ||
          point.x > parentRuntime.width ||
          point.y > parentRuntime.height
        ) {
          return {
            ok: false,
            reason:
              "projected point is outside the live parent frame viewport",
          };
        }

        const ownerHit =
          await this.frameOwnerHitTest({
            tabId: input.tabId,
            binding: parentBinding,
            contextId:
              parentRuntime.contextId,
            backendNodeId:
              owner.backendNodeId,
            point,
          });

        if (!ownerHit) {
          return {
            ok: false,
            reason:
              "parent hit-test no longer reaches the projected frame owner",
          };
        }

        if (parent.frameId === "web:0") {
          rootFrameOwnerBackendNodeId =
            owner.backendNodeId;
        }

        current = parent;
      }

      if (
        current.frameId !== "web:0" ||
        rootFrameOwnerBackendNodeId ===
          undefined
      ) {
        return {
          ok: false,
          reason:
            "projection chain did not reach the root frame",
        };
      }

      return {
        ok: true,
        point,
        rootFrameOwnerBackendNodeId,
      };
    } catch (error) {
      return {
        ok: false,
        reason:
          "coordinate projection failed: " +
          boundedReason(error),
      };
    }
  }

  private async frameRuntimeSnapshot(
    tabId: number,
    binding:
      ObservedFrameBinding & {
        cdpFrameId: string;
        documentEpoch: string;
      },
  ): Promise<FrameRuntimeSnapshot | undefined> {
    const candidates =
      this.transport
        .contextBindingsForFrame(
          tabId,
          binding.cdpFrameId,
        )
        .filter(
          (candidate) =>
            candidate.sessionId ===
              binding.cdpSessionId &&
            candidate.context.auxData
              ?.isDefault !== true,
        );

    const matches:
      FrameRuntimeSnapshot[] = [];

    for (const candidate of candidates) {
      const result =
        await this.sendForBinding<RuntimeValueResult>(
          tabId,
          candidate,
          "Runtime.evaluate",
          {
            expression:
              "(() => {" +
              "const bridge = globalThis[" +
              JSON.stringify(
                DOM_IDENTITY_BRIDGE_KEY,
              ) +
              "];" +
              "if (!bridge || bridge.version !== 1 || bridge.frameEpoch !== " +
              JSON.stringify(
                binding.frameEpoch,
              ) +
              ") return null;" +
              "return {width: innerWidth, height: innerHeight};" +
              "})()",
            contextId:
              candidate.context.id,
            returnByValue: true,
            silent: true,
          },
        );

      const value =
        result.result.value as
          | {
              width?: unknown;
              height?: unknown;
            }
          | null
          | undefined;

      if (
        result.exceptionDetails ||
        !value ||
        typeof value.width !== "number" ||
        typeof value.height !== "number" ||
        !Number.isFinite(value.width) ||
        !Number.isFinite(value.height) ||
        value.width <= 0 ||
        value.height <= 0
      ) {
        continue;
      }

      matches.push({
        contextId:
          candidate.context.id,
        width: value.width,
        height: value.height,
      });
    }

    return matches.length === 1
      ? matches[0]
      : undefined;
  }

  private async frameOwnerHitTest(input: {
    tabId: number;
    binding:
      ObservedFrameBinding & {
        cdpFrameId: string;
        documentEpoch: string;
      };
    contextId: number;
    backendNodeId: number;
    point: ProjectedClickPoint;
  }): Promise<boolean> {
    const objectGroup =
      "browser-agent-next-projection:t" +
      input.tabId +
      ":" +
      Date.now().toString(36);

    try {
      const resolved =
        await this.sendForSession<DomResolveNodeResult>(
          input.tabId,
          input.binding.cdpSessionId,
          "DOM.resolveNode",
          {
            backendNodeId:
              input.backendNodeId,
            executionContextId:
              input.contextId,
            objectGroup,
          },
        );

      const objectId =
        resolved.object.objectId;
      if (!objectId) return false;

      const result =
        await this.sendForSession<RuntimeValueResult>(
          input.tabId,
          input.binding.cdpSessionId,
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration:
              "function(x,y){" +
              "const hit=document.elementFromPoint(x,y);" +
              "return !!hit && (hit===this || this.contains(hit));" +
              "}",
            arguments: [
              { value: input.point.x },
              { value: input.point.y },
            ],
            objectGroup,
            returnByValue: true,
            silent: true,
          },
        );

      return (
        !result.exceptionDetails &&
        result.result.value === true
      );
    } finally {
      try {
        await this.sendForSession(
          input.tabId,
          input.binding.cdpSessionId,
          "Runtime.releaseObjectGroup",
          { objectGroup },
        );
      } catch {
        // 仅回收临时 remote object。
      }
    }
  }

  private sendForBinding<T>(
    tabId: number,
    binding:
      RuntimeExecutionContextBinding,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return this.sendForSession<T>(
      tabId,
      binding.sessionId,
      method,
      params,
    );
  }

  private sendForSession<T>(
    tabId: number,
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return sessionId === undefined
      ? this.transport.send<T>(
          tabId,
          method,
          params,
        )
      : this.transport.sendInSession<T>(
          tabId,
          sessionId,
          method,
          params,
        );
  }
}
