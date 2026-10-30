/**
 * 审批弹窗的纯展示逻辑（不依赖 DOM，便于单测）。
 */

// 控制字符（Cc）与格式字符（Cf：bidi 覆盖 / 隔离、零宽字符、soft hyphen、
// Tag 字符、BOM 等），以及变体选择符；页面可借它们重排或隐藏可见文本。
const INVISIBLE_OR_REORDERING =
  /[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

export const UNTRUSTED_TEXT_MAX = 200;

/**
 * 页面派生文本（目标名称、role、页面标题）在展示前的清理：
 * 删除不可见 / 重排字符，空白（含 U+2028 / U+2029）折叠为单个空格，
 * 按码点截断。结果仍只能经 textContent 写入。
 */
export function untrustedDisplayText(
  value: string,
  max = UNTRUSTED_TEXT_MAX,
): string {
  // 先把空白统一成空格：\s 里的换行属于 Cc，若先删字符会把两侧单词粘在一起。
  // BOM（U+FEFF）虽在 \s 内但不可见，必须先删除，不能变成空格。
  const cleaned = value
    .replace(/\u{FEFF}/gu, "")
    .replace(/\s+/gu, " ")
    .replace(INVISIBLE_OR_REORDERING, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  const codePoints = Array.from(cleaned);

  return codePoints.length > max
    ? codePoints.slice(0, max).join("") + "…"
    : cleaned;
}

/** 审批卡片标题：按将要执行的动作区分。 */
export function approvalTitle(
  action: { kind: string },
): string {
  return action.kind === "setValue"
    ? "待批准的填写"
    : "待批准的点击";
}

export interface WriteValueDisplay {
  /** 原样显示的值（入口已拒绝不可见字符，不做任何清理或截断）。 */
  text: string;
  /** 字符数与空格提示：截断或空白差异不能逃过人工审查（不变量 142）。 */
  caption: string;
}

/**
 * 写入值的展示：完整显示，不清理、不截断；空值显示为清空说明；
 * 首尾空格与连续空格在说明里明确标出（pre-wrap 下它们不显眼）。
 */
export function writeValueDisplay(value: string): WriteValueDisplay {
  if (value === "") {
    return { text: "（清空该字段）", caption: "共 0 个字符" };
  }

  const notes = ["共 " + Array.from(value).length + " 个字符"];
  if (value.startsWith(" ")) notes.push("开头有空格");
  if (value.endsWith(" ")) notes.push("结尾有空格");
  if (value.includes("  ")) notes.push("含连续空格");

  return { text: value, caption: notes.join("；") };
}

/** 倒计时文案：< 60 秒显示秒，否则显示分秒；到期显示“已过期”。 */
export function formatRemaining(
  expiresAt: number,
  now: number,
): string {
  const seconds = Math.ceil((expiresAt - now) / 1000);

  if (seconds <= 0) {
    return "已过期";
  }
  if (seconds < 60) {
    return "剩余 " + seconds + " 秒";
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return (
    "剩余 " +
    minutes +
    " 分 " +
    String(rest).padStart(2, "0") +
    " 秒"
  );
}

/** 请求短码：approvalRequestId 末 6 位，便于核对“批准的是哪一条”。 */
export function shortCode(approvalRequestId: string): string {
  return "#" + approvalRequestId.slice(-6);
}

export const CARD_ENABLE_DELAY_MS = 500;

export interface CardState {
  id: string;
  /** stale：已不在待审批列表中，原位禁用展示一个刷新周期后移除。 */
  status: "active" | "stale";
  /** 在此时间之前按钮保持禁用。 */
  enableAt: number;
}

export interface CardUpdatePlan {
  cards: CardState[];
  added: string[];
  staled: string[];
  removed: string[];
}

/**
 * 计算一次列表刷新后的卡片布局，目标是不让卡片在用户点击时“滑走”：
 * - 已有卡片保持原有顺序与节点，不重排；
 * - 新请求只追加到末尾，按钮延迟启用；
 * - 消失的请求先原位标记为 stale（禁用），下一次刷新才移除；
 * - 移除会让后面的卡片上移，因此被移除位置之后的卡片按钮也延迟启用。
 */
export function planCardUpdate(
  previous: readonly CardState[],
  nextIds: readonly string[],
  now: number,
): CardUpdatePlan {
  const next = new Set(nextIds);
  const known = new Set(previous.map((card) => card.id));
  const added: string[] = [];
  const staled: string[] = [];
  const removed: string[] = [];
  const cards: CardState[] = [];
  let shifted = false;

  for (const card of previous) {
    if (next.has(card.id)) {
      cards.push({
        ...card,
        status: "active",
        enableAt: shifted
          ? Math.max(card.enableAt, now + CARD_ENABLE_DELAY_MS)
          : card.enableAt,
      });
      continue;
    }

    if (card.status === "active") {
      staled.push(card.id);
      cards.push({ ...card, status: "stale" });
      continue;
    }

    removed.push(card.id);
    shifted = true;
  }

  for (const id of nextIds) {
    if (known.has(id)) {
      continue;
    }
    added.push(id);
    cards.push({
      id,
      status: "active",
      enableAt: now + CARD_ENABLE_DELAY_MS,
    });
  }

  return { cards, added, staled, removed };
}
