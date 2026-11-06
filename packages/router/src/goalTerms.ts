import {
  CJK_STOP_PHRASES,
  CONCEPT_LEXICON,
  LATIN_STOPWORDS,
} from "./conceptLexicon.js";
import { INVISIBLE_CHARACTERS } from "./nameMatch.js";

/**
 * 把文本切成 unit（docs/JEV-CANDIDATE-BUILDER.md「Unit 切分」）。
 *
 * 一个词或短语要么归入一个概念（`c:<id>`），要么保留为原词（`w:<词>`），不会同时算两份；
 * 短语与中文写法按最长匹配、不重叠。
 */

/** NFKC 之后的截断长度（码点）。运行期元素字段已被 DOM 源截断到 240，这一步对 goal 起防御作用。 */
export const UNIT_TEXT_MAX_CODE_POINTS = 500;

// 片假名长音符 U+30FC 的 script 是 Common，必须显式并入，否则 “コーヒー” 会被切碎。
const CJK_SCRIPTS =
  "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\u30FC";
const CJK_CHARACTER = new RegExp("[" + CJK_SCRIPTS + "]", "u");
/**
 * CJK 段，或不属于 CJK script 的字母 / 组合附加符 / 数字段（`Settings设置` 切成两段；
 * 含组合附加符，天城文等文字不会被切碎）。
 */
const SEGMENT = new RegExp(
  "[" + CJK_SCRIPTS + "]+|(?:(?![" + CJK_SCRIPTS + "])[\\p{L}\\p{M}\\p{N}])+",
  "gu",
);
/** 句末与分句标点打断英文短语：“Change log. In this release” 不应得到 sign in。 */
const PHRASE_BREAK = /[.!?;:\u3002\uFF01\uFF1F\uFF1B\uFF1A]/u;

const latinPhrases = new Map<string, string>();
const latinWords = new Map<string, string>();
const cjkSpellings: Array<[string, string]> = [];

for (const [concept, spellings] of Object.entries(CONCEPT_LEXICON)) {
  for (const spelling of spellings) {
    if (CJK_CHARACTER.test(spelling)) cjkSpellings.push([spelling, concept]);
    else if (spelling.includes(" ")) latinPhrases.set(spelling, concept);
    else latinWords.set(spelling, concept);
  }
}
// 最长匹配：“退出登录” 必须先于 “登录”。
cjkSpellings.sort((a, b) => b[0].length - a[0].length);
const cjkStops = [...CJK_STOP_PHRASES].sort((a, b) => b.length - a.length);

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

/** 拉丁词序列：先在去停用词之前匹配两词短语，再按原词查概念，最后去停用词与复数归一。 */
function addLatinUnits(words: readonly string[], units: Set<string>): void {
  for (let index = 0; index < words.length; ) {
    if (index + 1 < words.length) {
      const phrase = latinPhrases.get(words[index] + " " + words[index + 1]);
      if (phrase !== undefined) {
        units.add("c:" + phrase);
        index += 2;
        continue;
      }
    }
    const word = words[index]!;
    index += 1;
    const concept = latinWords.get(word);
    if (concept !== undefined) {
      units.add("c:" + concept);
      continue;
    }
    if (LATIN_STOPWORDS.has(word)) continue;
    // 复数归一的结果不查概念表：news 不应归一成 new 而命中 create。
    units.add("w:" + singular(word));
  }
}

function addCharacterUnits(text: string, units: Set<string>): void {
  const characters = Array.from(text);
  if (characters.length === 1) {
    units.add("w:" + characters[0]);
    return;
  }
  for (let index = 0; index + 1 < characters.length; index += 1) {
    units.add("w:" + characters[index] + characters[index + 1]);
  }
}

/** CJK 段：最长匹配概念写法，其次删除停用短语，剩余连续字符切二字组（孤立单字保留）。 */
function addCjkUnits(segment: string, units: Set<string>): void {
  let pending = "";
  const flush = () => {
    if (pending.length > 0) addCharacterUnits(pending, units);
    pending = "";
  };
  // 按 UTF-16 偏移线性推进，不反复切片整段剩余字符串。
  for (let offset = 0; offset < segment.length; ) {
    const concept = cjkSpellings.find(([spelling]) => segment.startsWith(spelling, offset));
    if (concept !== undefined) {
      flush();
      units.add("c:" + concept[1]);
      offset += concept[0].length;
      continue;
    }
    const stop = cjkStops.find((phrase) => segment.startsWith(phrase, offset));
    if (stop !== undefined) {
      flush();
      offset += stop.length;
      continue;
    }
    const character = String.fromCodePoint(segment.codePointAt(offset)!);
    pending += character;
    offset += character.length;
  }
  flush();
}

export function unitsOf(text: string): Set<string> {
  const normalized = Array.from(text.normalize("NFKC"))
    .slice(0, UNIT_TEXT_MAX_CODE_POINTS)
    .join("")
    .replace(INVISIBLE_CHARACTERS, "")
    .toLowerCase();

  const units = new Set<string>();
  let words: string[] = [];
  let previousEnd = 0;
  for (const match of normalized.matchAll(SEGMENT)) {
    const segment = match[0];
    const gap = normalized.slice(previousEnd, match.index);
    previousEnd = match.index + segment.length;
    if (CJK_CHARACTER.test(segment) || PHRASE_BREAK.test(gap)) {
      // CJK 段与句末标点打断拉丁词序列：短语不跨越它们。
      addLatinUnits(words, units);
      words = [];
    }
    if (CJK_CHARACTER.test(segment)) addCjkUnits(segment, units);
    else words.push(segment);
  }
  addLatinUnits(words, units);
  return units;
}
