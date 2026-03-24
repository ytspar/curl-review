#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { select, confirm, Separator } from "@inquirer/prompts";
import ora from "ora";
import {
  c,
  sym,
  banner,
  createTable,
  formatBytes,
  verdictBadge,
} from "./formatter.js";

const program = new Command()
  .name("curl-review")
  .description("Safely inspect and optionally execute curl|sh install scripts")
  .version("0.2.0")
  .argument("<url>", "URL of the script to review")
  .option("-o, --original <command>", "Original intercepted command")
  .option("-e, --execute", "Non-interactive: review then execute")
  .action(main);

program.parse();

interface ReviewState {
  url: string;
  original?: string;
  script: string;
  lines: number;
  bytes: number;
  hasClaude: boolean;
  hasBat: boolean;
  reviewed: boolean;
  verdict?: "SAFE" | "CAUTION" | "DANGEROUS";
}

async function main(
  url: string,
  opts: { original?: string; execute?: boolean }
) {
  // Banner
  console.log(banner());

  // Show intercepted command prominently
  if (opts.original) {
    console.log(
      `  ${c.dim("Intercepted")} ${c.danger("⚠")} ${c.bold(opts.original)}`
    );
    console.log(`  ${c.dim("This command was blocked for your safety.")}`);
    console.log("");
  }

  // Check tools with spinners
  const toolSpinner = ora({
    text: "Checking tools...",
    color: "cyan",
  }).start();

  const hasBat = commandExists("bat");
  const hasClaude = checkClaude();

  const tools: string[] = [];
  tools.push(hasBat ? `${sym.check} bat` : `${sym.cross} bat`);
  tools.push(hasClaude ? `${sym.check} claude` : `${sym.cross} claude`);
  toolSpinner.succeed(`Tools: ${tools.join("  ")}`);

  // Download with spinner
  const dlSpinner = ora({
    text: `Downloading ${c.cyan(url)}`,
    color: "cyan",
  }).start();

  let script: string;
  try {
    script = execFileSync("curl", ["-fsSL", url], {
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    dlSpinner.fail(`Failed to download ${url}`);
    process.exit(1);
  }

  const lines = script.split("\n").length;
  const bytes = Buffer.byteLength(script);
  dlSpinner.succeed(`Downloaded ${c.bold(String(lines))} lines (${formatBytes(bytes)})`);
  console.log("");

  // Script info table
  const table = createTable(["Property", "Value"]);
  table.push(
    [c.dim("URL"), url],
    [c.dim("Size"), `${lines} lines (${formatBytes(bytes)})`],
    [c.dim("Shebang"), extractShebang(script) || c.dim("none")],
    [
      c.dim("Claude"),
      hasClaude
        ? `${sym.check} authenticated`
        : `${sym.cross} not available ${c.dim("— run: claude /login")}`,
    ]
  );
  console.log(table.toString());
  console.log("");

  const state: ReviewState = {
    url,
    original: opts.original,
    script,
    lines,
    bytes,
    hasClaude,
    hasBat,
    reviewed: false,
  };

  if (opts.execute) {
    await runSecurityReview(state);
    if (state.verdict === "DANGEROUS") {
      console.log(`\n${sym.cross} Script flagged as DANGEROUS — aborting.`);
      process.exit(1);
    }
    await executeScript(state);
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

    // ── Inspect section
    choices.push(new Separator(c.dim("─── Inspect")));
    choices.push({
      value: "view",
      name: `  ${sym.info} View script`,
      description: state.hasBat
        ? "Syntax-highlighted with bat"
        : "View in less",
    });

    if (state.hasClaude) {
      choices.push({
        value: "review",
        name: state.reviewed
          ? `  ${sym.shield} Re-run security review`
          : `  ${sym.shield} Run security review`,
        description: "AI-powered analysis via Claude",
      });
    } else {
      choices.push({
        value: "review_disabled",
        name: c.dim(`  ${sym.shield} Security review (unavailable)`),
        description: "Run: claude /login",
      });
    }

    // ── Action section
    choices.push(new Separator(c.dim("─── Action")));

    if (state.verdict === "DANGEROUS") {
      choices.push({
        value: "execute_dangerous",
        name: `  ${c.danger(sym.play)} Execute ${c.danger("(DANGEROUS)")}`,
        description: "Script flagged dangerous — requires confirmation",
      });
    } else if (state.reviewed) {
      const badge =
        state.verdict === "SAFE"
          ? c.green(sym.play)
          : c.yellow(sym.play);
      choices.push({
        value: "execute",
        name: `  ${badge} Execute script`,
        description:
          state.verdict === "SAFE"
            ? "Reviewed — no issues found"
            : "Reviewed — proceed with caution",
      });
    } else {
      choices.push({
        value: "execute_unreviewed",
        name: `  ${c.yellow(sym.play)} Execute script ${c.dim("(not reviewed)")}`,
        description: "Run without security review",
      });
    }

    choices.push(new Separator(c.dim("───")));
    choices.push({
      value: "cancel",
      name: `  ${sym.cross} Cancel`,
    });

    try {
      const action = await select({
        message: state.reviewed
          ? `Verdict: ${verdictBadge(state.verdict!)} — What next?`
          : "What would you like to do?",
        choices,
        pageSize: 12,
        loop: false,
      });

      switch (action) {
        case "view":
          viewScript(state);
          break;

        case "review":
          await runSecurityReview(state);
          break;

        case "review_disabled":
          console.log(
            `\n${sym.cross} Claude not authenticated. Run: ${c.bold("claude /login")}\n`
          );
          break;

        case "execute":
          await executeScript(state);
          return;

        case "execute_unreviewed": {
          const skip = await confirm({
            message: `${c.warn("Script has not been reviewed.")} Execute anyway?`,
            default: false,
          });
          if (skip) {
            await executeScript(state);
            return;
          }
          break;
        }

        case "execute_dangerous": {
          const force = await confirm({
            message: `${c.danger("Script was flagged DANGEROUS.")} Are you absolutely sure?`,
            default: false,
          });
          if (force) {
            await executeScript(state);
            return;
          }
          break;
        }

        case "cancel":
          console.log(`\n${c.dim("Cancelled.")}\n`);
          process.exit(0);
      }
    } catch {
      console.log(`\n${c.dim("Cancelled.")}\n`);
      process.exit(0);
    }
  }
}

function viewScript(state: ReviewState) {
  console.log("");
  if (state.hasBat) {
    spawnSync(
      "bat",
      [
        "--language=sh",
        "--paging=always",
        "--style=numbers,header,grid",
        `--file-name=${state.url}`,
      ],
      {
        input: state.script,
        stdio: ["pipe", "inherit", "inherit"],
      }
    );
  } else {
    spawnSync("less", [], {
      input: state.script,
      stdio: ["pipe", "inherit", "inherit"],
    });
  }
  console.log("");
}

async function runSecurityReview(state: ReviewState) {
  if (!state.hasClaude) {
    console.log(
      `\n${sym.cross} Claude not authenticated. Run: ${c.bold("claude /login")}\n`
    );
    return;
  }

  console.log("");
  const spinner = ora({
    text: `Analyzing ${c.bold(String(state.lines))} lines from ${c.dim(state.url)}`,
    color: "cyan",
  }).start();

  const prompt = `You are a shell script security reviewer. Analyze this script downloaded from: ${state.url}

Review for:
- Malicious behavior (data exfiltration, backdoors, reverse shells)
- Dangerous operations (rm -rf, chmod 777, curl|sh chains, /etc modifications)
- Unnecessary privilege escalation (sudo usage)
- Hidden or obfuscated code
- Network calls to unexpected destinations
- Environment variable harvesting

Be concise. Structure as:

## Findings
(bulleted list — skip section if nothing notable)

## Verdict
**SAFE** / **CAUTION** / **DANGEROUS** — one-line recommendation.`;

  const child = spawnSync("claude", ["-p", "--bare", prompt], {
    input: state.script,
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf-8",
    timeout: 120000,
  });

  if (child.status !== 0) {
    spinner.fail("Security review failed");
    return;
  }

  state.reviewed = true;
  const output = child.stdout ?? "";
  if (/\bDANGEROUS\b/i.test(output)) {
    state.verdict = "DANGEROUS";
    spinner.fail(`Verdict: ${verdictBadge("DANGEROUS")}`);
  } else if (/\bCAUTION\b/i.test(output)) {
    state.verdict = "CAUTION";
    spinner.warn(`Verdict: ${verdictBadge("CAUTION")}`);
  } else if (/\bSAFE\b/i.test(output)) {
    state.verdict = "SAFE";
    spinner.succeed(`Verdict: ${verdictBadge("SAFE")}`);
  } else {
    spinner.info("Review complete — no clear verdict parsed");
  }
  console.log("");
}

async function executeScript(state: ReviewState) {
  console.log(`\n${c.green(`${sym.play} Executing`)} ${c.dim(state.url)}...\n`);
  const child = spawnSync("sh", [], {
    input: state.script,
    stdio: ["pipe", "inherit", "inherit"],
  });
  process.exit(child.status ?? 1);
}

function extractShebang(script: string): string | null {
  const first = script.split("\n")[0];
  return first?.startsWith("#!") ? first : null;
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
