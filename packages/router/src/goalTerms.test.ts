import { describe, expect, it } from "vitest";
import {
  CJK_STOP_PHRASES,
  CONCEPT_LEXICON,
  LATIN_STOPWORDS,
  LEXICON_VERSION,
} from "./conceptLexicon.js";
import { UNIT_TEXT_MAX_CODE_POINTS, unitsOf } from "./goalTerms.js";

const units = (text: string) => [...unitsOf(text)].sort();

describe("unitsOf", () => {
  it("normalizes width and case, and drops invisible characters", () => {
    expect(units("Ｂｉｌｌｉｎｇ")).toEqual(["w:billing"]);
    expect(units("Bil" + String.fromCodePoint(0x200b) + "ling")).toEqual(["w:billing"]);
  });

  it("matches two-word phrases before dropping stopwords", () => {
    // “in” 是停用词：若先去停用词，sign in 永远匹配不上。
    expect(units("Sign in")).toEqual(["c:sign-in"]);
    expect(units("Sign-in now")).toEqual(["c:sign-in"]);
    expect(units("Sign out of the account")).toEqual(["c:account", "c:sign-out"]);
  });

  it("looks up concepts by the raw word and never by the singularized form", () => {
    expect(units("Settings")).toEqual(["c:settings"]);
    // news → new 会误命中 create。
    expect(units("News")).toEqual(["w:new"]);
  });

  it("singularizes only plain plurals", () => {
    expect(units("invoices")).toEqual(["w:invoice"]);
    expect(units("histories")).toEqual(["w:history"]);
    expect(units("class bus")).toEqual(["w:bus", "w:class"]);
  });

  it("drops English stopwords", () => {
    expect(units("the billing of my history")).toEqual(["w:billing", "w:history"]);
  });

  it("uses longest CJK concept matches without overlap", () => {
    // 退出登录 只能是 sign-out，不能再切出 登录（sign-in）。
    expect(units("退出登录")).toEqual(["c:sign-out"]);
    expect(units("登录")).toEqual(["c:sign-in"]);
    expect(units("创建工单")).toEqual(["c:create", "c:ticket"]);
  });

  it("drops Chinese stop phrases, with concept spellings taking precedence", () => {
    expect(units("点击我的订单")).toEqual(["c:order"]);
    expect(units("我的")).toEqual([]);
  });

  it("splits remaining CJK runs into bigrams and keeps isolated characters", () => {
    expect(units("全部订单")).toEqual(["c:order", "w:全部"]);
    expect(units("账单历史")).toEqual(["w:单历", "w:历史", "w:账单"]);
    expect(units("图")).toEqual(["w:图"]);
  });

  it("segments by script, so Latin words never swallow CJK characters", () => {
    expect(units("Settings设置")).toEqual(["c:settings"]);
    expect(units("Billing账单")).toEqual(["w:billing", "w:账单"]);
  });

  it("does not form phrases across a CJK segment", () => {
    // 若短语跨越中文段，会得到 c:sign-in。
    expect(units("sign 的 in")).toEqual(["w:sign", "w:的"]);
  });

  it("truncates after NFKC", () => {
    // U+337F 经 NFKC 展开为 4 个字：在 NFKC 之前截断会保留 billing。
    const expanding = String.fromCodePoint(0x337f).repeat(130) + " billing";
    expect(Array.from(expanding).length).toBeLessThan(UNIT_TEXT_MAX_CODE_POINTS);
    expect(unitsOf(expanding).has("w:billing")).toBe(false);
  });

  it("keeps the katakana prolonged sound mark inside katakana words", () => {
    const chouon = String.fromCodePoint(0x30fc);
    expect(unitsOf("コ" + chouon + "ヒ" + chouon).has("w:" + chouon)).toBe(false);
    expect(units("コ" + chouon + "ヒ" + chouon)).toHaveLength(3);
  });

  it("keeps combining marks inside words", () => {
    // 天城文：组合附加符不能把一个词切成几段。
    expect(unitsOf(String.fromCodePoint(0x939, 0x93f, 0x928, 0x94d, 0x926, 0x940)).size).toBe(1);
    // İ 小写后带 U+0307，仍是一个词。
    expect(unitsOf("İstanbul").size).toBe(1);
  });

  it("breaks English phrases at sentence punctuation but not at hyphens", () => {
    expect(units("Change log. In this release")).toEqual(["w:change", "w:log", "w:release"]);
    expect(units("Sign-in")).toEqual(["c:sign-in"]);
  });

  it("does not split content words on single-character particles", () => {
    expect(units("目的地")).toEqual(["w:的地", "w:目的"]);
    expect(units("申请")).toEqual(["w:申请"]);
  });
});

describe("concept lexicon", () => {
  it("cuts every spelling into exactly its own concept", () => {
    for (const [concept, spellings] of Object.entries(CONCEPT_LEXICON)) {
      for (const spelling of spellings) {
        expect(units(spelling), concept + ": " + spelling).toEqual(["c:" + concept]);
      }
    }
  });

  it("keeps the documented sizes and a version", () => {
    expect(Object.keys(CONCEPT_LEXICON)).toHaveLength(20);
    expect(LATIN_STOPWORDS.size).toBe(24);
    expect(CJK_STOP_PHRASES).toHaveLength(5);
    expect(LEXICON_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
