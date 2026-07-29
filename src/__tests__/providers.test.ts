import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROVIDER_ORDER,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_ARG_BYTES,
  classifyFailure,
  describeFailureKind,
  resolveProviderOrder,
  resolveTimeoutMs,
  runProvider,
  stripAnsi,
  undentTextFormat,
} from "../providers.js";
import { formatArgv } from "../cli.js";

const raw = (over: Partial<Parameters<typeof classifyFailure>[0]> = {}) => ({
  stdout: "",
  stderr: "",
  code: 1,
  signal: null,
  timedOut: false,
  ...over,
});

const ENV_KEYS = ["CURL_REVIEW_PROVIDERS", "CURL_REVIEW_TIMEOUT"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveProviderOrder", () => {
  it("defaults to the built-in order", () => {
    delete process.env.CURL_REVIEW_PROVIDERS;
    expect(resolveProviderOrder()).toEqual([...DEFAULT_PROVIDER_ORDER]);
  });

  it("honours CURL_REVIEW_PROVIDERS", () => {
    process.env.CURL_REVIEW_PROVIDERS = "codex,claude";
    expect(resolveProviderOrder()).toEqual(["codex", "claude"]);
  });

  it("lets --provider override the environment", () => {
    process.env.CURL_REVIEW_PROVIDERS = "codex";
    expect(resolveProviderOrder("kimi,claude")).toEqual(["kimi", "claude"]);
  });

  it("ignores unknown names and whitespace", () => {
    expect(resolveProviderOrder(" CODEX , bogus ,claude")).toEqual(["codex", "claude"]);
  });

  it("falls back to the default when nothing valid is left", () => {
    expect(resolveProviderOrder("bogus,alsobogus")).toEqual([...DEFAULT_PROVIDER_ORDER]);
  });
});

describe("resolveTimeoutMs", () => {
  it("defaults when unset", () => {
    delete process.env.CURL_REVIEW_TIMEOUT;
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("reads seconds from the environment", () => {
    process.env.CURL_REVIEW_TIMEOUT = "45";
    expect(resolveTimeoutMs()).toBe(45_000);
  });

  it("ignores junk and non-positive values", () => {
    process.env.CURL_REVIEW_TIMEOUT = "abc";
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    process.env.CURL_REVIEW_TIMEOUT = "0";
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    process.env.CURL_REVIEW_TIMEOUT = "-5";
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("classifyFailure", () => {
  it("detects the expired-OAuth failure reported on stdout", () => {
    const message = "Failed to authenticate: OAuth session expired and could not be refreshed";
    expect(classifyFailure(raw({ stdout: message }), message)).toBe("auth");
  });

  it("detects kimi's logged-out message, which names no auth term", () => {
    const message =
      "failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.";
    expect(classifyFailure(raw({ stderr: message }), message)).toBe("auth");
  });

  it("detects usage limits", () => {
    const message = "stream error: exceeded retry limit, last status: 429 Too Many Requests";
    expect(classifyFailure(raw({ stdout: message }), message)).toBe("limit");
  });

  it("detects transient upstream errors", () => {
    expect(classifyFailure(raw({ stderr: "503 service unavailable" }), "failed")).toBe("transient");
  });

  it("reports a missing binary separately from other spawn errors", () => {
    expect(classifyFailure(raw({ spawnError: "kimi: command not found" }), "x")).toBe("missing");
    expect(classifyFailure(raw({ spawnError: "EACCES permission denied" }), "x")).toBe("spawn");
  });

  it("prefers the timeout over pattern matches", () => {
    expect(classifyFailure(raw({ timedOut: true, stdout: "401 unauthorized" }), "t")).toBe(
      "timeout"
    );
  });

  it("treats a clean exit with no usable text as an empty response", () => {
    expect(classifyFailure(raw({ code: 0 }), "provider returned an empty response")).toBe("empty");
  });

  it("falls back to unknown for unrecognised failures", () => {
    expect(classifyFailure(raw({ code: 2, stderr: "boom" }), "boom")).toBe("unknown");
  });
});

describe("describeFailureKind", () => {
  it("gives every kind a human label", () => {
    expect(describeFailureKind("auth")).toBe("authentication");
    expect(describeFailureKind("missing")).toBe("not installed");
    expect(describeFailureKind("limit")).toBe("usage limit");
    expect(describeFailureKind(undefined)).toBe("failed");
  });
});

describe("stripAnsi", () => {
  it("removes colour codes so parsing sees plain text", () => {
    expect(stripAnsi("\x1b[31mSAFE\x1b[0m")).toBe("SAFE");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("## Verdict\nSAFE")).toBe("## Verdict\nSAFE");
  });
});

describe("undentTextFormat", () => {
  it("strips kimi's bullet prefix and two-space indent so headings anchor", () => {
    const raw = "• ## Source\n  A sentence.\n\n  ## Verdict\n  SAFE — ok";
    expect(undentTextFormat(raw)).toBe("## Source\nA sentence.\n\n## Verdict\nSAFE — ok");
  });

  it("leaves already-flat text alone", () => {
    expect(undentTextFormat("## Verdict\nSAFE")).toBe("## Verdict\nSAFE");
  });
});

describe("argv size guard", () => {
  // The guard sits behind the installed-check, so put a stub on PATH. It is
  // never executed: an oversized prompt fails before anything is spawned.
  let stubDir: string;
  let realPath: string | undefined;

  beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), "curl-review-test-"));
    writeFileSync(join(stubDir, "kimi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    realPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${realPath ?? ""}`;
  });

  afterAll(() => {
    process.env.PATH = realPath;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it("refuses to send an oversized script to an argv-only provider", async () => {
    const big = "x".repeat(MAX_PROMPT_ARG_BYTES + 1);
    const attempt = await runProvider("kimi", "Review this.", big, 5_000);
    expect(attempt.ok).toBe(false);
    expect(attempt.kind).toBe("oversize");
    // Fails before spawning, so a truncated script is never reviewed.
    expect(attempt.argv).toEqual([]);
    expect(attempt.hint).toContain("claude");
  });

  it("lets a script under the limit through to the provider", async () => {
    const small = "x".repeat(1000);
    const attempt = await runProvider("kimi", "Review this.", small, 5_000);
    expect(attempt.kind).not.toBe("oversize");
  });
});

describe("formatArgv", () => {
  it("truncates the multi-kilobyte prompt argument", () => {
    const prompt = "x".repeat(2000);
    const out = formatArgv("claude", ["-p", prompt, "--safe-mode"]);
    expect(out).toContain('"claude" "-p"');
    expect(out).toContain("+1940ch");
    expect(out).toContain('"--safe-mode"');
    expect(out.length).toBeLessThan(200);
  });

  it("leaves short arguments intact", () => {
    expect(formatArgv("codex", ["exec", "--color", "never"])).toBe(
      '"codex" "exec" "--color" "never"'
    );
  });
});
