import type {
  ElementCapability,
  ElementState,
} from "@browser-agent-next/core";
import {
  identityKey,
  type StrongIdentity,
} from "@browser-agent-next/refs";
import type {
  PerceptionElementCandidate,
  PerceptionSourceKind,
} from "./types.js";

export interface MergedPerceptionElement {
  identities: StrongIdentity[];
  kind: PerceptionElementCandidate["kind"];
  semantic: ElementState["semantic"];
  state: ElementState["state"];
  value?: ElementState["value"];
  geometry?: ElementState["geometry"];
  component?: ElementState["component"];
  frameId: string;
  capabilities: ElementCapability[];
  provenance: ElementState["provenance"];
}

function firstDefined<T>(
  candidates: readonly PerceptionElementCandidate[],
  priority: readonly PerceptionSourceKind[],
  selector: (candidate: PerceptionElementCandidate) => T | undefined,
): T | undefined {
  for (const source of priority) {
    for (const candidate of candidates) {
      if (candidate.source !== source) continue;
      const value = selector(candidate);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function mergeCapabilities(
  candidates: readonly PerceptionElementCandidate[],
): ElementCapability[] {
  const byKey = new Map<string, ElementCapability>();

  for (const candidate of candidates) {
    for (const capability of candidate.capabilities ?? []) {
      const key = JSON.stringify(capability);
      if (!byKey.has(key)) byKey.set(key, capability);
    }
  }

  return [...byKey.values()];
}

function groupKey(candidate: PerceptionElementCandidate): string {
  // Cross-source merge is only allowed through an explicit strong merge key.
  // Otherwise each strong identity remains distinct even when visible
  // semantics look identical.
  return candidate.mergeKey ?? "identity:" + identityKey(candidate.identity);
}

export function mergePerceptionCandidates(
  input: readonly PerceptionElementCandidate[],
): MergedPerceptionElement[] {
  const groups = new Map<string, PerceptionElementCandidate[]>();

  for (const candidate of input) {
    const key = groupKey(candidate);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  const result: MergedPerceptionElement[] = [];

  for (const candidates of groups.values()) {
    const kinds = new Set(candidates.map((candidate) => candidate.kind));
    const frames = new Set(candidates.map((candidate) => candidate.frameId));

    if (kinds.has("content") && kinds.size > 1) {
      throw new Error(
        "cannot merge content candidates with actionable element/field candidates",
      );
    }
    if (frames.size !== 1) {
      throw new Error("cannot merge perception candidates across frames");
    }

    const role = firstDefined(
      candidates,
      ["ax", "dom", "adapter"],
      (candidate) => candidate.semantic.role,
    );

    if (!role) {
      throw new Error("merged perception element requires a semantic role");
    }

    const visible = firstDefined(
      candidates,
      ["dom", "adapter", "ax"],
      (candidate) => candidate.state?.visible,
    );
    const enabled = firstDefined(
      candidates,
      ["dom", "adapter", "ax"],
      (candidate) => candidate.state?.enabled,
    );
    const focused = firstDefined(
      candidates,
      ["dom", "ax", "adapter"],
      (candidate) => candidate.state?.focused,
    );

    if (visible === undefined || enabled === undefined || focused === undefined) {
      throw new Error(
        "merged perception element requires visible/enabled/focused state",
      );
    }

    const name = firstDefined(
      candidates,
      ["ax", "dom", "adapter"],
      (candidate) => candidate.semantic.name,
    );
    const description = firstDefined(
      candidates,
      ["ax", "dom", "adapter"],
      (candidate) => candidate.semantic.description,
    );
    const text = firstDefined(
      candidates,
      ["dom", "ax", "adapter"],
      (candidate) => candidate.semantic.text,
    );

    const semantic: ElementState["semantic"] = {
      role,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(text !== undefined ? { text } : {}),
    };

    const state: ElementState["state"] = {
      visible,
      enabled,
      focused,
    };

    const stateKeys = [
      "selected",
      "checked",
      "expanded",
      "pressed",
      "required",
      "readonly",
      "sensitive",
    ] as const;

    for (const key of stateKeys) {
      const value = firstDefined(
        candidates,
        ["dom", "adapter", "ax"],
        (candidate) => candidate.state?.[key],
      );
      if (value !== undefined) {
        (state as Record<string, unknown>)[key] = value;
      }
    }

    const value = firstDefined(
      candidates,
      ["adapter", "dom", "ax"],
      (candidate) => candidate.value,
    );
    const geometry = firstDefined(
      candidates,
      ["dom", "ax", "adapter"],
      (candidate) => candidate.geometry,
    );
    const component = firstDefined(
      candidates,
      ["adapter", "dom", "ax"],
      (candidate) => candidate.component,
    );

    const sources = new Set(candidates.map((candidate) => candidate.source));

    const kind = kinds.has("field")
      ? "field"
      : candidates[0]!.kind;

    result.push({
      identities: candidates.map((candidate) => candidate.identity),
      kind,
      semantic,
      state,
      ...(value !== undefined ? { value } : {}),
      ...(geometry !== undefined ? { geometry } : {}),
      ...(component !== undefined ? { component } : {}),
      frameId: candidates[0]!.frameId,
      capabilities: mergeCapabilities(candidates),
      provenance: {
        ...(sources.has("ax") ? { ax: true } : {}),
        ...(sources.has("dom") ? { dom: true } : {}),
        ...(sources.has("adapter") ? { adapter: "perception-adapter" } : {}),
      },
    });
  }

  return result;
}
