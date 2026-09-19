import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

const MAX_INBOUND_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_OUTBOUND_MESSAGE_BYTES = 900 * 1024;

export interface NativeMessagingOptions {
  input?: Readable;
  output?: Writable;
}

export class NativeMessagingTransport extends EventEmitter {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private started = false;
  private closed = false;

  private readonly input: Readable;
  private readonly output: Writable;
  private readonly onDataBound = (chunk: Buffer): void => {
    this.onData(chunk);
  };

  constructor(options: NativeMessagingOptions = {}) {
    super();
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;

    // Chrome 断开 Native Messaging pipe 时可能触发 EPIPE。
    // stdout 不能把异常冒泡成未处理错误导致随机崩溃。
    this.output.on("error", (error) => {
      this.emit("transport-error", error);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.input.on("data", this.onDataBound);
    this.input.once("end", () => this.close());
    this.input.once("error", (error) => {
      this.emit("transport-error", error);
      this.close();
    });
  }

  send(message: unknown): boolean {
    if (this.closed) return false;

    const payload = Buffer.from(
      JSON.stringify(message),
      "utf8",
    );

    if (payload.length > MAX_OUTBOUND_MESSAGE_BYTES) {
      return false;
    }

    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length, 0);

    try {
      this.output.write(header);
      this.output.write(payload);
      return true;
    } catch (error) {
      this.emit("transport-error", error);

      // header 可能已经写入。继续发送下一帧会让 Chrome 端长度流失步，
      // 因此任何同步写异常都必须关闭当前 transport，等待进程/pipe 重建。
      this.close();
      return false;
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;

    this.chunks.push(chunk);
    this.buffered += chunk.length;

    while (this.buffered >= 4) {
      const length = this.peekLength();

      if (length > MAX_INBOUND_MESSAGE_BYTES) {
        this.emit(
          "transport-error",
          new Error(
            "native inbound frame exceeds " +
              MAX_INBOUND_MESSAGE_BYTES +
              " bytes",
          ),
        );
        this.close();
        return;
      }

      if (this.buffered < 4 + length) return;

      const frame = this.consume(4 + length);
      const json = frame.subarray(4).toString("utf8");

      try {
        this.emit("message", JSON.parse(json));
      } catch (error) {
        // 单个 JSON 损坏不重同步长度流；frame 边界已经明确，
        // 因此可以丢弃该 frame 并继续。
        this.emit("parse-error", error);
      }
    }
  }

  private peekLength(): number {
    const first = this.chunks[0];

    if (first && first.length >= 4) {
      return first.readUInt32LE(0);
    }

    const header = Buffer.alloc(4);
    let offset = 0;

    for (const chunk of this.chunks) {
      const take = Math.min(
        4 - offset,
        chunk.length,
      );
      chunk.copy(header, offset, 0, take);
      offset += take;
      if (offset === 4) break;
    }

    return header.readUInt32LE(0);
  }

  private consume(size: number): Buffer {
    const parts: Buffer[] = [];
    let remaining = size;

    while (remaining > 0) {
      const head = this.chunks[0];
      if (!head) break;

      if (head.length <= remaining) {
        parts.push(head);
        remaining -= head.length;
        this.chunks.shift();
      } else {
        parts.push(head.subarray(0, remaining));
        this.chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }

    this.buffered -= size;

    return parts.length === 1
      ? parts[0]!
      : Buffer.concat(parts, size);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onDataBound);
    this.input.pause();
    this.chunks = [];
    this.buffered = 0;
    this.emit("close");
  }
}

export function encodeNativeMessage(
  message: unknown,
): Buffer {
  const payload = Buffer.from(
    JSON.stringify(message),
    "utf8",
  );
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}
