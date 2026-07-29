// Agent CLI providers used to run the security review.
//
// Each provider is a locally installed coding-agent CLI driven non-interactively.
// They are tried in order until one returns a usable review, so a broken or
// logged-out primary provider degrades to a fallback instead of a dead end.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const CACHE_DIR = join(homedir(), ".cache", "curl-review");
export const DEBUG_LOG = join(CACHE_DIR, "last-error.log");

/** Providers are tried in this order unless overridden. */
export const DEFAULT_PROVIDER_ORDER = ["claude", "codex", "kimi"] as const;

export type ProviderId = (typeof DEFAULT_PROVIDER_ORDER)[number];

export type FailureKind =
  | "missing"
  | "spawn"
  | "auth"
  | "limit"
  | "timeout"
  | "transient"
  | "empty"
  | "oversize"
  | "unknown";

/**
 * How a provider receives the script.
 *   stdin         — instructions in argv, script piped (no size limit).
 *   stdin-merged  — instructions and script both piped as one message.
 *   arg-merged    — instructions and script both in one argv item, because the
 *                   CLI ignores stdin entirely. Bounded by MAX_PROMPT_ARG_BYTES.
 */
type PromptMode = "stdin" | "stdin-merged" | "arg-merged";

/**
 * Linux caps a single argv string at MAX_ARG_STRLEN (128 KB) regardless of the
 * much larger ARG_MAX total. Stay under it with headroom for the instructions.
 */
export const MAX_PROMPT_ARG_BYTES = 120 * 1024;

function mergeScript(prompt: string, script: string): string {
  // No script to attach (doctor's healthcheck) — don't wrap an empty block.
  if (!script) return prompt;
  return `${prompt}\n\n--- BEGIN SCRIPT ---\n${script}\n--- END SCRIPT ---\n`;
}

export interface RunContext {
  /** Per-run scratch directory; providers that need an output file write here. */
  scratchDir: string;
}

interface ProviderSpec {
  id: ProviderId;
  label: string;
  bin: string;
  installHint: string;
  authHint: string;
  promptMode: PromptMode;
  /** Preferred argv — hermetic and tool-free where the CLI supports it. */
  buildArgs(prompt: string, ctx: RunContext): string[];
  /** Reduced argv retried when the CLI rejects one of the preferred flags. */
  minimalArgs(prompt: string, ctx: RunContext): string[];
  /** Pull the review text (or an error) out of a completed run. */
  parse(raw: RawRun, ctx: RunContext): { text: string; error?: string };
  /** Best-effort auth probe for display only — never gates the attempt. */
  probeAuth?(): boolean | undefined;
}

interface RawRun {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  timedOut: boolean;
}

