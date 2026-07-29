import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractShebang, parseVerdict } from "../cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../../dist/cli.js");

describe("CLI", () => {
  it("prints version with --version flag", () => {
    const output = execFileSync("node", [cliPath, "--version"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("0.4.2");
  });

  it("lists the doctor subcommand and non-interactive flags in help", () => {
    const output = execFileSync("node", [cliPath, "--help"], { encoding: "utf-8" });
    expect(output).toContain("doctor");
    expect(output).toContain("-r, --review");
  });

  // Run doctor with an empty PATH so no provider binary is found: every
  // reviewer reports "not installed" and nothing is ever spawned, which keeps
  // these deterministic and fast regardless of what is installed locally.
  function doctorWithNoProviders(args: string[]): string {
    const emptyDir = mkdtempSync(join(tmpdir(), "curl-review-nopath-"));
    try {
      execFileSync(process.execPath, [cliPath, "doctor", ...args], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: emptyDir, NO_COLOR: "1" },
      });
      throw new Error("doctor should exit non-zero when no reviewer works");
    } catch (err: any) {
      // Exit 1 is the expected "nothing works" outcome.
      expect(err.status).toBe(1);
      return err.stdout.toString();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }

  it("checks every reviewer by default", () => {
    expect(doctorWithNoProviders([])).toContain("0 of 3 reviewer(s)");
  });

  it("routes options after `doctor` to the subcommand, not the root", () => {
    // Regression: without enablePositionalOptions, commander bound --provider
    // to the root command, so doctor silently checked all three anyway.
    expect(doctorWithNoProviders(["--provider", "kimi"])).toContain("0 of 1 reviewer(s)");
  });

  it("prints help with --help flag", () => {
    const output = execFileSync("node", [cliPath, "--help"], {
      encoding: "utf-8",
    });
    expect(output).toContain("curl-review");
    expect(output).toContain("Safely inspect");
    expect(output).toContain("-y, --yes");
  });

  it("exits with error when no URL is provided", () => {
    try {
      execFileSync("node", [cliPath], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
    }
  });

  it("rejects invalid URLs", () => {
    try {
      execFileSync("node", [cliPath, "not-a-url"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
      expect(err.stderr.toString()).toContain("Invalid URL");
    }
  });

  it("rejects non-http protocols", () => {
    try {
      execFileSync("node", [cliPath, "ftp://example.com/install.sh"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
      expect(err.stderr.toString()).toContain("http or https");
    }
  });
});

describe("extractShebang", () => {
  it("returns shebang line from a script", () => {
    expect(extractShebang("#!/bin/bash\necho hello")).toBe("#!/bin/bash");
  });

  it("returns shebang with env", () => {
    expect(extractShebang("#!/usr/bin/env sh\nset -e")).toBe("#!/usr/bin/env sh");
  });

  it("returns null when no shebang", () => {
    expect(extractShebang("echo hello\nexit 0")).toBeNull();
  });

  it("returns null for empty script", () => {
    expect(extractShebang("")).toBeNull();
  });
});

describe("parseVerdict", () => {
  it("parses SAFE verdict", () => {
    const output = "## Findings\n- Nothing notable\n\n## Verdict\nSAFE — standard install script";
    expect(parseVerdict(output)).toBe("SAFE");
  });

  it("parses CAUTION verdict", () => {
    const output = "## Verdict\nCAUTION — unusual permissions requested";
    expect(parseVerdict(output)).toBe("CAUTION");
  });

  it("parses DANGEROUS verdict", () => {
    const output = "## Verdict\nDANGEROUS — data exfiltration detected";
    expect(parseVerdict(output)).toBe("DANGEROUS");
  });

  it("is case-insensitive", () => {
    expect(parseVerdict("## Verdict\nsafe — ok")).toBe("SAFE");
    expect(parseVerdict("## Verdict\nDangerous — bad")).toBe("DANGEROUS");
  });

  it("returns null when no verdict section", () => {
    expect(parseVerdict("Just some text without a verdict")).toBeNull();
  });

  it("returns null when verdict section has unknown value", () => {
    expect(parseVerdict("## Verdict\nUNKNOWN — something")).toBeNull();
  });

  it("ignores verdict-like words outside the Verdict section", () => {
    const output = "## Findings\n- DANGEROUS pattern found\n\n## Verdict\nSAFE — false positive";
    expect(parseVerdict(output)).toBe("SAFE");
  });
});
