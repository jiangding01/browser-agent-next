/**
 * Jev CandidateBuilder 的固定词表（docs/JEV-CANDIDATE-BUILDER.md「概念词表」）。
 *
 * 词表是同义归并而不是翻译：只让“打开设置”和 “Settings” 产生相同的 unit。
 * 任何改动（增删概念、写法或停用词）都必须同时修改 LEXICON_VERSION，保证 replay 可复现。
 */
export const LEXICON_VERSION = "2026-11-06.2";

export const CONCEPT_LEXICON: Readonly<Record<string, readonly string[]>> = Object.freeze({
  settings: ["settings", "setting", "preferences", "设置", "偏好设置"],
  create: ["create", "new", "add", "新建", "创建", "添加", "新增"],
  delete: ["delete", "remove", "删除", "移除"],
  open: ["open", "打开"],
  view: ["view", "查看", "浏览"],
  "sign-in": ["sign in", "log in", "login", "登录", "登入"],
  "sign-out": ["sign out", "log out", "logout", "退出登录", "退出账号", "登出", "注销"],
  submit: ["submit", "提交"],
  save: ["save", "保存"],
  cancel: ["cancel", "取消"],
  pay: ["pay", "payment", "支付", "付款"],
  search: ["search", "搜索"],
  next: ["next", "下一步", "下一页"],
  back: ["back", "返回", "上一步"],
  confirm: ["confirm", "确认", "确定"],
  detail: ["detail", "details", "详情"],
  ticket: ["ticket", "tickets", "工单"],
  order: ["order", "orders", "订单"],
  account: ["account", "accounts", "账户", "账号"],
  close: ["close", "关闭"],
});

/** 英文停用词（固定 24 个）；在短语匹配之后丢弃。 */
export const LATIN_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "to", "for", "in", "on", "with", "and", "or", "my",
  "your", "this", "that", "is", "are", "be", "please", "now", "it", "at", "by", "from",
]);

/**
 * 中文停用短语（固定 5 个）；概念写法优先于停用短语。不收单字（如“的”“请”），
 * 否则会拆开“目的地”“申请”这类实义词。
 */
export const CJK_STOP_PHRASES: readonly string[] = Object.freeze([
  "点击", "我的", "页面", "按钮", "一下",
]);
