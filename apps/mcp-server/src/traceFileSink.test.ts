import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { RuntimeTraceEvent } from "@browser-agent-next/core";
import {
  MIN_TRACE_MAX_BYTES,
  TRACE_ACT_QUEUE_RESERVE,
  TRACE_QUEUE_LIMIT,
  openTraceFileSink,
} from "./traceFileSink.js";

const FILE_NAME = "trace-0b6f9d2e-1c4a-4f7e-9a3b-5d8c2e1f0a4b.jsonl";

function event(seq: number, tool?: RuntimeTraceEvent["tool"]): RuntimeTraceEvent {
  return {
    schemaVersion: 1,
    ts: 1_761_700_000_000 + seq,
    runId: "0b6f9d2e-1c4a-4f7e-9a3b-5d8c2e1f0a4b",
    sessionId: "7a1e3c5b-9d2f-4e6a-8b0c-1f3d5e7a9c2b",
    seq,
    event: "observe",
    outcome: "ok",
    ...(tool !== undefined ? { tool } : {}),
  };
}

function lines(path: string): RuntimeTraceEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RuntimeTraceEvent);
}

describe.runIf(process.platform !== "win32")("openTraceFileSink", () => {
  let root: string;
  let dir: string;
  let logs: string[];
  const log = (message: string) => {
    logs.push(message);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ban-trace-"));
    dir = join(root, "traces");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    logs = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a new 0600 file named by run id and appends one JSON line per event", async () => {
    const sink = openTraceFileSink({ directory: dir, fileName: FILE_NAME, log });
    sink.write(event(1));
    sink.write(event(2));
    await sink.close();

    expect(sink.path).toBe(join(dir, FILE_NAME));
    expect(statSync(sink.path).mode & 0o777).toBe(0o600);
    expect(lines(sink.path).map((item) => item.seq)).toEqual([1, 2]);
    expect(logs).toEqual([]);
  });

  it("never opens an existing file, and leaves it untouched", () => {
    const existing = join(dir, FILE_NAME);
    writeFileSync(existing, "trusted-token\n", { mode: 0o600 });

    expect(() => openTraceFileSink({ directory: dir, fileName: FILE_NAME, log })).toThrow();
    expect(readFileSync(existing, "utf8")).toBe("trusted-token\n");
  });

  it("refuses a symlink planted at the file name, and leaves its target untouched", () => {
    const target = join(root, "id_ed25519");
    writeFileSync(target, "private key\n", { mode: 0o600 });
    symlinkSync(target, join(dir, FILE_NAME));

    expect(() => openTraceFileSink({ directory: dir, fileName: FILE_NAME, log })).toThrow();
    expect(readFileSync(target, "utf8")).toBe("private key\n");
  });

  it("refuses a symlinked directory", () => {
    const linked = join(root, "linked");
    symlinkSync(dir, linked);

    expect(() => openTraceFileSink({ directory: linked, fileName: FILE_NAME, log })).toThrow(
      /not a symlink/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a directory readable or writable by others", () => {
    for (const mode of [0o750, 0o755, 0o777]) {
      chmodSync(dir, mode);
      expect(() => openTraceFileSink({ directory: dir, fileName: FILE_NAME, log })).toThrow(
        /permissions are too broad/,
      );
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects relative directories, bad file names and out-of-range maxBytes", () => {
    expect(() => openTraceFileSink({ directory: "traces", fileName: FILE_NAME, log })).toThrow(
      /absolute/,
    );
    for (const fileName of ["../trace.jsonl", "trace.jsonl", "trace-" + "x".repeat(36) + ".jsonl"]) {
      expect(() => openTraceFileSink({ directory: dir, fileName, log })).toThrow(/file name/);
    }
    for (const maxBytes of [MIN_TRACE_MAX_BYTES - 1, 256 * 1024 * 1024 + 1, 1.5]) {
      expect(() =>
        openTraceFileSink({ directory: dir, fileName: FILE_NAME, maxBytes, log }),
      ).toThrow(/maxBytes/);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops non-act events at 3/4 of the size limit while act events keep the rest", async () => {
    const sink = openTraceFileSink({
      directory: dir,
      fileName: FILE_NAME,
      maxBytes: MIN_TRACE_MAX_BYTES,
      log,
    });
    // 行长随 seq 位数变化：按实际字节逐行累计普通档能容纳的条数。
    const normalLimit = Math.floor((MIN_TRACE_MAX_BYTES * 3) / 4);
    let normalCapacity = 0;
    for (let used = 0; ; normalCapacity += 1) {
      const next = used + JSON.stringify(event(normalCapacity + 1)).length + 1;
      if (next > normalLimit) break;
      used = next;
    }

    let seq = 0;
    // 分批写，避免先撞上队列上限。
    while (seq < normalCapacity + 20) {
      for (let i = 0; i < 100 && seq < normalCapacity + 20; i += 1) {
        seq += 1;
        sink.write(event(seq));
      }
      await sink.flush();
    }
    sink.write(event(seq + 1, "browser.act"));
    await sink.close();

    const written = lines(sink.path);
    expect(written.filter((item) => item.tool === undefined)).toHaveLength(normalCapacity);
    expect(written.at(-1)).toMatchObject({ seq: seq + 1, tool: "browser.act" });
    expect(statSync(sink.path).size).toBeLessThanOrEqual(MIN_TRACE_MAX_BYTES);
    expect(logs).toEqual([
      "file reached its size limit for non-act events; they are dropped",
    ]);
  });

  it("keeps a queue reserve for act events once the normal queue is full", async () => {
    const sink = openTraceFileSink({ directory: dir, fileName: FILE_NAME, log });
    for (let seq = 1; seq <= TRACE_QUEUE_LIMIT + 50; seq += 1) {
      sink.write(event(seq));
    }
    for (let seq = 1; seq <= TRACE_ACT_QUEUE_RESERVE; seq += 1) {
      sink.write(event(100_000 + seq, "browser.act"));
    }
    await sink.close();

    const written = lines(sink.path);
    const normal = written.filter((item) => item.tool === undefined);
    expect(normal.length).toBeGreaterThanOrEqual(TRACE_QUEUE_LIMIT);
    expect(normal.length).toBeLessThan(TRACE_QUEUE_LIMIT + 50);
    expect(written.filter((item) => item.tool === "browser.act")).toHaveLength(
      TRACE_ACT_QUEUE_RESERVE,
    );
    expect(logs).toEqual(["queue is full; events are being dropped"]);
  });

  it("never throws from write, even after close", async () => {
    const sink = openTraceFileSink({ directory: dir, fileName: FILE_NAME, log });
    await sink.close();

    expect(() => sink.write(event(1))).not.toThrow();
    await sink.close();
    expect(lines(sink.path)).toEqual([]);
  });
});
