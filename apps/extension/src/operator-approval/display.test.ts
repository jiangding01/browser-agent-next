import {
  describe,
  expect,
  it,
} from "vitest";
import {
  CARD_ENABLE_DELAY_MS,
  formatRemaining,
  planCardUpdate,
  shortCode,
  untrustedDisplayText,
  type CardState,
} from "./display.js";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe("untrustedDisplayText", () => {
  it.each([
    ["bidi 覆盖 U+202A", 0x202a],
    ["bidi 覆盖 U+202B", 0x202b],
    ["bidi 覆盖 U+202C", 0x202c],
    ["bidi 覆盖 U+202D", 0x202d],
    ["bidi 覆盖 U+202E", 0x202e],
    ["bidi 隔离 U+2066", 0x2066],
    ["bidi 隔离 U+2067", 0x2067],
    ["bidi 隔离 U+2068", 0x2068],
    ["bidi 隔离 U+2069", 0x2069],
    ["LRM U+200E", 0x200e],
    ["RLM U+200F", 0x200f],
    ["ALM U+061C", 0x061c],
    ["零宽空格 U+200B", 0x200b],
    ["ZWNJ U+200C", 0x200c],
    ["ZWJ U+200D", 0x200d],
    ["WORD JOINER U+2060", 0x2060],
    ["soft hyphen U+00AD", 0x00ad],
    ["Tag U+E0001", 0xe0001],
    ["Tag U+E0041", 0xe0041],
    ["变体选择符 U+FE0F", 0xfe0f],
    ["变体选择符 U+FE00", 0xfe00],
    ["变体选择符 U+E0100", 0xe0100],
    ["变体选择符 U+E01EF", 0xe01ef],
    ["C0 U+0000", 0x0000],
    ["C0 U+0007", 0x0007],
    ["C0 U+001B", 0x001b],
    ["C0 U+007F", 0x007f],
    ["C1 U+0080", 0x0080],
    ["C1 U+0085", 0x0085],
    ["C1 U+009F", 0x009f],
  ])("删除 %s", (_name, code) => {
    expect(untrustedDisplayText("A" + cp(code) + "B")).toBe("AB");
    expect(untrustedDisplayText(cp(code) + "AB" + cp(code))).toBe("AB");
  });

  it("BOM U+FEFF 被删除而不是折叠成空格（\\s 包含 U+FEFF）", () => {
    expect(untrustedDisplayText(cp(0xfeff) + "AB" + cp(0xfeff))).toBe("AB");
    expect(untrustedDisplayText("A" + cp(0xfeff) + "B")).toBe("AB");
  });

  it("用 bidi 覆盖伪装的文本被还原为可见字符序列", () => {
    expect(
      untrustedDisplayText("Save" + cp(0x202e) + "elif.exe" + cp(0x202c)),
    ).toBe("Saveelif.exe");
  });

  it.each([
    ["换行 LF", "a\nb"],
    ["CRLF", "a\r\nb"],
    ["CR", "a\rb"],
    ["制表", "a\tb"],
    ["垂直制表", "a\u000bb"],
    ["换页", "a\fb"],
    ["U+2028", "a b"],
    ["U+2029", "a b"],
    ["多个混合空白", "a \n\t    b"],
  ])("%s 折叠为单个空格且两侧单词不粘连", (_name, text) => {
    expect(untrustedDisplayText(text)).toBe("a b");
  });

  it("空白与被删除字符相邻时仍只留一个空格", () => {
    expect(
      untrustedDisplayText("a" + cp(0x200b) + " " + cp(0x200b) + "b"),
    ).toBe("a b");
  });

  it("首尾 trim", () => {
    expect(untrustedDisplayText("  \n\t hello   ")).toBe("hello");
    expect(untrustedDisplayText(cp(0x200b) + "  hi  " + cp(0x200b))).toBe(
      "hi",
    );
  });

  it("全是不可见字符时得到空串", () => {
    expect(
      untrustedDisplayText(cp(0x200b, 0x202e, 0xfeff) + " \n"),
    ).toBe("");
  });

  it("超过 max 按码点截断并追加 …", () => {
    expect(untrustedDisplayText("abcdef", 3)).toBe("abc…");
    expect(untrustedDisplayText("abcdef", 6)).toBe("abcdef");
    expect(untrustedDisplayText("abcdef", 5)).toBe("abcde…");
  });

  it("默认 max 为 200", () => {
    expect(untrustedDisplayText("a".repeat(200))).toBe("a".repeat(200));
    expect(untrustedDisplayText("a".repeat(201))).toBe(
      "a".repeat(200) + "…",
    );
  });

  it("截断不会切断 emoji 代理对", () => {
    const text = "😀😀😀😀";
    const result = untrustedDisplayText(text, 2);

    expect(result).toBe("😀😀…");
    // 没有孤立代理项
    expect(result).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u,
    );
  });

  it("按码点而非 UTF-16 单元计数", () => {
    expect(untrustedDisplayText("😀😀😀", 3)).toBe("😀😀😀");
  });

  it("普通中文与 emoji 保持不变", () => {
    expect(untrustedDisplayText("保存设置，确认 🎉")).toBe(
      "保存设置，确认 🎉",
    );
    expect(untrustedDisplayText("👍🏽 Like")).toBe("👍🏽 Like");
    expect(untrustedDisplayText("Hello, World!")).toBe("Hello, World!");
  });

  it("带 ZWJ 的组合 emoji 会被拆开（ZWJ 被删除），记录当前行为", () => {
    expect(untrustedDisplayText("👨" + cp(0x200d) + "👩")).toBe("👨👩");
  });
});