export interface Attempt {
  provider: ProviderId;
  label: string;
  argv: string[];
  ok: boolean;
  text: string;
  /** Human-readable failure reason; undefined when ok. */
  error?: string;
  kind?: FailureKind;
  hint?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  installed: boolean;
  /** undefined when the CLI gives no reliable way to check. */
  authed?: boolean;
  installHint: string;
  authHint: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --- Provider definitions ---------------------------------------------------

const claude: ProviderSpec = {
  id: "claude",
  label: "Claude",
  bin: "claude",
  installHint: "npm i -g @anthropic-ai/claude-code",
  authHint: "claude /login",
  promptMode: "stdin",
  // --safe-mode skips the invoking project's CLAUDE.md/hooks/MCP servers, and
  // --tools "" denies the agent every tool: the reviewed script is untrusted
  // input, so the model gets no way to act on instructions hidden inside it.
  buildArgs: (prompt) => [
    "-p",
    prompt,
    "--safe-mode",
    "--tools",
    "",
    "--output-format",
    "json",
  ],
  minimalArgs: (prompt) => ["-p", prompt],
  parse: (raw) => {
    const stdout = stripAnsi(raw.stdout).trim();
    // --output-format json wraps both success and API errors in one object, and
    // the message for a failed run lives in `result`, not on stderr.
    try {
      const parsed = JSON.parse(stdout) as {
        is_error?: boolean;
        result?: string;
        subtype?: string;
        api_error_status?: number | null;
        terminal_reason?: string;
      };
      const message = typeof parsed.result === "string" ? parsed.result.trim() : "";
      if (parsed.is_error) {
        const status = parsed.api_error_status ? ` (HTTP ${parsed.api_error_status})` : "";
        return { text: "", error: `${message || parsed.terminal_reason || "API error"}${status}` };
      }
      return { text: message };
    } catch {
      // Older CLIs, or a hard failure that printed plain text instead of JSON.
      return { text: stdout };
    }
  },
  probeAuth: () => {
    try {
      const out = execFileSync("claude", ["auth", "status"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      return out.includes('"loggedIn": true');
    } catch {
      return false;
    }
  },
};

const CODEX_RESULT_FILE = "codex-result.txt";

const codex: ProviderSpec = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  installHint: "npm i -g @openai/codex",
  authHint: "codex login",
  promptMode: "stdin",
  // `codex exec` appends piped stdin to the prompt as a <stdin> block.
  // --ignore-user-config/--ephemeral keep the user's MCP servers, hooks and
  // session history out of a one-shot review; -o gives a clean final message
  // instead of scraping it from the event log on stdout.
  buildArgs: (prompt, ctx) => [
    "exec",
    prompt,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ephemeral",
    "--color",
    "never",
    "-o",
    join(ctx.scratchDir, CODEX_RESULT_FILE),
  ],
  minimalArgs: (prompt, ctx) => [
    "exec",
    prompt,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-o",
    join(ctx.scratchDir, CODEX_RESULT_FILE),
  ],
  parse: (raw, ctx) => {
    try {
      const text = readFileSync(join(ctx.scratchDir, CODEX_RESULT_FILE), "utf-8").trim();
      if (text) return { text };
    } catch {
      // Fall through to the stdout transcript below.
    }
    return { text: stripAnsi(raw.stdout).trim() };
  },
};

const kimi: ProviderSpec = {
  id: "kimi",
  label: "Kimi",
  bin: "kimi",
  installHint: "npm i -g @moonshot-ai/kimi-code",
  authHint: "kimi login",
  // kimi-code's prompt mode ignores stdin entirely, so the script has to ride
  // along in the prompt argument.
  promptMode: "arg-merged",
  // Plain text output prefixes the first line with "• " and indents the rest by
  // two spaces, which breaks markdown heading parsing; stream-json carries the
  // assistant's raw markdown instead. Note --plan is rejected alongside
  // --prompt, and without -y/--auto tool calls are never auto-approved — so the
  // reviewed script cannot talk the agent into running anything.
  buildArgs: (prompt) => ["-p", prompt, "--output-format", "stream-json"],
  minimalArgs: (prompt) => ["-p", prompt],
  parse: (raw) => {
    const stdout = stripAnsi(raw.stdout).trim();
    const chunks: string[] = [];
    let sawJson = false;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const event = JSON.parse(trimmed) as { role?: string; content?: string };
        sawJson = true;
        // Skip the trailing meta event carrying the resume hint.
        if (event.role === "assistant" && typeof event.content === "string") {
          chunks.push(event.content);
        }
      } catch {
        // Not an event line; ignore.
      }
    }
    if (sawJson) return { text: chunks.join("\n").trim() };
    // minimalArgs fallback emits the indented text format instead.
    return { text: undentTextFormat(stdout) };
  },
  probeAuth: () => {
    try {
      const out = execFileSync("kimi", ["provider", "list"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      return !/no providers configured/i.test(out) && /default model:/i.test(out);
    } catch {
      return false;
    }
  },
};

/** Undo kimi's text layout: "• " on the first line, two-space indent after. */
export function undentTextFormat(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^• /, "").replace(/^ {2}/, ""))
    .join("\n")
    .trim();
}

const SPECS: Record<ProviderId, ProviderSpec> = { claude, codex, kimi };

// --- Selection --------------------------------------------------------------

