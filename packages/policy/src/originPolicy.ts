export interface OriginPolicy {
  isAllowed(origin: string): boolean;
}

function canonicalHttpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "only explicit http/https origins are supported by the auto-act allowlist",
    );
  }

  if (url.origin === "null") {
    throw new Error("opaque origins cannot be allowlisted");
  }

  if (
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "auto-act allowlist entries must be origin-only URLs without path, query, fragment, or credentials",
    );
  }

  return url.origin;
}

/**
 * 精确 origin allowlist。
 *
 * 不支持 wildcard、suffix 或“包含字符串”匹配。这样：
 *
 *   https://example.com
 *
 * 不会隐式授权：
 *
 *   https://evil.example.com
 *   http://example.com
 *   https://example.com:8443
 */
export class ExactOriginAllowlist implements OriginPolicy {
  private readonly origins: ReadonlySet<string>;

  constructor(origins: readonly string[]) {
    this.origins = new Set(
      origins.map((origin) => canonicalHttpOrigin(origin)),
    );
  }

  isAllowed(origin: string): boolean {
    let canonical: string;

    try {
      canonical = canonicalHttpOrigin(origin);
    } catch {
      return false;
    }

    return this.origins.has(canonical);
  }

  values(): string[] {
    return [...this.origins].sort();
  }
}

/**
 * 由 trusted control plane 动态同步的精确 origin allowlist。
 *
 * 默认空集合；普通页面、Agent message、模型输出都不能修改它。
 */
export class MutableExactOriginAllowlist implements OriginPolicy {
  private current = new ExactOriginAllowlist([]);

  replace(origins: readonly string[]): string[] {
    const next = new ExactOriginAllowlist(origins);
    this.current = next;
    return next.values();
  }

  isAllowed(origin: string): boolean {
    return this.current.isAllowed(origin);
  }

  values(): string[] {
    return this.current.values();
  }

  clear(): void {
    this.current = new ExactOriginAllowlist([]);
  }
}
