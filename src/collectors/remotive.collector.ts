import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { htmlToText } from "../utils/text";
import { detectTechnologies, inferContractType, inferSeniority, parseSalaryText } from "../services/normalize";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

const CONTRACT: Record<string, string> = {
  full_time: "Full-time", part_time: "Part-time", contract: "PJ", freelance: "Freelance", internship: "Internship",
};

export function normalizeRemotive(j: RemotiveJob, now = new Date()): Job {
  const description = htmlToText(j.description ?? "");
  const salary = parseSalaryText(j.salary);
  // A API entrega a data sem fuso; tratamos como UTC.
  const iso = j.publication_date && !/[zZ]|[+-]\d\d:?\d\d$/.test(j.publication_date) ? `${j.publication_date}Z` : j.publication_date;
  const published = iso ? new Date(iso) : undefined;
  const contract = (j.job_type && CONTRACT[j.job_type]) || inferContractType(description);
  const seniority = inferSeniority(j.title);
  return {
    externalId: String(j.id),
    source: "remotive",
    title: j.title.trim(),
    company: j.company_name.trim(),
    location: (j.candidate_required_location ?? "").trim() || "Não informado",
    remote: true, // todas as vagas do Remotive são remotas
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    ...(salary.min !== undefined ? { salaryMin: salary.min } : {}),
    ...(salary.max !== undefined ? { salaryMax: salary.max } : {}),
    ...(salary.currency ? { currency: salary.currency } : {}),
    technologies: detectTechnologies(j.title, (j.tags ?? []).join(" "), description),
    description,
    url: j.url,
    ...(published && !isNaN(published.getTime()) ? { publishedAt: published } : {}),
    discoveredAt: now,
  };
}

export class RemotiveCollector implements Collector {
  readonly name = "remotive";
  constructor(private category = "software-dev", private limit = 200) {}

  async collect(): Promise<CollectResult> {
    const url = `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(this.category)}&limit=${this.limit}`;
    const data = await fetchJson<{ jobs?: RemotiveJob[] }>(url);
    const now = new Date();
    const jobs = (data.jobs ?? []).filter((j) => j?.id && j.title && j.url).map((j) => normalizeRemotive(j, now));
    return { jobs, warnings: [] };
  }
}
