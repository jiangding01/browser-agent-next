import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  unlinkSync,
  write,
  type Stats,
} from "node:fs";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";
import type {
  RuntimeTraceEvent,
} from "@browser-agent-next/core";

export const DEFAULT_TRACE_MAX_BYTES = 16 * 1024 * 1024;
export const MIN_TRACE_MAX_BYTES = 64 * 1024;
export const MAX_TRACE_MAX_BYTES = 256 * 1024 * 1024;
export const TRACE_QUEUE_LIMIT = 1_024;
/** act 事件在普通队列之外的额外余量；act 受每连接预算约束，不会无界增长。 */
export const TRACE_ACT_QUEUE_RESERVE = 512;

const FILE_NAME_PATTERN = /^trace-[0-9a-f-]{36}\.jsonl$/;

export interface TraceSink {
  /** 同步入队、立即返回；不得抛出，也不得阻塞工具调用（不变量 135 / 137）。 */
  write(event: RuntimeTraceEvent): void;
}

export interface TraceFileSink extends TraceSink {
  readonly path: string;
  /** 等待当前队列全部写完（测试与有序关闭用）。 */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface TraceFileSinkOptions {
  directory: string;
  /** `trace-<runId>.jsonl`；只会被新建，绝不打开已存在的文件。 */
  fileName: string;
  maxBytes?: number;
  /** 诊断只写 stderr；默认 console.error。 */
  log?: (message: string) => void;
  /** 测试注入点：替换单条写入，用于覆盖写入失败路径。 */
  writer?: (fd: number, buffer: Buffer) => Promise<void>;
}

/**
 * 是否使用 act 保留容量。
 *
 * 只有真正进入授权阶段（带 authorization）或已执行（executed 及其动作后 verify）的
 * act 事件才算：这些都发生在每连接预算扣减之后，数量有界。格式错误、revision 未知、
 * ref 不存在等在预算之前失败的 act 调用不受预算约束，必须和普通事件同档，
 * 否则模型可以用它们撑满保留容量（不变量 137）。
 */
export function usesActReserve(event: RuntimeTraceEvent): boolean {
  return (
    event.tool === "browser.act" &&
    (
      event.authorization !== undefined ||
      event.outcome === "executed" ||
      event.event === "verify"
    )
  );
}

type Tier = "normal" | "act";

const LOG_PREFIX = "[browser-agent-next/mcp] trace: ";

function currentUid(): number | undefined {
  return typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
}

function sameNode(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function assertPrivateDirectory(stat: Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "trace directory must be a real directory, not a symlink",
    );
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      "trace directory must be owned by the current user",
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("trace directory permissions are too broad");
  }
}

function assertNewPrivateFile(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error("trace file must be a new regular file");
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("trace file must be owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("trace file permissions are too broad");
  }
}

function boundedMaxBytes(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_TRACE_MAX_BYTES ||
    value > MAX_TRACE_MAX_BYTES
  ) {
    throw new Error(
      "trace maxBytes must be an integer between " +
        MIN_TRACE_MAX_BYTES +
        " and " +
        MAX_TRACE_MAX_BYTES,
    );
  }
  return value;
}

function writeFully(
  fd: number,
  buffer: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    write(fd, buffer, 0, buffer.length, null, (error, written) => {
      if (error) {
        reject(error);
      } else if (written !== buffer.length) {
        reject(new Error("short trace write"));
      } else {
        resolve();
      }
    });
  });
}

/**
 * 在私有目录中新建的有界 JSONL trace 文件（不变量 136 / 137）。
 *
 * 只用 O_EXCL 新建，从不打开已存在的文件：配置成 token 或私钥路径也写不进去。
 * 打开阶段的任何问题都直接抛出，让进程启动失败；运行期问题只写一行 stderr，
 * 之后静默丢弃，绝不影响工具调用。
 */
