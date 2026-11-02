import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createLogger } from "./logger";

let dir: string;
let logFile: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "logger-"));
  logFile = resolve(dir, "logs/app.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The pino file destination opens asynchronously (sonic-boom, sync:false), so a
// single flush can race the open. Poll the observable outcome — flush, then
// check the file — until the expected line lands, instead of guessing a fixed
// delay that could under-wait on a loaded runner. Bounded so a real failure
// still terminates and surfaces whatever content did land.
async function flushUntil(log: { flush: () => void }, marker: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt++) {
    log.flush();
    if (existsSync(logFile)) {
      const content = readFileSync(logFile, "utf-8");
      if (content.includes(marker))
        return content;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  log.flush();
  return existsSync(logFile)
    ? readFileSync(logFile, "utf-8")
    : "";
}

describe("createLogger", () => {
  test("creates the log directory and file on first write", async () => {
    const log = createLogger({
      LOG_LEVEL: "info",
      LOG_FILE: logFile,
      LOG_TO_STDOUT: false,
      NODE_ENV: "test",
    });
    log.info("hello");
    const content = await flushUntil(log, "hello");
    expect(existsSync(logFile)).toBe(true);
    expect(content).toContain("hello");
  });

  test("sync destination writes through immediately without a flush race (CLI path)", () => {
    // A sync logger opens its fd up front and writes synchronously, so the
    // line is on disk without polling — and pino's exit-time flushSync cannot
    // throw "sonic boom is not ready yet" against a not-yet-open async fd.
    const log = createLogger({
      LOG_LEVEL: "info",
      LOG_FILE: logFile,
      LOG_TO_STDOUT: false,
      NODE_ENV: "test",
    }, { sync: true });
    log.info("sync-line");
    expect(readFileSync(logFile, "utf-8")).toContain("sync-line");
    expect(() => log.flush()).not.toThrow();
  });

  test("supports both string and object payloads", async () => {
    const log = createLogger({
      LOG_LEVEL: "info",
      LOG_FILE: logFile,
      LOG_TO_STDOUT: false,
      NODE_ENV: "test",
    });
    log.info("string-form");
    log.info({ user: "alice" }, "with-context");
    const content = await flushUntil(log, "with-context");
    expect(content).toContain("string-form");
    expect(content).toContain("with-context");
    expect(content).toContain("alice");
  });

  test("falls back to info on an unknown LOG_LEVEL", async () => {
    // Should not throw; the pino instance and dev tee both default to info.
    const log = createLogger({
      LOG_LEVEL: "trace",
      LOG_FILE: logFile,
      LOG_TO_STDOUT: false,
      NODE_ENV: "test",
    });
    log.info("fallback ok");
    expect(await flushUntil(log, "fallback ok")).toContain("fallback ok");
  });

  test("warn / error / fatal / debug all write to the file at their respective levels", async () => {
    const log = createLogger({
      LOG_LEVEL: "debug",
      LOG_FILE: logFile,
      LOG_TO_STDOUT: false,
      NODE_ENV: "test",
    });
    log.debug("d");
    log.warn("w");
    log.error({ x: 1 }, "e");
    log.fatal("f");
    const content = await flushUntil(log, "\"f\"");
    expect(content).toContain("\"d\"");
    expect(content).toContain("\"w\"");
    expect(content).toContain("\"e\"");
    expect(content).toContain("\"f\"");
  });

  test("redacts sensitive fields at the top level", async () => {
    const log = createLogger({
      LOG_LEVEL: "info",
      LOG_FILE: logFile,
      LOG_TO_STDOUT: false,
      NODE_ENV: "test",
    });
    log.info({
      user: { password: "secret" },
      session: { token: "abc" },
    }, "redact-test");
    const content = await flushUntil(log, "redact-test");
    expect(content).not.toContain("secret");
    expect(content).not.toContain("abc");
    expect(content).toContain("REDACTED");
  });

  test("redacts sensitive fields nested below the first level", async () => {
    // Earlier the redact paths were `*.password` / `*.token` etc. which only
    // matched one level below the root. A nested layout like the request
    // metadata bundle below would have leaked the cleartext credentials.
    const log = createLogger({
      LOG_LEVEL: "info",
      LOG_FILE: logFile,
      LOG_TO_STDOUT: false,
      NODE_ENV: "test",
    });
    log.info(
      {
        outer: {
          ctx: {
            user: { password: "deep-secret-pw" },
            api: { authorization: "Bearer deep-secret-token" },
          },
        },
      },
      "deep-redact-test",
    );
    const content = await flushUntil(log, "deep-redact-test");
    expect(content).not.toContain("deep-secret-pw");
    expect(content).not.toContain("deep-secret-token");
    expect(content).toContain("REDACTED");
  });
});
