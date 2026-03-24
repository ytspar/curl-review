import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractShebang, parseVerdict } from "../cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../../dist/cli.js");

describe("CLI", () => {
  it("prints version with --version flag", () => {
    const output = execFileSync("node", [cliPath, "--version"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("0.3.0");
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
