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

const extensionId = argument("extension-id");

if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  console.error(
    "用法：browser-agent-next-native-host install --extension-id=<32位Chrome扩展ID>",
  );
  console.error(
    "也可以直接执行：node dist/scripts/installChromeNativeHost.js --extension-id=<ID>",
  );
  process.exit(2);
}

const currentFile = fileURLToPath(import.meta.url);
const hostEntry = resolve(
  dirname(currentFile),
  "../index.js",
);

const manifest = {
  name: HOST_NAME,
  description:
    "Browser Agent Next trusted native messaging host",
  path: hostEntry,
  type: "stdio",
  allowed_origins: [
    "chrome-extension://" + extensionId + "/",
  ],
};

function manifestDir(): string {
  switch (process.platform) {
    case "darwin":
      return resolve(
        homedir(),
        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      );

    case "linux":
      return resolve(
        homedir(),
        ".config/google-chrome/NativeMessagingHosts",
      );

    default:
      throw new Error(
        "当前安装脚本仅支持 macOS/Linux；Windows 需要注册表安装器",
      );
  }
}

const dir = manifestDir();
mkdirSync(dir, {
  recursive: true,
  mode: 0o700,
});

const path = resolve(
  dir,
  HOST_NAME + ".json",
);

writeFileSync(
  path,
  JSON.stringify(manifest, null, 2) + "\n",
  {
    encoding: "utf8",
    mode: 0o600,
  },
);

if (process.platform !== "win32") {
  chmodSync(path, 0o600);
}

console.log("已写入 Native Messaging host manifest：");
console.log(path);
console.log("");
console.log("Trusted RPC token：");
console.log(resolve(
  homedir(),
  ".browser-agent-next/trusted-rpc.token",
));
