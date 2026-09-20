import { ExactOriginAllowlist } from "./originPolicy.js";

export const MODEL_FACING_TOOL_NAMES = [
  "browser.open",
  "browser.observe",
  "browser.extract",
  "browser.verify",
  "browser.wait",
] as const;

export type ModelFacingToolName =
  (typeof MODEL_FACING_TOOL_NAMES)[number];

export type ModelFacingToolTier =
  | "read"
  | "navigation";

const TOOL_TIERS: Record<
  ModelFacingToolName,
  ModelFacingToolTier
> = {
  "browser.open": "navigation",
  "browser.observe": "read",
  "browser.extract": "read",
  "browser.verify": "read",
  "browser.wait": "read",
};

const KNOWN_TOOLS = new Set<string>(
  MODEL_FACING_TOOL_NAMES,
);

/**
 * 模型可见工具的显式 allowlist。
 *
 * 这里故意不包含 authorization issuance、policy mutation、raw CDP、
 * trusted-host RPC 等控制面能力。未知名称在构造时直接拒绝，避免后续
 * 新增内部 RPC 时被“默认透传”。
 */
export class ModelToolExposurePolicy {
  private readonly tools: ReadonlySet<ModelFacingToolName>;

  constructor(tools: readonly string[]) {
    const next = new Set<ModelFacingToolName>();

    for (const tool of tools) {
      if (!KNOWN_TOOLS.has(tool)) {
        throw new Error(
          "unknown model-facing tool: " + tool,
        );
      }
      next.add(tool as ModelFacingToolName);
    }

    this.tools = next;
  }

  isExposed(tool: string): tool is ModelFacingToolName {
    return KNOWN_TOOLS.has(tool) &&
      this.tools.has(tool as ModelFacingToolName);
  }

  tier(tool: ModelFacingToolName): ModelFacingToolTier {
    return TOOL_TIERS[tool];
  }

  values(): ModelFacingToolName[] {
    return MODEL_FACING_TOOL_NAMES.filter(
      (tool) => this.tools.has(tool),
    );
  }
}

export interface ModelOriginAccessPolicyOptions {
  readOrigins: readonly string[];
  navigationOrigins: readonly string[];
}

/**
 * 模型数据出境与模型导航的独立 origin policy plane。
 *
 * 它和 runtime auto-act origin policy 是不同对象、不同配置来源，不能互相
 * 推导。允许模型读取某 origin 不代表允许模型导航到该 origin；反之亦然。
 */
export class ModelOriginAccessPolicy {
  private readonly readOrigins: ExactOriginAllowlist;
  private readonly navigationOrigins: ExactOriginAllowlist;

  constructor(options: ModelOriginAccessPolicyOptions) {
    this.readOrigins = new ExactOriginAllowlist(
      options.readOrigins,
    );
    this.navigationOrigins = new ExactOriginAllowlist(
      options.navigationOrigins,
    );
  }

  canRead(urlOrOrigin: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(urlOrOrigin);
    } catch {
      return false;
    }

    if (
      (parsed.protocol !== "http:" &&
        parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return false;
    }

    return this.readOrigins.isAllowed(parsed.href);
  }

  canNavigate(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (
      (parsed.protocol !== "http:" &&
        parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return false;
    }

    return this.navigationOrigins.isAllowed(parsed.href);
  }

  readableOrigins(): string[] {
    return this.readOrigins.values();
  }

  navigableOrigins(): string[] {
    return this.navigationOrigins.values();
  }
}