export function openTraceFileSink(
  options: TraceFileSinkOptions,
): TraceFileSink {
  if (process.platform === "win32") {
    throw new Error(
      "trace output is not supported on Windows (no O_NOFOLLOW)",
    );
  }

  const { fileName } = options;
  const writeEvent = options.writer ?? writeFully;
  const maxBytes = boundedMaxBytes(
    options.maxBytes ?? DEFAULT_TRACE_MAX_BYTES,
  );
  // 普通事件只能用 3/4；剩下的留给 act，模型无法用廉价调用挤掉 act 的记录。
  const normalLimit = Math.floor((maxBytes * 3) / 4);
  const log = options.log ?? ((message: string) => {
    console.error(LOG_PREFIX + message);
  });

  if (
    !isAbsolute(options.directory) ||
    options.directory.length > 4_096 ||
    options.directory.includes("\0")
  ) {
    throw new Error("trace directory must be an absolute path");
  }
  // 去掉末尾分隔符：lstat("link/") 会跟随 symlink，让 symlink 目录通过检查。
  const directory = resolve(options.directory);
  if (!FILE_NAME_PATTERN.test(fileName)) {
    throw new Error("trace file name is invalid");
  }

  const directoryBefore = lstatSync(directory);
  assertPrivateDirectory(directoryBefore);

  const path = join(directory, fileName);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );

  try {
    const opened = fstatSync(fd);
    assertNewPrivateFile(opened);
    // 检查与打开之间目录或文件名被替换时，dev/ino 不会一致。
    if (
      !sameNode(lstatSync(directory), directoryBefore) ||
      !sameNode(lstatSync(path), opened)
    ) {
      throw new Error("trace path changed while it was being opened");
    }
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // 刚建的文件已不在原处：没有可清理的对象。
    }
    throw error;
  }

  const queue: Array<{ tier: Tier; buffer: Buffer }> = [];
  const full: Record<Tier, boolean> = { normal: false, act: false };
  let state: "open" | "failed" | "closed" = "open";
  let closing = false;
  let normalQueued = 0;
  let overflowLogged = false;
  let size = 0;
  let pumping: Promise<void> | undefined;

  function markFull(tier: Tier): void {
    if (full[tier]) return;
    full[tier] = true;
    log(
      tier === "act"
        ? "file reached its size limit; act events are dropped"
        : "file reached its size limit for non-act events; they are dropped",
    );
  }

  async function pump(): Promise<void> {
    while (state === "open" && queue.length > 0) {
      const item = queue.shift()!;
      if (item.tier === "normal") normalQueued -= 1;
      if (full[item.tier]) continue;

      const limit = item.tier === "act" ? maxBytes : normalLimit;
      if (size + item.buffer.length > limit) {
        markFull(item.tier);
        continue;
      }
      try {
        await writeEvent(fd, item.buffer);
        size += item.buffer.length;
      } catch {
        state = "failed";
        queue.length = 0;
        log("write failed; further events are dropped");
        return;
      }
    }
  }

  function schedule(): void {
    if (pumping !== undefined) return;
    pumping = pump().finally(() => {
      pumping = undefined;
      if (state === "open" && queue.length > 0) schedule();
    });
  }

  return {
    path,
    write(event) {
      const tier: Tier = usesActReserve(event) ? "act" : "normal";
      if (state !== "open" || closing || full[tier]) return;

      const limit =
        tier === "act"
          ? TRACE_QUEUE_LIMIT + TRACE_ACT_QUEUE_RESERVE
          : TRACE_QUEUE_LIMIT;
      const queued = tier === "act" ? queue.length : normalQueued;
      if (queued >= limit) {
        if (!overflowLogged) {
          overflowLogged = true;
          log("queue is full; events are being dropped");
        }
        return;
      }
      try {
        queue.push({
          tier,
          buffer: Buffer.from(JSON.stringify(event) + "\n", "utf8"),
        });
      } catch {
        return;
      }
      if (tier === "normal") normalQueued += 1;
      schedule();
    },
    async flush() {
      while (pumping !== undefined) {
        await pumping;
      }
    },
    async close() {
      // 开始关闭后不再接受写入，否则持续写入会无限推迟关闭。
      closing = true;
      while (pumping !== undefined) {
        await pumping;
      }
      if (state !== "closed") {
        state = "closed";
        queue.length = 0;
        closeSync(fd);
      }
    },
  };
}
