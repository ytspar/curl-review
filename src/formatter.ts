// ANSI color helpers
import Table from "cli-table3";

export const noColor = "NO_COLOR" in process.env;

const codes = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
} as const;

type Color = keyof typeof codes;

export function colorize(text: string, ...colors: Color[]): string {
  if (noColor) return text;
  const prefix = colors.map((c) => codes[c]).join("");
  return `${prefix}${text}${codes.reset}`;
}

export const c = {
  bold: (s: string) => colorize(s, "bold"),
  dim: (s: string) => colorize(s, "dim"),
  red: (s: string) => colorize(s, "red"),
  green: (s: string) => colorize(s, "green"),
  yellow: (s: string) => colorize(s, "yellow"),
  blue: (s: string) => colorize(s, "blue"),
  cyan: (s: string) => colorize(s, "cyan"),
  magenta: (s: string) => colorize(s, "magenta"),
  gray: (s: string) => colorize(s, "gray"),
  danger: (s: string) => colorize(s, "red", "bold"),
  success: (s: string) => colorize(s, "green"),
  warn: (s: string) => colorize(s, "yellow"),
  info: (s: string) => colorize(s, "blue"),
  heading: (s: string) => colorize(s, "cyan", "bold"),
  label: (s: string) => colorize(s, "dim"),
};

// Symbols
export const sym = {
  check: c.green("✓"),
  cross: c.red("✗"),
  warn: c.yellow("⚠"),
  info: c.blue("ℹ"),
  arrow: c.dim("→"),
  bullet: c.dim("•"),
  shield: "🛡️",
  lock: "🔒",
  play: "▶",
};

// Table with box-drawing characters (same style as hetzner-cli)
export function createTable(
  head?: string[],
  colWidths?: number[]
): Table.Table {
  const options: Table.TableConstructorOptions = {
    ...(head && head.length > 0 ? { head: head.map((h) => colorize(h, "cyan")) } : {}),
    chars: {
      top: "─",
      "top-mid": "┬",
      "top-left": "┌",
      "top-right": "┐",
      bottom: "─",
      "bottom-mid": "┴",
      "bottom-left": "└",
      "bottom-right": "┘",
      left: "│",
      "left-mid": "├",
      mid: "─",
      "mid-mid": "┼",
      right: "│",
      "right-mid": "┤",
      middle: "│",
    },
    style: {
      "padding-left": 1,
      "padding-right": 1,
    },
  };

  if (colWidths) {
    options.colWidths = colWidths;
  }

  return new Table(options);
}

// Banner
export function banner(): string {
  const lines = [
    "",
    c.cyan("  ┌─────────────────────────────────────┐"),
    c.cyan("  │") + c.bold("   curl-review") + c.dim("  — safe script runner") + c.cyan("  │"),
    c.cyan("  └─────────────────────────────────────┘"),
    "",
  ];
  return lines.join("\n");
}

// Verdict badge
export function verdictBadge(
  verdict: "SAFE" | "CAUTION" | "DANGEROUS"
): string {
  switch (verdict) {
    case "SAFE":
      return colorize(" SAFE ", "bold", "green");
    case "CAUTION":
      return colorize(" CAUTION ", "bold", "yellow");
    case "DANGEROUS":
      return colorize(" DANGEROUS ", "bold", "red");
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}
