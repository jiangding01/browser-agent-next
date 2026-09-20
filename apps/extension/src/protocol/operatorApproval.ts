export type OperatorApprovalUiRequest =
  | {
      type:
        "operator-approval.list";
      requestId: string;
    }
  | {
      type:
        "operator-approval.approve";
      requestId: string;
      approvalRequestId: string;
    }
  | {
      type:
        "operator-approval.reject";
      requestId: string;
      approvalRequestId: string;
    };

export type OperatorApprovalUiResponse =
  | {
      type:
        "operator-approval.result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type:
        "operator-approval.result";
      requestId: string;
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

function boundedString(
  value: unknown,
  max = 256,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max
  );
}

function hasOnlyKeys(
  record:
    Record<string, unknown>,
  allowed:
    readonly string[],
): boolean {
  const keys = new Set(allowed);

  return Object.keys(record)
    .every(
      (key) => keys.has(key),
    );
}

export function
isOperatorApprovalUiRequest(
  value: unknown,
): value is OperatorApprovalUiRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const request =
    value as
      Record<string, unknown>;

  if (
    !boundedString(
      request.requestId,
    )
  ) {
    return false;
  }

  switch (request.type) {
    case "operator-approval.list":
      return hasOnlyKeys(
        request,
        ["type", "requestId"],
      );

    case "operator-approval.approve":
    case "operator-approval.reject":
      return (
        hasOnlyKeys(
          request,
          [
            "type",
            "requestId",
            "approvalRequestId",
          ],
        ) &&
        boundedString(
          request.approvalRequestId,
        )
      );

    default:
      return false;
  }
}