describe("formatRemaining", () => {
  it("到期与负数显示已过期", () => {
    expect(formatRemaining(1_000, 1_000)).toBe("已过期");
    expect(formatRemaining(1_000, 2_000)).toBe("已过期");
    expect(formatRemaining(1_000, 1_000 + 999_999)).toBe("已过期");
  });

  it("不足 1 秒向上取整为 1 秒", () => {
    expect(formatRemaining(1_001, 1_000)).toBe("剩余 1 秒");
    expect(formatRemaining(1_999, 1_000)).toBe("剩余 1 秒");
  });

  it("ceil 后 < 60 显示秒", () => {
    expect(formatRemaining(1_000 + 30_000, 1_000)).toBe("剩余 30 秒");
    expect(formatRemaining(1_000 + 58_001, 1_000)).toBe("剩余 59 秒");
    expect(formatRemaining(1_000 + 59_000, 1_000)).toBe("剩余 59 秒");
  });

  it("59.001 秒 ceil 为 60，进入分秒格式", () => {
    expect(formatRemaining(1_000 + 59_001, 1_000)).toBe(
      "剩余 1 分 00 秒",
    );
  });

  it("恰好 60 秒显示 1 分 00 秒", () => {
    expect(formatRemaining(60_000, 0)).toBe("剩余 1 分 00 秒");
  });

  it("≥ 60 秒显示 M 分 SS 秒（两位秒）", () => {
    expect(formatRemaining(65_000, 0)).toBe("剩余 1 分 05 秒");
    expect(formatRemaining(119_000, 0)).toBe("剩余 1 分 59 秒");
    expect(formatRemaining(120_000, 0)).toBe("剩余 2 分 00 秒");
    expect(formatRemaining(120_001, 0)).toBe("剩余 2 分 01 秒");
    expect(formatRemaining(605_000, 0)).toBe("剩余 10 分 05 秒");
  });
});

describe("shortCode", () => {
  it("取末 6 位并加 #", () => {
    expect(shortCode("operator-abcdef123456")).toBe("#123456");
    expect(shortCode("0123456789")).toBe("#456789");
  });

  it("不足 6 位时取全部", () => {
    expect(shortCode("abc")).toBe("#abc");
    expect(shortCode("")).toBe("#");
  });

  it("恰好 6 位", () => {
    expect(shortCode("abcdef")).toBe("#abcdef");
  });
});

