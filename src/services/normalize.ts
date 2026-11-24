/** Helpers de normalização compartilhados pelos coletores. */

const TECH_PATTERNS: Array<[string, RegExp]> = [
  ["TypeScript", /\btypescript\b/i],
  ["JavaScript", /\bjavascript\b|\becmascript\b/i],
  ["Node.js", /\bnode(?:\.?js)?\b/i],
  ["React Native", /\breact[\s-]?native\b/i],
  ["React", /\breact(?:\.?js)?\b(?![\s-]*native)/i],
  ["Next.js", /\bnext\.?js\b/i],
  ["PostgreSQL", /\bpostgres(?:ql)?\b/i],
  ["REST APIs", /\brest(?:ful)?[\s-]*apis?\b|\brestful\b/i],
  ["SaaS", /\bsaas\b/i],
  ["Docker", /\bdocker\b/i],
  ["Flutter", /\bflutter\b/i],
  ["Inteligência Artificial", /\bartificial intelligence\b|\bmachine learning\b|\bllms?\b|\bgenerative ai\b|\bgen-?ai\b|inteligência artificial|\bai\b(?!\s*(?:-|\/)?\s*disclaimer)/i],
  ["Automações e integrações", /\bautomations?\b|automações|\bn8n\b|\bzapier\b|\bwebhooks?\b/i],
  // Extras (exibidas, mas fora dos interesses por padrão)
  ["Spring Boot", /\bspring[\s-]?boot\b|\bspring framework\b/i],
  ["WordPress", /\bwordpress\b|\bwoocommerce\b/i],
  ["SQL", /\bsql\b/i],
  ["Express", /\bexpress(?:\.?js)?\b(?=[^.\n]{0,40}(node|api|server|backend))|\bnode[^.\n]{0,20}express\b/i],
  ["HTML/CSS", /\bhtml5?\b|\bcss3?\b/i],
  ["Python", /\bpython\b/i],
  ["Go", /\bgolang\b|\bgo\s+(?:developer|engineer|lang)\b/i],
  ["Java", /\bjava\b(?!\s*script)/i],
  ["AWS", /\baws\b|\bamazon web services\b/i],
  ["GraphQL", /\bgraphql\b/i],
  ["Vue", /\bvue(?:\.?js)?\b/i],
  ["Angular", /\bangular\b/i],
  ["Kubernetes", /\bkubernetes\b|\bk8s\b/i],
  ["MongoDB", /\bmongodb\b/i],
  ["Redis", /\bredis\b/i],
  ["Prisma", /\bprisma\b/i],
  ["Tailwind", /\btailwind\b/i],
];

export function detectTechnologies(...texts: Array<string | undefined>): string[] {
  const haystack = texts.filter(Boolean).join("\n");
  return TECH_PATTERNS.filter(([, re]) => re.test(haystack)).map(([name]) => name);
}

