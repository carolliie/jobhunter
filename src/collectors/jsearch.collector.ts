import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { htmlToText } from "../utils/text";
import { detectTechnologies, inferContractType, inferSeniority, parseRelativeTime, remoteFromText, toMonthly, type Period } from "../services/normalize";

/**
 * JSearch (RapidAPI) agrega vagas publicadas no LinkedIn, Indeed, Glassdoor etc. via API oficial licenciada,
 * sem scraping feito por nós. Exige chave (plano gratuito limitado).
 */
interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name?: string;
  job_publisher?: string;
  job_apply_link?: string;
  apply_options?: Array<{ publisher?: string; apply_link?: string; is_direct?: boolean }>;
  job_description?: string;
  job_is_remote?: boolean | null;
  job_employment_type?: string;
  job_employment_types?: string[] | null;
  job_location?: string | null;
  job_posted_at?: string | null;
  job_posted_at_datetime_utc?: string;
  job_city?: string;
  job_state?: string;
  job_country?: string;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_currency?: string | null;
  job_salary_period?: string | null;
}

const PERIOD: Record<string, Period> = { YEAR: "year", MONTH: "month", HOUR: "hour" };

export function normalizeJSearch(j: JSearchJob, now = new Date()): Job {
  const title = (j.job_title ?? "").trim();
  const description = htmlToText(j.job_description ?? "");
  const publisher = (j.job_publisher ?? "desconhecida").trim();
  const type = (j.job_employment_types?.[0] ?? j.job_employment_type ?? "").toUpperCase();
  const contract =
    type === "CONTRACTOR" ? "PJ" : type === "PARTTIME" ? "Part-time" : type === "INTERN" ? "Internship" : type === "FULLTIME" ? "Full-time" : inferContractType(`${title}\n${description}`);
  const cur = j.job_salary_currency?.toUpperCase();
  const period = j.job_salary_period ? PERIOD[j.job_salary_period.toUpperCase()] : undefined;
  const seniority = inferSeniority(title);
  const place = [j.job_city, j.job_state].filter(Boolean).join(", ") || j.job_location || "";
  // As consultas são escopadas ao Brasil (country=br); sem país na resposta, assume Brasil
  const country = !j.job_country || j.job_country === "BR" ? "Brasil" : j.job_country;
  // Data exata quando existe; senão aproxima o texto relativo ("há 2 dias") a partir de agora
  const exact = j.job_posted_at_datetime_utc ? new Date(j.job_posted_at_datetime_utc) : undefined;
  const published = exact && !isNaN(exact.getTime()) ? exact : parseRelativeTime(j.job_posted_at, now);
  // O título tem a palavra final: "Híbrido"/"Presencial" prevalece sobre o flag da API
  const remote = remoteFromText(title) === false ? false : typeof j.job_is_remote === "boolean" && j.job_is_remote ? true : remoteFromText(`${title}\n${description}`);
  return {
    externalId: j.job_id,
    source: `jsearch/${publisher.toLowerCase()}`,
    title,
    company: j.employer_name?.trim() || "Não informada",
    location: [place, country].filter(Boolean).join(", ") || "Não informado",
    remote,
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    ...(cur && j.job_min_salary ? { salaryMin: toMonthly(j.job_min_salary, cur, period) } : {}),
    ...(cur && j.job_max_salary ? { salaryMax: toMonthly(j.job_max_salary, cur, period) } : {}),
    ...(cur && (j.job_min_salary || j.job_max_salary) ? { currency: cur } : {}),
    technologies: detectTechnologies(title, description),
    description,
    // Prefere o link direto da empresa, quando a API licenciada o informa
    url: j.apply_options?.find((o) => o.is_direct && o.apply_link)?.apply_link ?? j.job_apply_link ?? "",
    ...(published && !isNaN(published.getTime()) ? { publishedAt: published } : {}),
    discoveredAt: now,
  };
}

export class JSearchCollector implements Collector {
  readonly name = "jsearch";
  constructor(private apiKey: string, private queries: string[], private datePosted = "3days") {}

  async collect(): Promise<CollectResult> {
    const byId = new Map<string, Job>();
    const warnings: string[] = [];
    const now = new Date();
    for (const q of this.queries) {
      try {
        const qs = new URLSearchParams({ query: q, page: "1", num_pages: "1", country: "br", language: "pt", date_posted: this.datePosted });
        const data = await fetchJson<{ data?: { jobs?: JSearchJob[] } | JSearchJob[] }>(`https://jsearch.p.rapidapi.com/search-v2?${qs}`, {
          headers: { "x-rapidapi-key": this.apiKey, "x-rapidapi-host": "jsearch.p.rapidapi.com" },
          retries: 1,
        });
        const list = Array.isArray(data.data) ? data.data : data.data?.jobs ?? [];
        for (const j of list) if (j?.job_id && j.job_title && j.job_apply_link) byId.set(j.job_id, normalizeJSearch(j, now));
      } catch (e) {
        warnings.push(`"${q}": ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (byId.size === 0 && warnings.length) throw new Error(warnings.join("; "));
    return { jobs: [...byId.values()], warnings };
  }
}
