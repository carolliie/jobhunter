import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { htmlToText, decodeEntities } from "../utils/text";
import { detectTechnologies, mapSeniority, toMonthly, type Period } from "../services/normalize";

interface JobicyJob {
  id: number | string;
  url: string;
  jobTitle: string;
  companyName?: string;
  jobType?: string[] | string;
  jobGeo?: string;
  jobLevel?: string;
  jobDescription?: string;
  pubDate?: string;
  salaryMin?: number | string;
  salaryMax?: number | string;
  salaryCurrency?: string;
  salaryPeriod?: string;
}

const PERIOD: Record<string, Period> = { yearly: "year", annual: "year", monthly: "month", hourly: "hour" };

export function normalizeJobicy(j: JobicyJob, now = new Date()): Job {
  const description = htmlToText(j.jobDescription ?? "");
  const title = decodeEntities(j.jobTitle ?? "").trim();
  const type = (Array.isArray(j.jobType) ? j.jobType.join(" ") : j.jobType ?? "").toLowerCase();
  const contract = /freelance/.test(type) ? "Freelance" : /contract/.test(type) ? "PJ" : /part/.test(type) ? "Part-time" : /intern/.test(type) ? "Internship" : /full/.test(type) ? "Full-time" : undefined;
  const cur = j.salaryCurrency?.toUpperCase();
  const period = j.salaryPeriod ? PERIOD[j.salaryPeriod.toLowerCase()] : undefined;
  const min = Number(j.salaryMin) || 0;
  const max = Number(j.salaryMax) || 0;
  const seniority = mapSeniority(j.jobLevel);
  const published = j.pubDate ? new Date(j.pubDate) : undefined;
  return {
    externalId: String(j.id),
    source: "jobicy",
    title,
    company: decodeEntities(j.companyName ?? "").trim() || "Não informada",
    location: (j.jobGeo ?? "").replace(/\s+/g, " ").trim() || "Não informado",
    remote: true,
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    ...(cur && min > 0 ? { salaryMin: toMonthly(min, cur, period) } : {}),
    ...(cur && max > 0 ? { salaryMax: toMonthly(max, cur, period) } : {}),
    ...(cur && (min > 0 || max > 0) ? { currency: cur } : {}),
    technologies: detectTechnologies(title, description),
    description,
    url: j.url, // os termos exigem que os botões levem à URL original
    ...(published && !isNaN(published.getTime()) ? { publishedAt: published } : {}),
    discoveredAt: now,
  };
}

export class JobicyCollector implements Collector {
  readonly name = "jobicy";
  /** geo: "latam" cobre vagas abertas à América Latina; sem geo traz o feed geral. */
  constructor(private geos: Array<string | undefined> = ["latam", undefined]) {}

  async collect(): Promise<CollectResult> {
    const byId = new Map<string, Job>();
    const warnings: string[] = [];
    const now = new Date();
    for (const geo of this.geos) {
      try {
        const url = `https://jobicy.com/api/v2/remote-jobs?count=100${geo ? `&geo=${geo}` : ""}`;
        const data = await fetchJson<{ jobs?: JobicyJob[] }>(url);
        for (const j of data.jobs ?? []) if (j?.id && j.jobTitle && j.url) byId.set(String(j.id), normalizeJobicy(j, now));
      } catch (e) {
        warnings.push(`geo=${geo ?? "all"}: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1500)); // gentileza com a API
    }
    if (byId.size === 0 && warnings.length) throw new Error(warnings.join("; "));
    return { jobs: [...byId.values()], warnings };
  }
}
