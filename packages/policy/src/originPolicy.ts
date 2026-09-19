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
