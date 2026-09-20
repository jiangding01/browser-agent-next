import type {
  OperatorApprovalSummary,
} from "../background/execution/operatorApprovalStore.js";
import type {
  OperatorApprovalUiResponse,
} from "../protocol/operatorApproval.js";

declare const chrome: {
  runtime: {
    sendMessage(
      message: unknown,
    ): Promise<
      OperatorApprovalUiResponse
    >;
  };
};

const list =
  document.querySelector(
    "#approval-list",
  );
const empty =
  document.querySelector(
    "#empty-state",
  );
const refresh =
  document.querySelector(
    "#refresh",
  );

function requestId(): string {
  if (
    typeof crypto.randomUUID ===
    "function"
  ) {
    return (
      "ui-" +
      crypto.randomUUID()
    );
  }

  return (
    "ui-" +
    Date.now().toString(36) +
    "-" +
    Math.random()
      .toString(36)
      .slice(2)
  );
}

function showError(
  error: unknown,
): void {
  if (!empty) return;

  empty.removeAttribute(
    "hidden",
  );
  empty.textContent =
    error instanceof Error
      ? error.message
      : "审批操作失败";
}

async function call(
  message: unknown,
): Promise<unknown> {
  const response =
    await chrome.runtime
      .sendMessage(message);

  if (!response.ok) {
    throw new Error(
      response.error.message,
    );
  }

  return response.result;
}

function button(
  label: string,
  className: string,
  onClick:
    () => Promise<void>,
): HTMLButtonElement {
  const element =
    document.createElement(
      "button",
    );

  element.type = "button";
  element.textContent = label;
  element.className =
    className;

  element.addEventListener(
    "click",
    () => {
      element.disabled = true;

      void onClick()
        .catch(showError)
        .finally(() => {
          element.disabled =
            false;
        });
    },
  );

  return element;
}

function render(
  approvals:
    OperatorApprovalSummary[],
): void {
  if (!list || !empty) {
    return;
  }

  list.textContent = "";
  empty.textContent =
    "当前没有待审批动作。";
  empty.toggleAttribute(
    "hidden",
    approvals.length > 0,
  );

  for (
    const approval
    of approvals
  ) {
    const item =
      document.createElement(
        "article",
      );
    item.className =
      "approval-card";

    const title =
      document.createElement(
        "h2",
      );
    title.textContent =
      approval.targetName ||
      approval.targetRole;

    const origin =
      document.createElement(
        "div",
      );
    origin.className =
      "origin";
    origin.textContent =
      approval.origin;

    const detail =
      document.createElement(
        "p",
      );
    detail.textContent =
      approval.pageTitle +
      " · " +
      approval.targetRole +
      " · " +
      approval.ref;

    const actions =
      document.createElement(
        "div",
      );
    actions.className =
      "actions";

    actions.append(
      button(
        "拒绝",
        "secondary",
        async () => {
          await call({
            type:
              "operator-approval.reject",
            requestId:
              requestId(),
            approvalRequestId:
              approval
                .approvalRequestId,
          });
          await load();
        },
      ),
      button(
        "批准一次",
        "primary",
        async () => {
          await call({
            type:
              "operator-approval.approve",
            requestId:
              requestId(),
            approvalRequestId:
              approval
                .approvalRequestId,
          });
          await load();
        },
      ),
    );

    item.append(
      title,
      origin,
      detail,
      actions,
    );

    list.append(item);
  }
}

async function load(): Promise<void> {
  try {
    const result =
      await call({
        type:
          "operator-approval.list",
        requestId:
          requestId(),
      });

    render(
      Array.isArray(result)
        ? result as
            OperatorApprovalSummary[]
        : [],
    );
  } catch (error) {
    showError(error);
  }
}

refresh?.addEventListener(
  "click",
  () => {
    void load();
  },
);

void load();