function parseList(value: string | undefined): ProviderId[] | undefined {
  if (!value) return undefined;
  const ids = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((s): s is ProviderId => s in SPECS);
  return ids.length ? ids : undefined;
}

/**
 * Resolve which providers to try, in order.
 * `only` (--provider) wins over CURL_REVIEW_PROVIDERS, which wins over the default.
 */
export function resolveProviderOrder(only?: string): ProviderId[] {
  const forced = parseList(only);
  if (forced) return forced;
  return parseList(process.env.CURL_REVIEW_PROVIDERS) ?? [...DEFAULT_PROVIDER_ORDER];
}

/** Installed-and-authenticated snapshot, for the info table and menu gating. */
export function probeProviders(order: ProviderId[]): ProviderStatus[] {
  return order.map((id) => {
    const spec = SPECS[id];
    const installed = commandExists(spec.bin);
    return {
      id,
      label: spec.label,
      installed,
      // A passing probe does not guarantee the next request authenticates —
      // an expired refresh token still reports loggedIn — so this is display only.
      authed: installed && spec.probeAuth ? spec.probeAuth() : undefined,
      installHint: spec.installHint,
      authHint: spec.authHint,
    };
  });
}

// --- Execution --------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 180_000;

export function resolveTimeoutMs(): number {
  const raw = process.env.CURL_REVIEW_TIMEOUT;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_MS;
  return seconds * 1000;
}