describe("planCardUpdate", () => {
  const active = (id: string, enableAt: number): CardState => ({
    id,
    status: "active",
    enableAt,
  });
  const stale = (id: string, enableAt: number): CardState => ({
    id,
    status: "stale",
    enableAt,
  });

  it("空列表加入新卡片：追加且 enableAt=now+500", () => {
    const plan = planCardUpdate([], ["a", "b"], 1_000);

    expect(CARD_ENABLE_DELAY_MS).toBe(500);
    expect(plan.cards).toEqual([
      active("a", 1_500),
      active("b", 1_500),
    ]);
    expect(plan.added).toEqual(["a", "b"]);
    expect(plan.staled).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  it("已有卡片保持顺序与 enableAt，新卡片追加到末尾", () => {
    const plan = planCardUpdate(
      [active("a", 1_100), active("b", 1_200)],
      ["new", "b", "a"],
      2_000,
    );

    expect(plan.cards).toEqual([
      active("a", 1_100),
      active("b", 1_200),
      active("new", 2_500),
    ]);
    expect(plan.added).toEqual(["new"]);
    expect(plan.staled).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  it("无变化时布局完全不变", () => {
    const previous = [active("a", 10), active("b", 20)];
    const plan = planCardUpdate(previous, ["a", "b"], 5_000);

    expect(plan.cards).toEqual(previous);
    expect(plan.added).toEqual([]);
    expect(plan.staled).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  it("消失的 active 卡片变 stale 并原位保留，enableAt 不变", () => {
    const plan = planCardUpdate(
      [active("a", 10), active("b", 20), active("c", 30)],
      ["a", "c"],
      5_000,
    );

    expect(plan.cards).toEqual([
      active("a", 10),
      stale("b", 20),
      active("c", 30),
    ]);
    expect(plan.staled).toEqual(["b"]);
    expect(plan.removed).toEqual([]);
    expect(plan.added).toEqual([]);
  });

  it("已 stale 且仍不在列表的卡片被 removed", () => {
    const plan = planCardUpdate(
      [active("a", 10), stale("b", 20)],
      ["a"],
      5_000,
    );

    expect(plan.cards).toEqual([active("a", 10)]);
    expect(plan.removed).toEqual(["b"]);
    expect(plan.staled).toEqual([]);
  });

  it("被移除位置之后的卡片 enableAt 推迟到 now+500，之前的不受影响", () => {
    const plan = planCardUpdate(
      [
        active("before", 10),
        stale("gone", 20),
        active("after1", 30),
        active("after2", 40),
      ],
      ["before", "after1", "after2"],
      5_000,
    );

    expect(plan.cards).toEqual([
      active("before", 10),
      active("after1", 5_500),
      active("after2", 5_500),
    ]);
    expect(plan.removed).toEqual(["gone"]);
  });

  it("已有更晚的 enableAt 时不被提前（取 max）", () => {
    const plan = planCardUpdate(
      [stale("gone", 0), active("late", 9_000)],
      ["late"],
      5_000,
    );

    expect(plan.cards).toEqual([active("late", 9_000)]);
  });

  it("移除后同一轮新增的卡片仍是 now+500，stale 的后续卡片保持 stale 状态", () => {
    const plan = planCardUpdate(
      [stale("gone", 0), active("x", 10), active("y", 20)],
      ["x", "new"],
      1_000,
    );

    expect(plan.cards).toEqual([
      active("x", 1_500),
      stale("y", 20),
      active("new", 1_500),
    ]);
    expect(plan.removed).toEqual(["gone"]);
    expect(plan.staled).toEqual(["y"]);
    expect(plan.added).toEqual(["new"]);
  });

  it("stale 卡片重新出现在列表时恢复 active，不算 added，enableAt 保持", () => {
    const plan = planCardUpdate(
      [active("a", 10), stale("b", 20)],
      ["a", "b"],
      5_000,
    );

    expect(plan.cards).toEqual([active("a", 10), active("b", 20)]);
    expect(plan.added).toEqual([]);
    expect(plan.staled).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  it("同一轮同时出现 stale、removed 与 added", () => {
    const plan = planCardUpdate(
      [stale("old", 0), active("keep", 10), active("drop", 20)],
      ["keep", "fresh"],
      1_000,
    );

    expect(plan.removed).toEqual(["old"]);
    expect(plan.staled).toEqual(["drop"]);
    expect(plan.added).toEqual(["fresh"]);
    expect(plan.cards.map((card) => card.id)).toEqual([
      "keep",
      "drop",
      "fresh",
    ]);
  });

  it("不修改传入的 previous", () => {
    const previous = [active("a", 10), stale("b", 20), active("c", 30)];
    const snapshot = structuredClone(previous);

    planCardUpdate(previous, ["c"], 5_000);

    expect(previous).toEqual(snapshot);
  });
});
