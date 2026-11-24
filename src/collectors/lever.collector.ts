import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { detectTechnologies, inferContractType, inferSeniority, toMonthly, type Period } from "../services/normalize";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  categories?: { location?: string; commitment?: string; allLocations?: string[] };
  workplaceType?: string; // remote | hybrid | on-site | unspecified
  descriptionPlain?: string;
  additionalPlain?: string;
  salaryRange?: { currency?: string; interval?: string; min?: number; max?: number };
}

const INTERVAL: Record<string, Period> = {
  "per-year-salary": "year", "per-month-salary": "month", "per-hour-wage": "hour",
};

export function normalizeLever(p: LeverPosting, company: string, now = new Date()): Job {
  const description = [p.descriptionPlain, p.additionalPlain].filter(Boolean).join("\n\n");
  const locs = p.categories?.allLocations?.length ? p.categories.allLocations.join(" / ") : p.categories?.location;
  const wt = p.workplaceType?.toLowerCase();
  const remote = wt === "remote" ? true : wt === "hybrid" || wt === "on-site" ? false : null;
  const contract = inferContractType(`${p.categories?.commitment ?? ""} ${description}`);
  const seniority = inferSeniority(p.text);
  const sr = p.salaryRange;
  const cur = sr?.currency?.toUpperCase();
  const period = sr?.interval ? INTERVAL[sr.interval] : undefined;
  const hasSalary = !!cur && (sr?.min || sr?.max);
  return {
    externalId: `${company}:${p.id}`,
    source: "lever",
    title: p.text.trim(),
    company,
    location: locs?.trim() || "Não informado",
    remote,
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    ...(hasSalary && sr?.min ? { salaryMin: toMonthly(sr.min, cur!, period) } : {}),
    ...(hasSalary && sr?.max ? { salaryMax: toMonthly(sr.max, cur!, period) } : {}),
    ...(hasSalary ? { currency: cur! } : {}),
    technologies: detectTechnologies(p.text, description),
    description,
    url: p.hostedUrl,
    ...(p.createdAt ? { publishedAt: new Date(p.createdAt) } : {}),
    discoveredAt: now,
  };
}

export interface LeverCompany { name: string; region?: "global" | "eu" | undefined }

export class LeverCollector implements Collector {
  readonly name = "lever";
  constructor(private companies: LeverCompany[]) {}

  async collect(): Promise<CollectResult> {
    const out: Job[] = [];
    const errors: string[] = [];
    for (const c of this.companies) {
      try {
        const host = c.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
        const url = `https://${host}/v0/postings/${encodeURIComponent(c.name)}?mode=json`;
        const data = await fetchJson<LeverPosting[]>(url, { timeoutMs: 30_000 });
        const now = new Date();
        for (const p of Array.isArray(data) ? data : []) if (p?.id && p.text && p.hostedUrl) out.push(normalizeLever(p, c.name, now));
      } catch (e) {
        errors.push(`${c.name}: ${(e as Error).message}`);
      }
    }
    if (errors.length && out.length === 0) throw new Error(errors.join("; "));
    return { jobs: out, warnings: errors };
  }
}
