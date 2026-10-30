/**
 * HTML 规范中“阻止隐式提交”（blocks implicit submission）的 input type。
 * 没有提交按钮的表单只在恰好有一个这样的字段时，于该字段中按 Enter 才会提交；
 * 感知层（submit capability）与 isolated-world 页面函数共用这一判定（不变量 148）。
 */
export const IMPLICIT_SUBMISSION_BLOCKING_TYPES: readonly string[] = [
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
];
