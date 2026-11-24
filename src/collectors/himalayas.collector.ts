import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { htmlToText } from "../utils/text";
import { detectTechnologies, mapSeniority, toMonthly } from "../services/normalize";

interface HimalayasJob {
  title: string;
  companyName?: string;
  employmentType?: string;
  minSalary?: number | string | null;
  maxSalary?: number | string | null;
  salaryPeriod?: string;
  currency?: string;
  seniority?: string[];
  locationRestrictions?: string[];
  description?: string;
  excerpt?: string;
  categories?: string[];
  pubDate?: number | string;
  applicationLink?: string;
  guid?: string;
}

function monthlyFrom(v: number, cur: string, period?: string): number {
  switch ((period ?? "").toLowerCase()) {
    case "hourly": return toMonthly(v, cur, "hour");
    case "weekly": return Math.round((v * 52) / 12);
    case "monthly": return Math.round(v);
    case "annual": case "yearly": return toMonthly(v, cur, "year");
    default: return toMonthly(v, cur, undefined);
  }
}

export function normalizeHimalayas(j: HimalayasJob, now = new Date()): Job {
  const description = htmlToText(j.description ?? j.excerpt ?? "");
  const type = (j.employmentType ?? "").toLowerCase();
  const contract = /contract/.test(type) ? "PJ" : /freelance/.test(type) ? "Freelance" : /part/.test(type) ? "Part-time" : /intern/.test(type) ? "Internship" : /full/.test(type) ? "Full-time" : undefined;
  const cur = j.currency?.toUpperCase();
  const min = Number(j.minSalary) || 0;
  const max = Number(j.maxSalary) || 0;
  const seniority = mapSeniority(j.seniority);
  const restrictions = j.locationRestrictions ?? [];
  const epoch = Number(j.pubDate);
  const url = j.applicationLink ?? j.guid ?? "";
  return {
    externalId: j.guid ?? url,
    source: "himalayas",
    title: j.title.trim(),
    company: j.companyName?.trim() || "Não informada",
    // Sem restrição declarada = aberta a qualquer país
    location: restrictions.length ? restrictions.join(", ") : "Worldwide",
    remote: true,
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    ...(cur && min > 0 ? { salaryMin: monthlyFrom(min, cur, j.salaryPeriod) } : {}),
    ...(cur && max > 0 ? { salaryMax: monthlyFrom(max, cur, j.salaryPeriod) } : {}),
    ...(cur && (min > 0 || max > 0) ? { currency: cur } : {}),
    technologies: detectTechnologies(j.title, (j.categories ?? []).join(" "), description),
    description,
    url,
    ...(Number.isFinite(epoch) && epoch > 0 ? { publishedAt: new Date(epoch * 1000) } : {}),
    discoveredAt: now,
  };
}

export class HimalayasCollector implements Collector {
  readonly name = "himalayas";
  constructor(private pages = 3, private pageSize = 100) {}

  async collect(): Promise<CollectResult> {
    const jobs: Job[] = [];
    const warnings: string[] = [];
    const now = new Date();
    let cursor: string | undefined;
    for (let i = 0; i < this.pages; i++) {
      try {
        const url = `https://himalayas.app/jobs/api?limit=${this.pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const data = await fetchJson<{ jobs?: HimalayasJob[]; nextCursor?: string | null }>(url);
        for (const j of data.jobs ?? []) if (j?.title && (j.applicationLink || j.guid)) jobs.push(normalizeHimalayas(j, now));
        cursor = data.nextCursor ?? undefined;
        if (!cursor) break;
      } catch (e) {
        warnings.push(`página ${i + 1}: ${(e as Error).message}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (jobs.length === 0 && warnings.length) throw new Error(warnings.join("; "));
    return { jobs, warnings };
  }
}
