export interface PrepareStrictClickRequest {
  type: "execution.prepare-strict-click";
  requestId: string;
  tabId: number;
  actionId: string;
  observedRevision: string;
  ref: string;
}

export type PrepareStrictClickResponse =
  | {
      type: "execution.prepare-strict-click.result";
      requestId: string;
      ok: true;
      prepared: {
        ref: string;
        point: {
          x: number;
          y: number;
        };
      };
    }
  | {
      type: "execution.prepare-strict-click.result";
      requestId: string;
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export function isPrepareStrictClickRequest(
  value: unknown,
): value is PrepareStrictClickRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    candidate.type === "execution.prepare-strict-click" &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    typeof candidate.tabId === "number" &&
    Number.isInteger(candidate.tabId) &&
    candidate.tabId >= 0 &&
    typeof candidate.actionId === "string" &&
    candidate.actionId.length > 0 &&
    typeof candidate.observedRevision === "string" &&
    candidate.observedRevision.length > 0 &&
    typeof candidate.ref === "string" &&
    candidate.ref.length > 0
  );
}
