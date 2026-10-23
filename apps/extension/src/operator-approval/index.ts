import type {
  OperatorApprovalSummary,
} from "../background/execution/operatorApprovalStore.js";
import type {
  OperatorApprovalUiResponse,
} from "../protocol/operatorApproval.js";
import {
  type CardState,
  formatRemaining,
  planCardUpdate,
  shortCode,
  untrustedDisplayText,
} from "./display.js";

declare const chrome: {
  runtime: {
    sendMessage(
      message: unknown,
    ): Promise<
      OperatorApprovalUiResponse | undefined
    >;
  };
};

const REFRESH_INTERVAL_MS = 2_000;
const TICK_INTERVAL_MS = 250;
const STALE_TEXT = "已失效（已被处理、取消或过期）";

interface CardView {
  summary: OperatorApprovalSummary;
  element: HTMLElement;
  countdown: HTMLElement;
  buttons: HTMLButtonElement[];
  inFlight: boolean;
}

const list =
  document.querySelector(
    "#approval-list",
  );
const empty =
  document.querySelector(
    "#empty-state",
  );
const status =
  document.querySelector(
    "#status",
  );
const refresh =
  document.querySelector(
    "#refresh",
  );

let cardStates: CardState[] = [];
const views = new Map<string, CardView>();
// 本弹窗内由 operator 亲自处理的请求，卡片失效时显示具体结果。
const resolutions = new Map<string, string>();
let loading = false;

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

function showStatus(
  text: string,
): void {
  if (!status) return;

  status.removeAttribute(
    "hidden",
  );
  status.textContent = text;
}

function showError(
  error: unknown,
): void {
  showStatus(
    error instanceof Error
      ? error.message
      : "审批操作失败",
  );
}

async function call(
  message: unknown,
): Promise<unknown> {
  const response =
    await chrome.runtime
      .sendMessage(message);

  if (!response) {
    throw new Error(
      "审批服务不可用",
    );
  }

  if (!response.ok) {
    throw new Error(
      response.error.message,
    );
  }

  return response.result;
}

function element(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const node =
    document.createElement(tag);

  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}

/**
 * 页面派生文本：清理后加「」引号，只经 textContent 写入。
 * 清理后为空（例如全是不可见字符）时显示占位，避免出现空引号。
 */
function quoted(
  value: string,
): string {
  const text =
    untrustedDisplayText(value);

  return text
    ? "「" + text + "」"
    : "（无可显示内容）";
}

function markResolved(
  id: string,
  text: string,
): void {
  resolutions.set(id, text);
  cardStates = cardStates.map(
    (card) =>
      card.id === id
        ? { ...card, status: "stale" }
        : card,
  );
  updateCards();
}

function actionButton(
  label: string,
  className: string,
  approval:
    OperatorApprovalSummary,
  type:
    | "operator-approval.approve"
    | "operator-approval.reject",
  resolvedText: string,
): HTMLButtonElement {
  const button =
    document.createElement(
      "button",
    );

  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.disabled = true;

  button.addEventListener(
    "click",
    () => {
      const view = views.get(
        approval.approvalRequestId,
      );
      if (!view || view.inFlight) {
        return;
      }

      view.inFlight = true;
      updateCards();

      void call({
        type,
        requestId: requestId(),
        approvalRequestId:
          approval.approvalRequestId,
      })
        .then(() => {
          markResolved(
            approval.approvalRequestId,
            resolvedText,
          );
          showStatus(
            resolvedText +
              " " +
              shortCode(
                approval.approvalRequestId,
              ),
          );
        })
        .catch((error: unknown) => {
          showError(error);
          void load();
        })
        .finally(() => {
          view.inFlight = false;
          updateCards();
        });
    },
  );

  return button;
}

