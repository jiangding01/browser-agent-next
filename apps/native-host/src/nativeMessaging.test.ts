import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  encodeNativeMessage,
  NativeMessagingTransport,
} from "./nativeMessaging.js";

describe("NativeMessagingTransport", () => {
  it("可以跨任意 chunk 边界解析 Chrome Native Messaging frame", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new NativeMessagingTransport({
      input,
      output,
    });

    const messages: unknown[] = [];
    transport.on("message", (message) => {
      messages.push(message);
    });
    transport.start();

    const frame = encodeNativeMessage({
      type: "trusted-host.result",
      requestId: "req-1",
      ok: true,
      result: { value: 1 },
    });

    input.write(frame.subarray(0, 2));
    input.write(frame.subarray(2, 7));
    input.write(frame.subarray(7));

    await new Promise((resolve) => setImmediate(resolve));

    expect(messages).toEqual([{
      type: "trusted-host.result",
      requestId: "req-1",
      ok: true,
      result: { value: 1 },
    }]);
  });

  it("发送时使用 4 字节 little-endian 长度头", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];

    output.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });

    const transport = new NativeMessagingTransport({
      input,
      output,
    });

    expect(transport.send({ ok: true })).toBe(true);

    const frame = Buffer.concat(chunks);
    expect(frame.readUInt32LE(0)).toBe(
      Buffer.byteLength(JSON.stringify({ ok: true })),
    );
    expect(JSON.parse(frame.subarray(4).toString("utf8"))).toEqual({
      ok: true,
    });
  });
  it("底层写入抛错时立即返回 false，不伪装为成功发送", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const originalWrite = output.write.bind(output);

    let calls = 0;
    output.write = ((...args: Parameters<typeof originalWrite>) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("broken pipe");
      }
      return originalWrite(...args);
    }) as typeof output.write;

    const transport = new NativeMessagingTransport({
      input,
      output,
    });

    expect(
      transport.send({
        type: "trusted-host.result",
        requestId: "req-write-fail",
      }),
    ).toBe(false);
  });
});
