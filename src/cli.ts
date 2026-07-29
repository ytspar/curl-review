#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { select, confirm, Separator } from "@inquirer/prompts";
import ora from "ora";
import { banner, c, createTable, formatBytes, noColor, sym, verdictBadge } from "./formatter.js";
import {
  type Attempt,
  CACHE_DIR,
  DEFAULT_PROVIDER_ORDER,
  type ProviderId,
  type ProviderStatus,
  checkProviderHealth,
  commandExists,
  describeFailureKind,
  probeProviders,
  resolveProviderOrder,
  resolveTimeoutMs,
  runProvider,
  writeDebugLog,
} from "./providers.js";

const program = new Command()
  .name("curl-review")
  .description("Safely inspect and optionally execute curl|sh install scripts")
  .version("0.4.1")
  // The program takes both a <url> argument and a `doctor` subcommand. Without
  // this, commander binds options appearing after `doctor` to the root command,
  // so `doctor --provider x` silently checked every provider instead.
  .enablePositionalOptions();

program
  .command("doctor")
  .description("Check that each reviewer CLI is installed, authenticated, and responding")
  .option(
    "-p, --provider <names>",
    `Reviewer CLI(s) to check (default: ${DEFAULT_PROVIDER_ORDER.join(",")})`
  )
  .option("-d, --debug", "Print full reviewer output for failures")
  .action(runDoctor);

program
  .argument("<url>", "URL of the script to review")
  .option("-o, --original <command>", "Original intercepted command")
  .option("-e, --execute", "Non-interactive: review then execute")
  .option("-y, --yes", "Auto-execute only if verdict is SAFE")
  .option(
    "-r, --review",
    "Non-interactive: review only, never execute (exit 0 SAFE, 1 DANGEROUS, 2 CAUTION, 3 no verdict)"
  )
  .option(
    "-p, --provider <names>",
    `Reviewer CLI(s) to try, in order (default: ${DEFAULT_PROVIDER_ORDER.join(",")})`
  )
  .option("-d, --debug", "Print full reviewer output on failure")
  .action(main);

/**
 * Round-trip each reviewer so the user can tell a working provider from one
 * that merely looks configured. Exits 0 if any reviewer answered.
 */
async function runDoctor(opts: { provider?: string; debug?: boolean }) {
  console.log(banner("0.4.1"));

  const order = resolveProviderOrder(opts.provider);
  // A health probe shouldn't sit for the full review timeout, but the cap still
  // needs slack: these CLIs answer this one-word prompt in 4-30s normally and
  // have been seen to take over a minute just to start on a loaded machine.
  // Reporting a working reviewer as timed out is worse than waiting.
  const timeoutMs = Math.min(resolveTimeoutMs(), 120_000);
  const spinner = ora(`Checking ${order.length} reviewer(s)`).start();
  const results = await checkProviderHealth(order, timeoutMs);
  spinner.stop();

  const failures: Attempt[] = [];
  for (const { status, attempt } of results) {
    if (!attempt) {
      console.log(`  ${sym.cross} ${c.bold(status.label.padEnd(8))} ${c.dim("not installed")}`);
      console.log(`  ${" ".repeat(11)}${sym.arrow} ${c.yellow(status.installHint)}`);
      continue;
    }
    if (attempt.ok) {
      console.log(
        `  ${sym.check} ${c.bold(status.label.padEnd(8))} ${c.green("ok")} ${c.dim(`· ${(attempt.durationMs / 1000).toFixed(1)}s`)}`
      );
      continue;
    }
    failures.push(attempt);
    console.log(
      `  ${sym.cross} ${c.bold(status.label.padEnd(8))} ${c.dim(
        `${describeFailureKind(attempt.kind)} · exit ${attempt.code} · ${(attempt.durationMs / 1000).toFixed(1)}s`
      )}`
    );
    if (attempt.error) {
      for (const line of wrap(attempt.error, 64)) console.log(`  ${" ".repeat(11)}${line}`);
    }
    if (attempt.hint) {
      console.log(`  ${" ".repeat(11)}${sym.arrow} ${c.yellow(attempt.hint)}`);
    }
    // An authenticated-looking provider that fails a real request is exactly
    // the case a status check misses, so call it out.
    if (attempt.kind === "auth" && status.authed) {
      console.log(
        `  ${" ".repeat(11)}${c.dim("(reports itself as logged in — the stored token no longer works)")}`
      );
    }
  }

  const working = results.filter((r) => r.attempt?.ok).length;
  blankLine();
  const summary = `${working} of ${results.length} reviewer(s) working.`;
  console.log(`  ${working > 0 ? c.green(summary) : c.danger(summary)}`);

  if (failures.length) {
    const logPath = writeDebugLog("doctor", failures);
    if (logPath) console.log(`  ${c.dim(`Full output: ${logPath}`)}`);
    if (opts.debug) {
      for (const a of failures) {
        blankLine();
        console.log(`  ${c.dim(`── ${a.label} argv ──`)}`);
        console.log(`  ${c.dim(formatArgv(a.provider, a.argv))}`);
        console.log(`  ${c.dim(`── ${a.label} stdout ──`)}`);
        console.log(a.stdout.trim() || c.dim("  (empty)"));
        console.log(`  ${c.dim(`── ${a.label} stderr ──`)}`);
        console.log(a.stderr.trim() || c.dim("  (empty)"));
      }
    }
  }
  blankLine();
  process.exit(working > 0 ? 0 : 1);
}

