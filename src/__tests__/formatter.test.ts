import { describe, it, expect } from "vitest";
import { formatBytes, colorize, box, heading, verdictBadge, banner } from "../formatter.js";

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

describe("box", () => {
  it("returns a string with box-drawing characters", () => {
    const result = box("Title", ["line1", "line2"]);
    const lines = result.split("\n");

    expect(lines.length).toBe(4); // top + 2 content + bottom
    expect(result).toContain("Title");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  it("includes footer when provided", () => {
    const result = box("Title", ["content"], "footer text");
    expect(result).toContain("footer text");
    const lines = result.split("\n");
    expect(lines.length).toBe(5);
  });

  it("handles empty lines array", () => {
    const result = box("Title", []);
    const lines = result.split("\n");
    expect(lines.length).toBe(2); // top + bottom only
  });
});

describe("heading", () => {
  it("returns text with underline", () => {
    const result = heading("Test");
    expect(result).toContain("Test");
    expect(result).toContain("─".repeat(4));
  });

  it("starts with a newline", () => {
    const result = heading("Hello");
    expect(result.startsWith("\n")).toBe(true);
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
  it("includes the tool name", () => {
    expect(banner()).toContain("curl-review");
  });
});
