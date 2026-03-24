#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { select, confirm } from "@inquirer/prompts";
import { c, sym, box, formatBytes } from "./formatter.js";

const program = new Command()
  .name("curl-review")
  .description("Safely inspect and optionally execute curl|sh install scripts")
  .version("0.1.0")
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

async function main(url: string, opts: { original?: string; execute?: boolean }) {
  const hasClaude = checkClaude();
  const hasBat = commandExists("bat");

  console.log(`\n${c.dim("Downloading")} ${url} ${c.dim("...")}`);
  let script: string;
  try {
    script = execFileSync("curl", ["-fsSL", url], {
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    console.error(`\n${sym.cross} ${c.red("Failed to download")} ${url}`);
    process.exit(1);
  }

  const lines = script.split("\n").length;
  const bytes = Buffer.byteLength(script);

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

  displayHeader(state);

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

function displayHeader(state: ReviewState) {
  const infoLines: string[] = [];

  if (state.original) {
    infoLines.push(`${c.label("Intercepted")}  ${c.danger(state.original)}`);
    infoLines.push("");
  }

  infoLines.push(`${c.label("URL")}          ${state.url}`);
  infoLines.push(
    `${c.label("Size")}         ${state.lines} lines (${formatBytes(state.bytes)})`
  );

  if (state.hasClaude) {
    infoLines.push(`${c.label("Claude")}       ${sym.check} ready`);
  } else {
    infoLines.push(
      `${c.label("Claude")}       ${sym.cross} unavailable ${c.dim("(run: claude /login)")}`
    );
  }

  console.log("\n" + box("curl-review", infoLines));
  console.log("");
}

async function interactiveMenu(state: ReviewState) {
  while (true) {
    const choices: { value: string; name: string; description?: string }[] = [
      {
        value: "view",
        name: `${sym.info} View script`,
        description: `Syntax-highlighted view of ${state.lines} lines`,
      },
    ];

    if (state.hasClaude) {
      choices.push({
        value: "review",
        name: state.reviewed
          ? `${sym.shield} Re-run security review`
          : `${sym.shield} Security review`,
        description: "AI-powered analysis for malicious patterns",
      });
    }

    if (state.reviewed && state.verdict !== "DANGEROUS") {
      choices.push({
        value: "execute",
        name: `${c.green("▶")} Execute script`,
        description: state.verdict === "SAFE"
          ? "Script reviewed — no issues found"
          : "Script reviewed — proceed with caution",
      });
    } else if (!state.reviewed) {
      choices.push({
        value: "execute",
        name: `${c.yellow("▶")} Execute script ${c.dim("(not yet reviewed)")}`,
        description: "Run without security review",
      });
    }

    choices.push({
      value: "cancel",
      name: `${sym.cross} Cancel`,
    });

    try {
      const action = await select({
        message: "What would you like to do?",
        choices,
        pageSize: 10,
      });

      switch (action) {
        case "view":
          viewScript(state);
          break;
        case "review":
          await runSecurityReview(state);
          break;
        case "execute":
          if (!state.reviewed) {
            const skip = await confirm({
              message: `${c.yellow("Script has not been reviewed.")} Execute anyway?`,
              default: false,
            });
            if (!skip) break;
          }
          await executeScript(state);
          return;
        case "cancel":
          console.log(`\n${c.dim("Cancelled.")}`);
          process.exit(0);
      }
    } catch {
      // Ctrl+C
      console.log(`\n${c.dim("Cancelled.")}`);
      process.exit(0);
    }
  }
}

function viewScript(state: ReviewState) {
  if (state.hasBat) {
    spawnSync(
      "bat",
      [
        "--language=sh",
        "--paging=always",
        "--style=numbers,header",
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
}

async function runSecurityReview(state: ReviewState) {
  if (!state.hasClaude) {
    console.log(
      `\n${sym.cross} Claude not authenticated. Run: ${c.bold("claude /login")}`
    );
    return;
  }

  console.log(
    `\n${sym.shield} ${c.cyan("Analyzing")} ${state.lines} lines from ${c.dim(state.url)}...\n`
  );

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
    console.log(`\n${sym.cross} ${c.red("Security review failed")}`);
    return;
  }

  state.reviewed = true;
  const output = child.stdout ?? "";
  if (/\bDANGEROUS\b/i.test(output)) {
    state.verdict = "DANGEROUS";
    console.log(`\n${c.danger("⚠  DANGEROUS")} — review the findings above carefully.`);
  } else if (/\bCAUTION\b/i.test(output)) {
    state.verdict = "CAUTION";
    console.log(`\n${c.yellow("⚠  CAUTION")} — review the findings above before proceeding.`);
  } else if (/\bSAFE\b/i.test(output)) {
    state.verdict = "SAFE";
    console.log(`\n${sym.check} ${c.green("SAFE")} — no issues detected.`);
  }
  console.log("");
}

async function executeScript(state: ReviewState) {
  if (state.verdict === "DANGEROUS") {
    try {
      const force = await confirm({
        message: `${c.danger("Script was flagged DANGEROUS.")} Are you absolutely sure?`,
        default: false,
      });
      if (!force) {
        console.log(`\n${c.dim("Aborted.")}`);
        return;
      }
    } catch {
      console.log(`\n${c.dim("Aborted.")}`);
      return;
    }
  }

  console.log(`\n${c.green("▶ Executing")} ${c.dim(state.url)}...\n`);
  const child = spawnSync("sh", [], {
    input: state.script,
    stdio: ["pipe", "inherit", "inherit"],
  });
  process.exit(child.status ?? 1);
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