interface ReviewState {
  url: string;
  original?: string;
  script: string;
  lines: number;
  bytes: number;
  sha256: string;
  providers: ProviderStatus[];
  providerOrder: ProviderId[];
  debug: boolean;
  hasBat: boolean;
  reviewed: boolean;
  cachedReview?: CachedReview;
  verdict?: "SAFE" | "CAUTION" | "DANGEROUS";
}

interface CachedReview {
  sha256: string;
  url: string;
  verdict: "SAFE" | "CAUTION" | "DANGEROUS";
  output: string;
  timestamp: string;
  provider?: string;
}

const blankLine = () => console.log("");

/** Exit codes for the non-interactive modes; "no verdict" is always 3. */
const VERDICT_EXIT: Record<"SAFE" | "CAUTION" | "DANGEROUS" | "NONE", number> = {
  SAFE: 0,
  DANGEROUS: 1,
  CAUTION: 2,
  NONE: 3,
};

/** True when at least one configured reviewer CLI is on PATH. */
function anyProviderInstalled(statuses: ProviderStatus[]): boolean {
  return statuses.some((s) => s.installed);
}

function noProviderMessage(statuses: ProviderStatus[]): string {
  const lines = [`  ${c.warn("No reviewer CLI found.")} Install one of:`];
  for (const s of statuses) {
    lines.push(`    ${sym.bullet} ${c.bold(s.label)}  ${c.dim(s.installHint)}`);
  }
  return lines.join("\n");
}

function loadCachedReview(sha256: string): CachedReview | undefined {
  try {
    const path = join(CACHE_DIR, `${sha256}.json`);
    if (!existsSync(path)) return undefined;
    const data = JSON.parse(readFileSync(path, "utf-8")) as CachedReview;
    if (data.sha256 !== sha256) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

function saveCachedReview(review: CachedReview): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      join(CACHE_DIR, `${review.sha256}.json`),
      JSON.stringify(review, null, 2)
    );
  } catch {
    // Cache write failure is non-fatal
  }
}