function spawnProvider(
  bin: string,
  argv: string[],
  stdin: string,
  timeoutMs: number
): Promise<RawRun> {
  return new Promise((resolve) => {
    let settled = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let spawnError: string | undefined;
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];

    // detached puts the provider in its own process group so a timeout can take
    // down the helpers it spawned too — otherwise a surviving grandchild holds
    // our stdout pipe open and 'close' never fires.
    const child = spawn(bin, argv, { stdio: ["pipe", "pipe", "pipe"], detached: true });

    const signalChild = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // Already gone.
        }
      }
    };

    // Detaching also detaches the child from the terminal's SIGINT, so forward
    // it by hand rather than leaving an orphaned provider behind on Ctrl-C.
    const onInterrupt = () => {
      signalChild("SIGKILL");
      process.exit(130);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      resolve({
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        code,
        signal,
        spawnError,
        timedOut,
      });
    };

    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalChild("SIGTERM");
      }, timeoutMs),
      // Some agent CLIs ignore SIGTERM while a request is in flight.
      setTimeout(() => {
        if (!settled) signalChild("SIGKILL");
      }, timeoutMs + 5_000),
      // Last resort: stop waiting on pipes an unkillable orphan may still hold.
      setTimeout(() => {
        if (settled) return;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, "SIGKILL");
      }, timeoutMs + 8_000)
    );

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));

    // Without this the process dies on ENOENT instead of reporting a usable error.
    child.on("error", (e: NodeJS.ErrnoException) => {
      spawnError = e.code === "ENOENT" ? `${bin}: command not found` : e.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    // A provider that exits before reading stdin turns the write into EPIPE;
    // that is already reflected in the exit code, so swallow it.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

const UNKNOWN_FLAG =
  /(unknown|unrecognized|unexpected|invalid|unsupported)\s+(option|argument|flag|subcommand)|error: unexpected argument/i;

/** Run one provider, retrying once with reduced flags if the CLI rejected them. */
export async function runProvider(
  id: ProviderId,
  prompt: string,
  script: string,
  timeoutMs: number
): Promise<Attempt> {
  const spec = SPECS[id];
  const base: Omit<Attempt, "ok" | "text" | "code" | "signal" | "timedOut" | "durationMs" | "stdout" | "stderr" | "argv"> =
    { provider: id, label: spec.label };

  if (!commandExists(spec.bin)) {
    return {
      ...base,
      argv: [],
      ok: false,
      text: "",
      error: `${spec.bin} is not installed`,
      kind: "missing",
      hint: spec.installHint,
      code: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
    };
  }

  const merged = mergeScript(prompt, script);
  const promptArg = spec.promptMode === "arg-merged" ? merged : prompt;
  const stdin =
    spec.promptMode === "stdin" ? script : spec.promptMode === "stdin-merged" ? merged : "";

  // A provider that can only take the script through argv has a hard size
  // ceiling. Truncating would hide whatever is in the omitted tail, so fail
  // this provider instead of returning a review of a partial script.
  const argBytes = Buffer.byteLength(promptArg);
  if (spec.promptMode === "arg-merged" && argBytes > MAX_PROMPT_ARG_BYTES) {
    return {
      ...base,
      argv: [],
      ok: false,
      text: "",
      error: `script is too large to pass to ${spec.bin} (${Math.round(argBytes / 1024)} KB exceeds the ${Math.round(MAX_PROMPT_ARG_BYTES / 1024)} KB argument limit)`,
      kind: "oversize",
      hint: "use --provider claude or codex — they stream the script via stdin",
      code: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
    };
  }

  const scratchDir = mkdtempSync(join(tmpdir(), "curl-review-"));
  const ctx: RunContext = { scratchDir };

  const started = Date.now();
  try {
    let argv = spec.buildArgs(promptArg, ctx);
    let raw = await spawnProvider(spec.bin, argv, stdin, timeoutMs);

    // Older provider versions may not know the hardening flags; drop to the
    // minimal invocation rather than reporting a spurious failure.
    if (raw.code !== 0 && UNKNOWN_FLAG.test(stripAnsi(raw.stderr + raw.stdout))) {
      const fallbackArgv = spec.minimalArgs(promptArg, ctx);
      if (JSON.stringify(fallbackArgv) !== JSON.stringify(argv)) {
        argv = fallbackArgv;
        raw = await spawnProvider(spec.bin, argv, stdin, timeoutMs);
      }
    }

    const durationMs = Date.now() - started;
    const parsed = raw.spawnError ? { text: "", error: raw.spawnError } : spec.parse(raw, ctx);
    const failed = raw.timedOut || raw.spawnError !== undefined || raw.code !== 0 || !!parsed.error;

    const shared = {
      ...base,
      argv,
      code: raw.code,
      signal: raw.signal,
      timedOut: raw.timedOut,
      durationMs,
      stdout: stripAnsi(raw.stdout),
      stderr: stripAnsi(raw.stderr),
    };

    if (!failed && parsed.text) {
      return { ...shared, ok: true, text: parsed.text };
    }

    const error = failureMessage(raw, parsed.error, parsed.text);
    const kind = classifyFailure(raw, error);
    return {
      ...shared,
      ok: false,
      text: parsed.text,
      error,
      kind,
      hint: hintFor(kind, spec),
    };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // Skip the ISO-timestamped log noise some CLIs emit before the real message.
    if (trimmed && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(trimmed)) return trimmed;
  }
  return "";
}

function failureMessage(raw: RawRun, parsedError: string | undefined, parsedText: string): string {
  if (raw.spawnError) return raw.spawnError;
  if (raw.timedOut) return "provider timed out";
  if (parsedError) return parsedError;
  const stderrLine = firstMeaningfulLine(stripAnsi(raw.stderr));
  if (stderrLine) return stderrLine;
  const stdoutLine = firstMeaningfulLine(stripAnsi(raw.stdout));
  if (stdoutLine) return stdoutLine;
  if (raw.code !== 0) return `exited with code ${raw.code}`;
  if (!parsedText) return "provider returned an empty response";
  return "provider failed";
}

const PATTERNS: [FailureKind, RegExp][] = [
  [
    "auth",
    // The last few alternatives cover kimi-code's "No model configured. Run
    // `kimi` and use /login to sign in", which names no auth term directly.
    /oauth|not authenticated|authentication[_ ]failed|failed to authenticate|unauthorized|invalid[_ ]api[_ ]key|401|credentials|(please |use )?\/?log ?in\b|sign in\b|not logged in|no model configured|no providers configured/i,
  ],
  [
    "limit",
    /rate.?limit|usage limit|quota|429|credit balance|insufficient (funds|credit|balance)|too many requests/i,
  ],
  ["transient", /\b5\d{2}\b|overloaded|internal server error|service unavailable|network|ECONNRESET|ETIMEDOUT|fetch failed/i],
];

export function classifyFailure(raw: RawRun, message: string): FailureKind {
  if (raw.spawnError) return raw.spawnError.includes("not found") ? "missing" : "spawn";
  if (raw.timedOut) return "timeout";
  const haystack = `${message}\n${stripAnsi(raw.stdout)}\n${stripAnsi(raw.stderr)}`;
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(haystack)) return kind;
  }
  if (raw.code === 0) return "empty";
  return "unknown";
}

