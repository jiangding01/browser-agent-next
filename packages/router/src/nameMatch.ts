/**
 * Router 的名称比较键（docs/DETERMINISTIC-ROUTER.md「名称比较键」）。
 *
 * - exactKey：判定“匹配”。NFKC 后折叠空白、trim，保留大小写与不可见字符，
 *   因此含不可见字符的名称永远不会与 intent（不含不可见字符）相等。
 * - looseKey：判定“可疑同名”。删掉一切可能在页面上不可见或显示相同的差异：
 *   不可见字符、空白、大小写。最后再做一次 NFKC，覆盖删除使相邻字符重新组合
 *   （e + 零宽 + U+0301）以及大小写映射产生非规范形式的情形。
 */

/** 页面上不可见的字符：控制、格式、默认可忽略，以及常见字体中渲染为空白的 U+2800。 */
const INVISIBLE_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;

const WHITESPACE_RUN = /\s+/gu;

export function exactKey(name: string): string {
  return name.normalize("NFKC").replace(WHITESPACE_RUN, " ").trim();
}

export function looseKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(WHITESPACE_RUN, "")
    // 单次 toLowerCase 不是完整大小写折叠（straße / STRASSE）；
    // 先转大写再转小写更接近完整折叠，且两者都不依赖 locale。
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC");
}