const wordRe = (w: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu");

export function titleHasAny(title: string, words: string[]): string | undefined {
  return words.find((w) => wordRe(w).test(title));
}

/** Infere senioridade só pelo título. Retorna undefined se não houver evidência. */
export function inferSeniority(title: string): string | undefined {
  const t = title;
  if (/\b(intern|internship|trainee)\b|estágio|estagiári/i.test(t)) return "intern";
  if (/\b(senior|sr\.?|staff|principal|lead|head|architect)\b|sênior|\biii\b|\biv\b/i.test(t)) return "senior";
  if (/\b(junior|jr\.?|entry[\s-]level|graduate|associate)\b|júnior|\bi\b$/i.test(t)) return "junior";
  if (/\b(mid|mid-level|intermediate)\b|\bpleno\b|\bii\b/i.test(t)) return "mid";
  return undefined;
}

/** Palavras que indicam trabalho por projeto (freela), independente do campo de contrato. */
const FREELANCE_TEXT = /\bfreelanc|\bfreela\b|project[\s-]based|one[\s-]?(time|off) project|\bgig\b|por projeto|\bwordpress\b|\bchat-?bot|\btelegram bot|\bwhatsapp bot|\bscrap(er|ing)\b|\blanding page|\bn8n\b|\bzapier\b|\bmake\.com\b/i;
export function looksFreelance(title: string, contractType: string | undefined, description = ""): boolean {
  if (contractType === "Freelance") return true;
  return FREELANCE_TEXT.test(title) || /\bfreelanc|\bproject[\s-]based\b/i.test(description.slice(0, 1500));
}

export function inferContractType(text: string): string | undefined {
  if (/\bclt\b/i.test(text)) return "CLT";
  if (/\bpj\b|pessoa jur[ií]dica|\bb2b\b|\bcontractor\b|independent contractor/i.test(text)) return "PJ";
  if (/\bintern(ship)?\b|est[aá]gio/i.test(text)) return "Internship";
  if (/\bpart[\s_-]?time\b/i.test(text)) return "Part-time";
  if (/\bfull[\s_-]?time\b/i.test(text)) return "Full-time";
  return undefined;
}

export interface ParsedSalary { min?: number; max?: number; currency?: string }
export type Period = "hour" | "month" | "year" | undefined;

/** Converte um valor para mensal. Sem período explícito, usa heurística por magnitude. */
export function toMonthly(value: number, currency: string, period: Period): number {
  if (period === "hour") return Math.round(value * 160);
  if (period === "year") return Math.round(value / 12);
  if (period === "month") return Math.round(value);
  const annualThreshold = currency === "BRL" ? 60_000 : 12_000;
  return value >= annualThreshold ? Math.round(value / 12) : Math.round(value);
}

/** Interpreta texto livre de salário (ex.: "$50k - $70k/year", "R$ 5.000 por mês"). */
export function parseSalaryText(raw: string | undefined | null): ParsedSalary {
  if (!raw) return {};
  const full = raw.replace(/\u00a0/g, " ");
  // Só lê números perto do símbolo/código da moeda (evita pegar "100%" ou anos do texto ao redor)
  const sym = /R\$|US\$|C\$|[$€£]/.exec(full);
  const code = /\b(BRL|USD|EUR|GBP|CAD)\b|reais/i.exec(full);
  const text = sym ? full.slice(sym.index, sym.index + 60) : code ? full.slice(Math.max(0, code.index - 30), code.index + 40) : full;
  let currency: string | undefined;
  if (/R\$|\bBRL\b|reais/i.test(text)) currency = "BRL";
  else if (/€|\bEUR\b/i.test(text)) currency = "EUR";
  else if (/£|\bGBP\b/i.test(text)) currency = "GBP";
  else if (/\bCAD\b|C\$/i.test(text)) currency = "CAD";
  else if (/\$|\bUSD\b/i.test(text)) currency = "USD";
  if (!currency) return {};

  const nums: number[] = [];
  const NUM = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k)?`;
  // Primeiro valor + (opcionalmente) um segundo valor ligado por conector de faixa ("-", "a", "até"...)
  const re = new RegExp(`${NUM}(?:\\s*(?:-|–|—|a|à|to|até|and)\\s*(?:R\\$|US\\$|C\\$|[$€£])?\\s*${NUM})?`, "i");
  const m = re.exec(text);
  if (m) {
    for (const [v, k] of [[m[1], m[2]], [m[3], m[4]]] as const) {
      if (!v) continue;
      let s = v;
      // "1.234,56" (pt-BR) ou "1,234.56" (en): remove separadores de milhar
      if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, "");
      else s = s.replace(",", ".");
      let n = parseFloat(s);
      if (!Number.isFinite(n)) continue;
      if (k) n *= 1000;
      nums.push(n);
    }
  }
  if (nums.length === 0) return {};

  let period: Period;
  if (/hour|hora|\/\s*h\b|\bhr\b/i.test(text)) period = "hour";
  else if (/month|m[eê]s|mensal|\/\s*mo\b/i.test(text)) period = "month";
  else if (/year|annual|\bano\b|anual|\/\s*yr\b|\bp\.?a\.?\b/i.test(text)) period = "year";

  const vals = nums.slice(0, 2).map((n) => toMonthly(n, currency!, period));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return { min, max, currency };
}

export function remoteFromText(text: string): boolean | null {
  if (/\b(remote|remoto|anywhere|work from home|home[\s-]?office|100% remot[oa]|distributed)\b/i.test(text)) return true;
  if (/\b(on-?site|in[\s-]?office|presencial|hybrid|híbrido)\b/i.test(text)) return false;
  return null;
}

export function mapSeniority(raw: string | string[] | undefined): string | undefined {
  const t = (Array.isArray(raw) ? raw.join(" ") : raw ?? "").toLowerCase();
  if (!t) return undefined;
  if (/intern/.test(t)) return "intern";
  if (/senior|lead|staff|principal|manager|director|executive|head/.test(t)) return "senior";
  if (/entry|junior|jr|graduate/.test(t)) return "junior";
  if (/mid|intermediate/.test(t)) return "mid";
  return undefined;
}

/** "há 2 dias", "3 hours ago", "ontem"... -> Date aproximada (âncora = agora). Retorna undefined se não entender. */
export function parseRelativeTime(text: string | null | undefined, now = new Date()): Date | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/\b(hoje|today|just now|agora)\b/.test(t)) return now;
  if (/\b(ontem|yesterday)\b/.test(t)) return new Date(now.getTime() - 24 * 3600_000);
  const m = /(\d+)\s*\+?\s*(minuto|min|hora|hour|hr|dia|day|semana|week|mes|month)/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!;
  const ms = /^(minuto|min)/.test(unit) ? 60_000 : /^(hora|hour|hr)/.test(unit) ? 3_600_000 : /^(dia|day)/.test(unit) ? 86_400_000 : /^(semana|week)/.test(unit) ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(now.getTime() - n * ms);
}
