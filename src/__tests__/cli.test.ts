import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../../dist/cli.js");

describe("CLI", () => {
  it("prints version with --version flag", () => {
    const output = execFileSync("node", [cliPath, "--version"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("0.1.0");
  });

  it("prints help with --help flag", () => {
    const output = execFileSync("node", [cliPath, "--help"], {
      encoding: "utf-8",
    });
    expect(output).toContain("curl-review");
    expect(output).toContain("Safely inspect");
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
});
