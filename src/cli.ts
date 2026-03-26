#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { select, confirm, Separator } from "@inquirer/prompts";
import ora from "ora";
import { banner, c, createTable, formatBytes, noColor, sym, verdictBadge } from "./formatter.js";

const program = new Command()
  .name("curl-review")
  .description("Safely inspect and optionally execute curl|sh install scripts")
  .version("0.3.3")
  .argument("<url>", "URL of the script to review")
  .option("-o, --original <command>", "Original intercepted command")
  .option("-e, --execute", "Non-interactive: review then execute")
  .option("-y, --yes", "Auto-execute only if verdict is SAFE")
  .action(main);

interface ReviewState {
  url: string;
  original?: string;
  script: string;
  lines: number;
  bytes: number;
  sha256: string;
  hasClaude: boolean;
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
}

const CACHE_DIR = join(homedir(), ".cache", "curl-review");
const AUTH_MSG = `Claude not authenticated. Run: ${c.bold("claude /login")}`;
const blankLine = () => console.log("");

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
  opts: { original?: string; execute?: boolean; yes?: boolean }
) {
  console.log(banner("0.3.3"));

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
  const hasClaude = checkClaude();

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
    [
      "Claude",
      hasClaude ? "authenticated" : `unavailable ${c.dim("(run: claude /login)")}`,
    ],
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
    hasClaude,
    hasBat,
    reviewed: false,
    cachedReview: cached,
  };

  if (opts.execute) {
    await ensureReviewed(state);
    if (state.verdict === "DANGEROUS") {
      console.log("\nScript flagged as DANGEROUS — aborting.");
      process.exit(1);
    }
    console.log(`  ${c.dim("Verdict:")} ${verdictBadge(state.verdict!)} — proceeding to execute.\n`);
    executeScript(state);
    return;
  }

  if (opts.yes) {
    await ensureReviewed(state);
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

    if (state.hasClaude) {
      let label = `${sym.shield} Security review`;
      if (state.reviewed) {
        label = `${sym.shield} Re-run security review`;
      } else if (state.cachedReview) {
        label = `${sym.shield} Fresh review with Claude`;
      }
      choices.push({
        value: "review",
        name: label,
        description: "Analyze with Claude",
      });
    } else if (!state.cachedReview) {
      choices.push({
        value: "review_disabled",
        name: c.dim(`${sym.shield} Security review (unavailable)`),
        description: "Run: claude /login",
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
          console.log(
            `\n${AUTH_MSG}\n`
          );
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

function runClaude(prompt: string, input: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = nodeSpawn("claude", ["-p", prompt], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        code: code ?? 1,
      });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
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
  if (!state.hasClaude) {
    console.log(`\n${AUTH_MSG}\n`);
    return;
  }

  blankLine();
  const domain = new URL(state.url).hostname;
  const spinner = ora(`Analyzing ${state.lines} lines from ${c.dim(domain)}`).start();

  const prompt = `You are a shell script security reviewer. Analyze this script downloaded from: ${state.url}

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
Write exactly one of: SAFE, CAUTION, or DANGEROUS (the word alone, not bold, not in asterisks) followed by a dash and one-line recommendation.`;

  const result = await runClaude(prompt, state.script);

  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    spinner.fail(`Security review failed${stderr ? `: ${stderr}` : ""}`);
    return;
  }

  const output = result.stdout.trim();
  state.reviewed = true;

  const verdict = parseVerdict(output);
  if (verdict) {
    state.verdict = verdict;
    const method = verdict === "DANGEROUS" ? "fail" : verdict === "CAUTION" ? "warn" : "succeed";
    spinner[method](`Verdict: ${verdictBadge(verdict)}`);
  } else {
    spinner.info("Review complete");
  }

  // Cache the review if we got a verdict
  if (state.verdict) {
    const cached: CachedReview = {
      sha256: state.sha256,
      url: state.url,
      verdict: state.verdict,
      output,
      timestamp: new Date().toISOString().split("T")[0],
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

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkClaude(): boolean {
  if (!commandExists("claude")) return false;
  try {
    const out = execFileSync("claude", ["auth", "status"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return out.includes('"loggedIn": true');
  } catch {
    return false;
  }
}

// Only parse CLI args when run directly, not when imported as a module
const __filename = fileURLToPath(import.meta.url);
const entrypoint = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entrypoint === realpathSync(__filename)) {
  program.parse();
}