function createCard(
  approval:
    OperatorApprovalSummary,
): CardView {
  const card = element(
    "article",
    "approval-card",
  );
  card.dataset.approvalId =
    approval.approvalRequestId;

  const head = element(
    "div",
    "card-head",
  );
  head.append(
    element(
      "h2",
      undefined,
      "待批准的点击",
    ),
    element(
      "span",
      "code",
      shortCode(
        approval.approvalRequestId,
      ),
    ),
  );

  // origin 来自浏览器（URL.origin，IDN 以 punycode 显示），与页面文本分开展示。
  const origin = element(
    "div",
    "origin",
  );
  origin.append(
    element(
      "span",
      "field-label",
      "来源（浏览器提供）",
    ),
    element(
      "span",
      "origin-value",
      approval.origin,
    ),
  );

  const untrusted = element(
    "section",
    "untrusted",
  );
  const target =
    approval.targetName !== undefined
      ? quoted(approval.targetName) +
        " · 角色 " +
        quoted(approval.targetRole)
      : "角色 " +
        quoted(approval.targetRole);
  untrusted.append(
    element(
      "div",
      "untrusted-label",
      "页面提供的内容（不可信，仅供参考）",
    ),
    element(
      "p",
      "untrusted-text",
      "目标：" + target,
    ),
    element(
      "p",
      "untrusted-text",
      "页面标题：" +
        quoted(approval.pageTitle),
    ),
  );

  const countdown = element(
    "p",
    "countdown",
  );

  const actions = element(
    "div",
    "actions",
  );
  const buttons = [
    actionButton(
      "拒绝",
      "secondary",
      approval,
      "operator-approval.reject",
      "已拒绝",
    ),
    actionButton(
      "批准一次",
      "primary",
      approval,
      "operator-approval.approve",
      "已批准",
    ),
  ];
  actions.append(...buttons);

  card.append(
    head,
    origin,
    untrusted,
    countdown,
    actions,
  );

  return {
    summary: approval,
    element: card,
    countdown,
    buttons,
    inFlight: false,
  };
}

/** 倒计时与按钮可用性；高频调用，只改文本与 disabled，不改布局。 */
function updateCards(): void {
  const now = Date.now();

  for (const card of cardStates) {
    const view = views.get(card.id);
    if (!view) continue;

    const stale =
      card.status === "stale";
    const remaining = formatRemaining(
      view.summary.expiresAt,
      now,
    );

    view.element.classList.toggle(
      "stale",
      stale,
    );
    view.countdown.textContent = stale
      ? resolutions.get(card.id) ??
        STALE_TEXT
      : remaining;

    const disabled =
      stale ||
      view.inFlight ||
      now < card.enableAt ||
      view.summary.expiresAt <= now;

    for (const button of view.buttons) {
      button.disabled = disabled;
    }
  }

  empty?.toggleAttribute(
    "hidden",
    cardStates.length > 0,
  );
}

function apply(
  approvals:
    OperatorApprovalSummary[],
): void {
  if (!list) return;

  const byId = new Map(
    approvals.map((approval) => [
      approval.approvalRequestId,
      approval,
    ]),
  );
  // 本弹窗已处理的请求不再复活为可点击状态（列表请求可能早于处理结果返回）。
  const plan = planCardUpdate(
    cardStates,
    approvals
      .map(
        (approval) =>
          approval.approvalRequestId,
      )
      .filter(
        (id) => !resolutions.has(id),
      ),
    Date.now(),
  );

  for (const id of plan.removed) {
    views.get(id)?.element.remove();
    views.delete(id);
    resolutions.delete(id);
  }

  for (const id of plan.added) {
    const approval = byId.get(id);
    if (!approval) continue;

    const view = createCard(approval);
    views.set(id, view);
    list.append(view.element);
  }

  cardStates = plan.cards;
  updateCards();
}

async function load(): Promise<void> {
  if (loading) return;
  loading = true;

  try {
    const result =
      await call({
        type:
          "operator-approval.list",
        requestId:
          requestId(),
      });

    apply(
      Array.isArray(result)
        ? result as
            OperatorApprovalSummary[]
        : [],
    );
  } catch (error) {
    showError(error);
  } finally {
    loading = false;
  }
}

// 审批入口按 sender.url 精确匹配页面地址；带 query / hash 打开时先回到干净地址。
if (
  location.search ||
  location.hash
) {
  location.replace(
    location.pathname,
  );
} else {
  refresh?.addEventListener(
    "click",
    () => {
      void load();
    },
  );

  setInterval(
    updateCards,
    TICK_INTERVAL_MS,
  );
  setInterval(() => {
    void load();
  }, REFRESH_INTERVAL_MS);

  void load();
}
