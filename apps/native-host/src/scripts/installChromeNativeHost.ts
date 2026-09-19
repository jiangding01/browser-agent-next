#!/usr/bin/env node
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.browser_agent_next.host";

function argument(name: string): string | undefined {
  const prefix = "--" + name + "=";
  return process.argv.find((item) =>
    item.startsWith(prefix)
  )?.slice(prefix.length);
}

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

const extensionId = argument("extension-id");
const browser = argument("browser") ?? "chrome";

if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  console.error(
    "用法：pnpm --filter @browser-agent-next/native-host install:chrome -- --extension-id=<32位Chrome扩展ID> [--browser=chrome|chrome-for-testing|chromium]",
  );
  process.exit(2);
}

if (
  browser !== "chrome" &&
  browser !== "chrome-for-testing" &&
  browser !== "chromium"
) {
  console.error(
    "--browser 仅支持 chrome、chrome-for-testing、chromium",
  );
  process.exit(2);
}

if (process.platform === "win32") {
  console.error(
    "当前安装脚本暂不修改 Windows 注册表；Windows 安装器将在独立阶段实现。",
  );
  process.exit(2);
}

const currentFile = fileURLToPath(import.meta.url);
const hostEntry = resolve(
  dirname(currentFile),
  "../index.js",
);

const stateDir = resolve(
  homedir(),
  ".browser-agent-next",
);
mkdirSync(stateDir, {
  recursive: true,
  mode: 0o700,
});
chmodSync(stateDir, 0o700);

const wrapper = resolve(
  stateDir,
  "native-host.sh",
);

writeFileSync(
  wrapper,
  [
    "#!/bin/sh",
    "exec " +
      shQuote(process.execPath) +
      " " +
      shQuote(hostEntry) +
      ' "$@"',
    "",
  ].join("\n"),
  {
    encoding: "utf8",
    mode: 0o700,
  },
);
chmodSync(wrapper, 0o700);

const manifest = {
  name: HOST_NAME,
  description:
    "Browser Agent Next trusted native messaging host",
  path: wrapper,
  type: "stdio",
  allowed_origins: [
    "chrome-extension://" + extensionId + "/",
  ],
};

function manifestDir(): string {
  if (process.platform === "darwin") {
    if (browser === "chromium") {
      return resolve(
        homedir(),
        "Library/Application Support/Chromium/NativeMessagingHosts",
      );
    }

    if (browser === "chrome-for-testing") {
      return resolve(
        homedir(),
        "Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts",
      );
    }

    return resolve(
      homedir(),
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    );
  }

  if (browser === "chromium") {
    return resolve(
      homedir(),
      ".config/chromium/NativeMessagingHosts",
    );
  }

  if (browser === "chrome-for-testing") {
    return resolve(
      homedir(),
      ".config/google-chrome-for-testing/NativeMessagingHosts",
    );
  }

  return resolve(
    homedir(),
    ".config/google-chrome/NativeMessagingHosts",
  );
}

const dir = manifestDir();
mkdirSync(dir, {
  recursive: true,
  mode: 0o700,
});

const manifestPath = resolve(
  dir,
  HOST_NAME + ".json",
);

writeFileSync(
  manifestPath,
  JSON.stringify(manifest, null, 2) + "\n",
  {
    encoding: "utf8",
    mode: 0o600,
  },
);
chmodSync(manifestPath, 0o600);

console.log("已安装 Native Messaging host：");
console.log(manifestPath);
console.log("");
console.log("Host wrapper：");
console.log(wrapper);
console.log("");
console.log("Trusted RPC token 将在 Chrome 首次连接 host 后创建于：");
console.log(resolve(
  stateDir,
  "trusted-rpc.token",
));
