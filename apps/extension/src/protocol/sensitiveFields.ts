/**
 * 凭据与支付类 autocomplete token（WHATWG autofill）的匹配规则。
 *
 * 内容脚本的感知（state.sensitive）与 background 注入 isolated world 的写入函数
 * 共用这一份定义，保证“签发前拒绝”与“执行时复核”使用同一规则（不变量 141）。
 */
export const SENSITIVE_AUTOCOMPLETE_PATTERN =
  "(^|\\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\\s|$)";
