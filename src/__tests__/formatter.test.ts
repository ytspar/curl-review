import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatBytes, colorize, verdictBadge, banner, createTable, noColor, c, sym } from "../formatter.js";

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
const ANSI = /\x1b\[/;

describe("NO_COLOR", () => {
  // `noColor` is captured at module load, so each direction needs its own
  // process. Regression: cli-table3 colours its borders and header internally,
  // where colorize() never reaches — the table stayed coloured under NO_COLOR
  // while every other element went plain.
  function renderTableWith(env: NodeJS.ProcessEnv): string {
    const formatterUrl = pathToFileURL(resolve(distDir, "formatter.js")).href;
    return execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(formatterUrl)});
         const t = m.createTable(["Head"]);
         t.push(["cell"]);
         process.stdout.write(t.toString());`,
      ],
      { encoding: "utf-8", env }
    );
  }

  const { NO_COLOR: _drop, ...envWithoutNoColor } = process.env;

  it("renders tables without ANSI escapes when NO_COLOR is set", () => {
    expect(ANSI.test(renderTableWith({ ...envWithoutNoColor, NO_COLOR: "1" }))).toBe(false);
  });

  it("still colours tables when NO_COLOR is unset", () => {
    expect(ANSI.test(renderTableWith(envWithoutNoColor))).toBe(true);
  });
});

describe("formatBytes", () => {
  it("returns 0 B for zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("returns bytes for small values", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("returns KB for values >= 1024", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("returns MB for values >= 1048576", () => {
    expect(formatBytes(1048576)).toBe("1 MB");
    expect(formatBytes(5242880)).toBe("5 MB");
  });
});

describe("colorize", () => {
  it("wraps text with ANSI codes and reset", () => {
    const result = colorize("hello", "red");
    expect(result).toBe("\x1b[31mhello\x1b[0m");
  });

  it("supports multiple color codes", () => {
    const result = colorize("hello", "bold", "red");
    expect(result).toBe("\x1b[1m\x1b[31mhello\x1b[0m");
  });

  it("returns text with just reset when no colors given", () => {
    const result = colorize("hello");
    expect(result).toBe("hello\x1b[0m");
  });
});

describe("verdictBadge", () => {
  it("returns styled badge for each verdict", () => {
    expect(verdictBadge("SAFE")).toContain("SAFE");
    expect(verdictBadge("CAUTION")).toContain("CAUTION");
    expect(verdictBadge("DANGEROUS")).toContain("DANGEROUS");
  });
});

describe("banner", () => {
  it("includes the tool name and version", () => {
    const result = banner("1.2.3");
    expect(result).toContain("curl-review");
    expect(result).toContain("1.2.3");
  });
});

describe("createTable", () => {
  it("returns a table object with push and toString", () => {
    const table = createTable();
    table.push(["Key", "Value"]);
    const output = table.toString();
    expect(output).toContain("Key");
    expect(output).toContain("Value");
  });

  it("accepts custom column widths", () => {
    const table = createTable(undefined, [10, 20]);
    table.push(["A", "B"]);
    expect(table.toString()).toContain("A");
  });

  it("accepts header row", () => {
    const table = createTable(["Name", "Score"]);
    table.push(["Alice", "100"]);
    const output = table.toString();
    expect(output).toContain("Name");
    expect(output).toContain("Alice");
  });
});

describe("noColor", () => {
  it("is a boolean", () => {
    expect(typeof noColor).toBe("boolean");
  });
});

describe("c (color helpers)", () => {
  it("has expected color methods", () => {
    expect(typeof c.red).toBe("function");
    expect(typeof c.green).toBe("function");
    expect(typeof c.yellow).toBe("function");
    expect(typeof c.cyan).toBe("function");
    expect(typeof c.dim).toBe("function");
    expect(typeof c.bold).toBe("function");
  });

  it("wraps text with color codes", () => {
    const result = c.red("error");
    expect(result).toContain("error");
  });
});

describe("sym (symbols)", () => {
  it("has expected symbol properties", () => {
    expect(typeof sym.check).toBe("string");
    expect(typeof sym.cross).toBe("string");
    expect(typeof sym.shield).toBe("string");
    expect(typeof sym.play).toBe("string");
    expect(typeof sym.arrow).toBe("string");
    expect(typeof sym.info).toBe("string");
  });
});