async function main(
  url: string,
  opts: {
    original?: string;
    execute?: boolean;
    yes?: boolean;
    review?: boolean;
    provider?: string;
    debug?: boolean;
  }
) {
  console.log(banner("0.4.1"));

  // Validate URL before doing anything
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      console.error(`  ${c.red("Error:")} URL must use http or https protocol`);
      process.exit(1);
    }
  } catch {
    console.error(`  ${c.red("Error:")} Invalid URL — ${url}`);
    process.exit(1);
  }

  if (opts.original) {
    // Strip ANSI escape sequences and control characters to prevent terminal injection
    const safeOriginal = opts.original.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
    console.log(`  ${c.dim("Intercepted:")} ${c.bold(safeOriginal)}`);
    console.log(`  ${c.dim("Redirected to curl-review for inspection")}`);
    blankLine();
  }

  const hasBat = commandExists("bat");
  const providerOrder = resolveProviderOrder(opts.provider);
  const providers = probeProviders(providerOrder);
  const debug = opts.debug === true || process.env.CURL_REVIEW_DEBUG === "1";

  const spinner = ora(`Downloading ${c.dim(url)}`).start();

  let script: string;
  try {
    script = execFileSync("curl", ["-fsSL", url], {
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    spinner.fail(`Failed to download ${url}`);
    process.exit(1);
  }

  const lines = script.split("\n").length;
  const bytes = Buffer.byteLength(script);
  const sha256 = createHash("sha256").update(script).digest("hex");
  spinner.succeed(`Downloaded ${lines} lines (${formatBytes(bytes)})`);
  blankLine();

  const cached = loadCachedReview(sha256);

  // Script info table (no header row)
  const table = createTable();
  table.push(
    ["URL", url],
    ["Size", `${lines} lines (${formatBytes(bytes)})`],
    ["SHA-256", c.dim(sha256)],
    ["Shebang", extractShebang(script) || c.dim("none")],
    ["Reviewer", formatProviderStatus(providers)],
    [
      "Cached",
      cached
        ? `${verdictBadge(cached.verdict)} ${c.dim(`(${cached.timestamp})`)}`
        : c.dim("none"),
    ]
  );
  console.log(table.toString());
  blankLine();

  const state: ReviewState = {
    url,
    original: opts.original,
    script,
    lines,
    bytes,
    sha256,
    providers,
    providerOrder,
    debug,
    hasBat,
    reviewed: false,
    cachedReview: cached,
  };

  if (opts.review) {
    // Review only: no prompts, no execution, verdict in the exit code. This is
    // the mode for CI and for anywhere without a TTY, where the interactive
    // menu would otherwise block forever.
    await ensureReviewed(state);
    process.exit(VERDICT_EXIT[state.verdict ?? "NONE"]);
  }

  if (opts.execute) {
    await ensureReviewed(state);
    if (!state.verdict) {
      // No verdict means the review never ran. Executing here would defeat the
      // point of the tool, so fail closed and let the user decide interactively.
      console.log(`  ${c.danger("Refusing to execute without a verdict.")}\n`);
      process.exit(3);
    }
    if (state.verdict === "DANGEROUS") {
      console.log("\nScript flagged as DANGEROUS — aborting.");
      process.exit(1);
    }
    console.log(`  ${c.dim("Verdict:")} ${verdictBadge(state.verdict)} — proceeding to execute.\n`);
    executeScript(state);
    return;
  }

  if (opts.yes) {
    await ensureReviewed(state);
    if (!state.verdict) {
      console.log(`  ${c.danger("Refusing to auto-execute without a verdict.")}\n`);
      process.exit(3);
    }
    if (state.verdict === "SAFE") {
      console.log(`  ${c.dim("Verdict:")} ${verdictBadge("SAFE")} — auto-executing.\n`);
      executeScript(state);
    } else {
      console.log(`\nVerdict is not SAFE — aborting auto-execute.`);
      process.exit(state.verdict === "DANGEROUS" ? 1 : 2);
    }
    return;
  }

  await interactiveMenu(state);
}

async function interactiveMenu(state: ReviewState) {
  while (true) {
    const choices: (
      | { value: string; name: string; description?: string }
      | Separator
    )[] = [];

    choices.push(new Separator(c.dim("── Inspect")));
    choices.push({
      value: "view",
      name: `${sym.info} View script`,
      description: state.hasBat ? "Syntax-highlighted" : "View in less",
    });

    if (state.cachedReview && !state.reviewed) {
      choices.push({
        value: "use_cached",
        name: `${sym.shield} Use cached review`,
        description: `${state.cachedReview.verdict} from ${state.cachedReview.timestamp}`,
      });
    }

    if (anyProviderInstalled(state.providers)) {
      const names = state.providers.filter((p) => p.installed).map((p) => p.label);
      let label = `${sym.shield} Security review`;
      if (state.reviewed) {
        label = `${sym.shield} Re-run security review`;
      } else if (state.cachedReview) {
        label = `${sym.shield} Fresh review with ${names[0]}`;
      }
      choices.push({
        value: "review",
        name: label,
        description: `Analyze with ${names.join(" → ")}`,
      });
    } else if (!state.cachedReview) {
      choices.push({
        value: "review_disabled",
        name: c.dim(`${sym.shield} Security review (unavailable)`),
        description: "No reviewer CLI installed",
      });
    }

    choices.push(new Separator(c.dim("── Run")));

    if (state.verdict === "DANGEROUS") {
      choices.push({
        value: "execute_dangerous",
        name: c.red(`${sym.cross} Execute (DANGEROUS)`),
        description: "Requires confirmation",
      });
    } else if (state.reviewed) {
      choices.push({
        value: "execute",
        name: `${sym.play} Execute script`,
        description:
          state.verdict === "SAFE"
            ? "Reviewed — no issues"
            : "Reviewed — proceed with caution",
      });
    } else {
      choices.push({
        value: "execute_unreviewed",
        name: `${sym.play} Execute script ${c.dim("(not reviewed)")}`,
        description: "Run without review",
      });
    }

    choices.push(new Separator(c.dim("──")));
    choices.push({ value: "cancel", name: `${sym.arrow} Quit` });

    try {
      const action = await select({
        message: state.reviewed
          ? `Verdict: ${verdictBadge(state.verdict!)} — What next?`
          : "Choose an action",
        choices,
        pageSize: 10,
        loop: false,
      });

      switch (action) {
        case "view":
          viewScript(state);
          break;
        case "use_cached": {
          restoreCachedReview(state);
          const cached = state.cachedReview!;
          blankLine();
          console.log(renderMarkdown(cached.output));
          blankLine();
          break;
        }
        case "review":
          await runSecurityReview(state);
          break;
        case "review_disabled":
          blankLine();
          console.log(noProviderMessage(state.providers));
          blankLine();
          break;
        case "execute":
          executeScript(state);
          return;
        case "execute_unreviewed": {
          const skip = await confirm({
            message: "Script has not been reviewed. Execute anyway?",
            default: false,
          });
          if (skip) {
            executeScript(state);
            return;
          }
          break;
        }
        case "execute_dangerous": {
          const force = await confirm({
            message: "Script was flagged DANGEROUS. Are you absolutely sure?",
            default: false,
          });
          if (force) {
            executeScript(state);
            return;
          }
          break;
        }
        case "cancel":
          blankLine();
          process.exit(0);
      }
    } catch {
      blankLine();
      process.exit(0);
    }
  }
}

function viewScript(state: ReviewState) {
  blankLine();
  if (state.hasBat) {
    spawnSync(
      "bat",
      [
        "--language=sh",
        "--paging=always",
        "--style=numbers,header,grid",
        `--file-name=${state.url}`,
      ],
      { input: state.script, stdio: ["pipe", "inherit", "inherit"] }
    );
  } else {
    spawnSync("less", [], {
      input: state.script,
      stdio: ["pipe", "inherit", "inherit"],
    });
  }
  blankLine();
}

function formatProviderStatus(statuses: ProviderStatus[]): string {
  const parts = statuses.map((s) => {
    if (!s.installed) return c.dim(`${s.label} (not installed)`);
    if (s.authed === false) return `${s.label} ${c.yellow("(logged out)")}`;
    return c.green(s.label);
  });
  return parts.join(c.dim(" → "));
}

/**
 * Render every failed attempt with its reason and fix.
 *
 * Agent CLIs report request failures on stdout, not stderr, and often exit
 * non-zero with an empty stderr — so surfacing stderr alone leaves the user
 * with nothing to act on.
 */
function renderFailure(state: ReviewState, attempts: Attempt[]): void {
  const rule = c.red("─".repeat(56));
  blankLine();
  console.log(`  ${c.danger("✗  Security review failed")}`);
  console.log(`  ${rule}`);

  for (const a of attempts) {
    const meta: string[] = [describeFailureKind(a.kind)];
    if (a.code !== null) meta.push(`exit ${a.code}`);
    if (a.durationMs > 0) meta.push(`${(a.durationMs / 1000).toFixed(1)}s`);
    console.log(`  ${c.bold(a.label.padEnd(8))} ${c.dim(meta.join(" · "))}`);
    if (a.error) {
      for (const line of wrap(a.error, 66)) {
        console.log(`  ${" ".repeat(9)}${line}`);
      }
    }
    if (a.hint) {
      console.log(`  ${" ".repeat(9)}${sym.arrow} ${c.yellow(a.hint)}`);
    }
  }

  // Configured providers that were never tried, so the list of what was and
  // wasn't attempted is complete.
  for (const s of state.providers) {
    if (s.installed || attempts.some((a) => a.provider === s.id)) continue;
    console.log(`  ${c.bold(s.label.padEnd(8))} ${c.dim("not installed")}`);
    console.log(`  ${" ".repeat(9)}${sym.arrow} ${c.yellow(s.installHint)}`);
  }

  console.log(`  ${rule}`);

  const logPath = writeDebugLog(state.url, attempts);
  if (logPath) {
    console.log(`  ${c.dim(`Full output: ${logPath}`)}`);
  }
  if (!state.debug) {
    console.log(`  ${c.dim("Re-run with --debug to print it inline.")}`);
  } else {
    for (const a of attempts) {
      blankLine();
      console.log(`  ${c.dim(`── ${a.label} argv ──`)}`);
      console.log(`  ${c.dim(formatArgv(a.provider, a.argv))}`);
      console.log(`  ${c.dim(`── ${a.label} stdout ──`)}`);
      console.log(a.stdout.trim() || c.dim("  (empty)"));
      console.log(`  ${c.dim(`── ${a.label} stderr ──`)}`);
      console.log(a.stderr.trim() || c.dim("  (empty)"));
    }
  }
  blankLine();
}

/** argv for display: the review prompt is ~2 KB and would bury everything else. */
export function formatArgv(bin: string, argv: string[], maxArg = 60): string {
  return [bin, ...argv]
    .map((arg) =>
      arg.length > maxArg
        ? `${JSON.stringify(arg.slice(0, maxArg))}…+${arg.length - maxArg}ch`
        : JSON.stringify(arg)
    )
    .join(" ");
}

function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function restoreCachedReview(state: ReviewState): void {
  const cached = state.cachedReview!;
  state.reviewed = true;
  state.verdict = cached.verdict;
}

async function ensureReviewed(state: ReviewState): Promise<void> {
  if (state.cachedReview) {
    restoreCachedReview(state);
  } else {
    await runSecurityReview(state);
  }
}

async function runSecurityReview(state: ReviewState) {
  if (!anyProviderInstalled(state.providers)) {
    blankLine();
    console.log(noProviderMessage(state.providers));
    blankLine();
    return;
  }

  blankLine();
  const domain = new URL(state.url).hostname;

  const prompt = buildReviewPrompt(state.url, domain);
  const timeoutMs = resolveTimeoutMs();
  const candidates = state.providerOrder.filter(
    (id) => state.providers.find((p) => p.id === id)?.installed
  );

  const attempts: Attempt[] = [];
  let success: Attempt | undefined;

  for (const id of candidates) {
    const label = state.providers.find((p) => p.id === id)!.label;
    const spinner = ora(
      `Analyzing ${state.lines} lines from ${c.dim(domain)} ${c.dim(`(${label})`)}`
    ).start();

    const attempt = await runProvider(id, prompt, state.script, timeoutMs);
    attempts.push(attempt);

    if (attempt.ok) {
      spinner.stop();
      success = attempt;
      break;
    }

    // Keep the spinner line as a record of what was tried before falling back.
    spinner.fail(
      `${label}: ${describeFailureKind(attempt.kind)}${
        candidates.indexOf(id) < candidates.length - 1 ? c.dim(" — trying next reviewer") : ""
      }`
    );
  }

  if (!success) {
    renderFailure(state, attempts);
    return;
  }

  finishReview(state, success, attempts);
}

function finishReview(state: ReviewState, success: Attempt, attempts: Attempt[]) {
  const output = success.text.trim();
  state.reviewed = true;

  const verdict = parseVerdict(output);
  const via = c.dim(` (via ${success.label})`);
  if (verdict) {
    state.verdict = verdict;
    const mark =
      verdict === "DANGEROUS" ? sym.cross : verdict === "CAUTION" ? sym.warn : sym.check;
    console.log(`${mark} Verdict: ${verdictBadge(verdict)}${via}`);
  } else {
    console.log(`${sym.info} Review complete${via}`);
  }

  if (attempts.length > 1) {
    const failed = attempts.slice(0, -1).map((a) => `${a.label} (${describeFailureKind(a.kind)})`);
    console.log(`  ${c.dim(`Fell back after: ${failed.join(", ")}`)}`);
    const logPath = writeDebugLog(state.url, attempts.slice(0, -1));
    if (logPath) console.log(`  ${c.dim(`Details: ${logPath}`)}`);
  }

  // Cache the review if we got a verdict
  if (state.verdict) {
    const cached: CachedReview = {
      sha256: state.sha256,
      url: state.url,
      verdict: state.verdict,
      output,
      timestamp: new Date().toISOString().split("T")[0],
      provider: success.provider,
    };
    saveCachedReview(cached);
    state.cachedReview = cached;
  }

  if (output) {
    blankLine();
    console.log(renderMarkdown(output));
  }
  blankLine();
}

function buildReviewPrompt(url: string, domain: string): string {
  return `You are a shell script security reviewer. Analyze this script downloaded from: ${url}

First, assess the source: What is "${domain}" known for? Is it a well-known, reputable source for developer tools? Factor this into your verdict.

Review the script for real security threats. Most install scripts from reputable sources (GitHub, major open-source projects, well-known developer tools) use standard patterns like sudo, rm -rf on build dirs, and curl|sh chains — these are normal and expected.

Focus on:
- Actual malicious behavior: data exfiltration, backdoors, reverse shells, crypto miners
- Obfuscated or encoded code designed to hide intent
- Network calls to unexpected/suspicious destinations
- Credential or environment variable harvesting sent to external services
- Modifications to system files outside the tool's scope

Standard install patterns that are NOT concerning:
- sudo for package installation (apt, brew, etc.)
- rm -rf on the tool's own directories (build, venv, cache)
- curl/wget to download from the same organization's domains
- Adding entries to PATH, shell profiles
- Installing dependencies via pip, npm, apt, brew

Verdict criteria:
- SAFE: Standard install script, no suspicious patterns, reputable source
- CAUTION: Legitimate script but has unusual patterns worth noting (e.g., modifying global system config, broad permissions)
- DANGEROUS: Evidence of actual malicious intent, obfuscation, or data exfiltration — reserve this for genuinely harmful scripts

Structure your response as:

## Source
One sentence on what ${domain} is and its reputation.

## Findings
- Bullet each notable finding with a brief explanation
- Skip this section entirely if nothing notable

## Verdict
Write exactly one of: SAFE, CAUTION, or DANGEROUS (the word alone, not bold, not in asterisks) followed by a dash and one-line recommendation.

The script follows.`;
}

function executeScript(state: ReviewState) {
  const shebang = extractShebang(state.script);
  let shell = "sh";
  let shellArgs: string[] = [];
  if (shebang) {
    // Extract interpreter + flags from shebang
    // e.g. #!/usr/bin/env bash -e → shell=bash, shellArgs=["-e"]
    //      #!/bin/bash -e         → shell=/bin/bash, shellArgs=["-e"]
    const parts = shebang.replace(/^#!\s*/, "").split(/\s+/);
    if (parts[0] === "/usr/bin/env" && parts[1]) {
      shell = parts[1];
      shellArgs = parts.slice(2);
    } else if (parts[0]) {
      shell = parts[0];
      shellArgs = parts.slice(1);
    }
  }
  console.log(`\n${c.dim("Executing via")} ${[shell, ...shellArgs].join(" ")} ${c.dim("—")} ${state.url}\n`);
  const child = spawnSync(shell, shellArgs, {
    input: state.script,
    stdio: ["pipe", "inherit", "inherit"],
  });
  process.exit(child.status ?? 1);
}

function renderMarkdown(text: string): string {
  if (noColor) {
    return text
      .replace(/^###? (.+)$/gm, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^- /gm, "  * ");
  }

  return text
    .replace(/^## (.+)$/gm, (_, h) => `\n${c.bold(c.cyan(h))}`)
    .replace(/^# (.+)$/gm, (_, h) => `\n${c.bold(c.magenta(h))}`)
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t))
    .replace(/`([^`]+)`/g, (_, t) => c.yellow(t))
    .replace(/^- /gm, `  ${c.dim("•")} `);
}

export function extractShebang(script: string): string | null {
  const first = script.split("\n")[0];
  return first?.startsWith("#!") ? first : null;
}

export type Verdict = "SAFE" | "CAUTION" | "DANGEROUS";

export function parseVerdict(output: string): Verdict | null {
  const verdictSection = output.split(/^##\s*Verdict/im)[1] ?? "";
  const verdictLine = verdictSection.trim().split("\n")[0] ?? "";
  if (/^DANGEROUS\b/i.test(verdictLine)) return "DANGEROUS";
  if (/^CAUTION\b/i.test(verdictLine)) return "CAUTION";
  if (/^SAFE\b/i.test(verdictLine)) return "SAFE";
  return null;
}

// Only parse CLI args when run directly, not when imported as a module
const __filename = fileURLToPath(import.meta.url);
const entrypoint = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entrypoint === realpathSync(__filename)) {
  program.parse();
}