function hintFor(kind: FailureKind, spec: ProviderSpec): string | undefined {
  switch (kind) {
    case "missing":
      return spec.installHint;
    case "auth":
      return spec.authHint;
    case "limit":
      return "wait for the limit to reset, or try another provider";
    case "timeout":
      return "raise the timeout with CURL_REVIEW_TIMEOUT=<seconds>";
    case "transient":
      return "transient upstream error — retry";
    default:
      return undefined;
  }
}

export function describeFailureKind(kind: FailureKind | undefined): string {
  switch (kind) {
    case "missing":
      return "not installed";
    case "spawn":
      return "could not start";
    case "auth":
      return "authentication";
    case "limit":
      return "usage limit";
    case "timeout":
      return "timed out";
    case "transient":
      return "service error";
    case "empty":
      return "empty response";
    case "oversize":
      return "script too large";
    default:
      return "failed";
  }
}

// --- Diagnostics ------------------------------------------------------------

const LOG_STREAM_LIMIT = 40_000;

function clip(text: string): string {
  return text.length > LOG_STREAM_LIMIT
    ? `${text.slice(0, LOG_STREAM_LIMIT)}\n…[truncated ${text.length - LOG_STREAM_LIMIT} chars]`
    : text;
}

/**
 * Smallest possible real request, used by `doctor` to tell a working provider
 * from one that merely looks configured. Deliberately not a review prompt —
 * we're testing the transport and credentials, not the model's judgement.
 */
export const HEALTHCHECK_PROMPT =
  "Reply with the single word OK and nothing else. Do not use any tools.";

export interface HealthResult {
  status: ProviderStatus;
  attempt?: Attempt;
}

/**
 * Round-trip every installed provider. `claude auth status` reports a live
 * session when the refresh token is already dead, so the only trustworthy
 * check is an actual request.
 */
export async function checkProviderHealth(
  order: ProviderId[],
  timeoutMs: number
): Promise<HealthResult[]> {
  const statuses = probeProviders(order);
  const results: HealthResult[] = [];
  for (const status of statuses) {
    if (!status.installed) {
      results.push({ status });
      continue;
    }
    results.push({
      status,
      attempt: await runProvider(status.id, HEALTHCHECK_PROMPT, "", timeoutMs),
    });
  }
  return results;
}

/** Persist full provider output so a failure is debuggable after the fact. */
export function writeDebugLog(url: string, attempts: Attempt[]): string | undefined {
  const body = [
    `curl-review provider failure log`,
    `timestamp: ${new Date().toISOString()}`,
    `url: ${url}`,
    "",
    ...attempts.map((a) =>
      [
        `=== ${a.provider} ===`,
        `argv:     ${[a.provider, ...a.argv].map((s) => JSON.stringify(s)).join(" ")}`,
        `exit:     ${a.code}${a.signal ? ` (signal ${a.signal})` : ""}${a.timedOut ? " [timed out]" : ""}`,
        `duration: ${(a.durationMs / 1000).toFixed(1)}s`,
        `kind:     ${a.kind ?? "ok"}`,
        `error:    ${a.error ?? "-"}`,
        `--- stdout ---`,
        clip(a.stdout) || "(empty)",
        `--- stderr ---`,
        clip(a.stderr) || "(empty)",
        "",
      ].join("\n")
    ),
  ].join("\n");

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(DEBUG_LOG, body);
    return DEBUG_LOG;
  } catch {
    return undefined;
  }
}
