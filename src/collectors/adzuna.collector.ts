import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { htmlToText } from "../utils/text";
import { detectTechnologies, inferContractType, inferSeniority, remoteFromText, toMonthly } from "../services/normalize";

interface AdzunaResult {
  id: string | number;
  title: string;
  description?: string;
  created?: string;
  redirect_url: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  contract_type?: string; // permanent | contract
  contract_time?: string; // full_time | part_time
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
}

export function normalizeAdzuna(r: AdzunaResult, now = new Date()): Job {
  const title = htmlToText(r.title ?? "");
  const description = htmlToText(r.description ?? "");
  const text = `${title}\n${description}`;
  const predicted = String(r.salary_is_predicted ?? "0") === "1";
  const published = r.created ? new Date(r.created) : undefined;
  const contract =
    r.contract_time === "part_time" ? "Part-time" : inferContractType(text) ?? (r.contract_type === "contract" ? "PJ" : undefined);
  const seniority = inferSeniority(title);
  // Salário estimado pelo Adzuna NÃO é divulgado pela empresa: ignoramos.
  const min = !predicted && r.salary_min ? toMonthly(r.salary_min, "BRL", "year") : undefined;
  const max = !predicted && r.salary_max ? toMonthly(r.salary_max, "BRL", "year") : undefined;
  return {
    externalId: String(r.id),
    source: "adzuna",
    title,
    company: r.company?.display_name?.trim() || "Não informada",
    // O endpoint /br só retorna vagas no Brasil; "Brasil" garante a elegibilidade no filtro
    location: `${r.location?.display_name ?? "Brasil"}, Brasil`,
    remote: remoteFromText(text),
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    ...(min ? { salaryMin: min } : {}),
    ...(max ? { salaryMax: max } : {}),
    ...(min || max ? { currency: "BRL" } : {}),
    technologies: detectTechnologies(title, description),
    description,
    url: r.redirect_url,
    ...(published && !isNaN(published.getTime()) ? { publishedAt: published } : {}),
    discoveredAt: now,
  };
}

export class AdzunaCollector implements Collector {
  readonly name = "adzuna";
  constructor(
    private creds: { appId: string; appKey: string },
    private queries: string[],
    private maxDaysOld = 7,
  ) {}

  async collect(): Promise<CollectResult> {
    const byId = new Map<string, Job>();
    const warnings: string[] = [];
    const now = new Date();
    for (const q of this.queries) {
      try {
        const qs = new URLSearchParams({
          app_id: this.creds.appId, app_key: this.creds.appKey, results_per_page: "50",
          what: q, sort_by: "date", max_days_old: String(this.maxDaysOld), "content-type": "application/json",
        });
        const data = await fetchJson<{ results?: AdzunaResult[] }>(`https://api.adzuna.com/v1/api/jobs/br/search/1?${qs}`);
        for (const r of data.results ?? []) if (r?.id && r.title && r.redirect_url) byId.set(String(r.id), normalizeAdzuna(r, now));
      } catch (e) {
        // a mensagem de erro não inclui a URL (que contém a chave)
        warnings.push(`"${q}": ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (byId.size === 0 && warnings.length) throw new Error(warnings.join("; "));
    return { jobs: [...byId.values()], warnings };
  }
}
