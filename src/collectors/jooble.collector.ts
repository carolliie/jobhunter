import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { htmlToText } from "../utils/text";
import { detectTechnologies, inferContractType, inferSeniority, parseSalaryText, remoteFromText } from "../services/normalize";

/** API oficial do Jooble (chave gratuita solicitada em jooble.org/api/about). */
interface JoobleJob {
  id?: number | string;
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
}

export function normalizeJooble(j: JoobleJob, now = new Date()): Job {
  const title = htmlToText(j.title ?? "");
  const description = htmlToText(j.snippet ?? "");
  const text = `${title}\n${description}\n${j.location ?? ""}`;
  const type = (j.type ?? "").toLowerCase();
  const contract =
    /contract|pj|tempor/.test(type) ? "PJ" : /part/.test(type) ? "Part-time" : /intern|est[aá]gio/.test(type) ? "Internship" : inferContractType(text) ?? (/full/.test(type) ? "Full-time" : undefined);
  const salary = parseSalaryText(j.salary);
  const seniority = inferSeniority(title);
  const updated = j.updated ? new Date(j.updated) : undefined;
  const loc = (j.location ?? "").trim();
  return {
    externalId: String(j.id ?? j.link),
    source: "jooble",
    title,
    company: j.company?.trim() || "Não informada",
    // As consultas são feitas com location=Brasil; garante a elegibilidade quando o local vier só com a cidade
    location: /brasil|brazil/i.test(loc) ? loc : `${loc || "Brasil"}, Brasil`,
    remote: remoteFromText(text),
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    ...(salary.min !== undefined ? { salaryMin: salary.min } : {}),
    ...(salary.max !== undefined ? { salaryMax: salary.max } : {}),
    ...(salary.currency ? { currency: salary.currency } : {}),
    technologies: detectTechnologies(title, description),
    description,
    url: j.link ?? "",
    ...(updated && !isNaN(updated.getTime()) ? { publishedAt: updated } : {}),
    discoveredAt: now,
  };
}

export class JoobleCollector implements Collector {
  readonly name = "jooble";
  constructor(private apiKey: string, private queries: string[], private location = "Brasil", private perQuery = 50) {}

  async collect(): Promise<CollectResult> {
    const byId = new Map<string, Job>();
    const warnings: string[] = [];
    const now = new Date();
    for (const q of this.queries) {
      try {
        // A chave vai no caminho da URL (padrão da API); fetchJson nunca a inclui nas mensagens de erro.
        const data = await fetchJson<{ jobs?: JoobleJob[] }>(`https://jooble.org/api/${encodeURIComponent(this.apiKey)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keywords: q, location: this.location, page: "1", ResultOnPage: String(this.perQuery) }),
          retries: 1,
        });
        for (const j of data.jobs ?? []) {
          const job = j?.title && j.link ? normalizeJooble(j, now) : null;
          if (job) byId.set(job.externalId, job);
        }
      } catch (e) {
        warnings.push(`"${q}": ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (byId.size === 0 && warnings.length) throw new Error(warnings.join("; "));
    return { jobs: [...byId.values()], warnings };
  }
}
