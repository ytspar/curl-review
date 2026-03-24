// ANSI color helpers
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
  gray: (s: string) => colorize(s, "dim"),
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
};

// Box drawing
export function box(
  title: string,
  lines: string[],
  footer?: string
): string {
  const width = 60;
  const hr = "─".repeat(width - 2);
  const out: string[] = [];

  out.push(c.dim(`┌─ ${c.heading(title)} ${"─".repeat(Math.max(0, width - title.length - 5))}┐`));

  for (const line of lines) {
    out.push(`${c.dim("│")}  ${line}`);
  }

  if (footer) {
    out.push(c.dim(`├${hr}┤`));
    out.push(`${c.dim("│")}  ${footer}`);
  }

  out.push(c.dim(`└${hr}┘`));
  return out.join("\n");
}

export function heading(text: string): string {
  return `\n${c.heading(text)}\n${c.dim("─".repeat(text.length))}`;
}

export function formatBytes(bytes: number): string {
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
