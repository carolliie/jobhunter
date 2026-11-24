const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;
let current: Level = "info";
const secrets = new Set<string>();

export function setLogLevel(l: Level) { current = l; }
/** Registra valores que nunca devem aparecer em logs (tokens/chaves). */
export function registerSecret(v: string | undefined) { if (v && v.length > 6) secrets.add(v); }

function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot***").replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-***");
}

function fmt(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function log(level: Level, args: unknown[]) {
  if (levels[level] < levels[current]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redact(args.map(fmt).join(" "))}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const logger = {
  debug: (...a: unknown[]) => log("debug", a),
  info: (...a: unknown[]) => log("info", a),
  warn: (...a: unknown[]) => log("warn", a),
  error: (...a: unknown[]) => log("error", a),
};

export { redact };
