import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { ZenRowsClient } from "../services/zenrows.service";
import { decodeEntities, htmlToText } from "../utils/text";
import { detectTechnologies, inferContractType, inferSeniority } from "../services/normalize";

export interface LinkedInCard {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  publishedAt?: Date;
}

export interface ZenRowsLinkedInOptions {
  queries: string[];
  location?: string;
  maxDaysOld?: number;
  maxResultsPerQuery?: number;
  maxDetailsPerQuery?: number;
}

function attr(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = html.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
  return value ? decodeEntities(value) : undefined;
}

function classContent(html: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<([a-z][\\w:-]*)[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i"));
  return htmlToText(match?.[2] ?? "");
}

/** Extrai os cards do HTML público de busca; exportado para teste contra mudanças de markup. */
export function parseLinkedInSearch(html: string): LinkedInCard[] {
  const chunks = html.split(/(?=<li\b)/i);
  const cards: LinkedInCard[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const id = chunk.match(/urn:li:jobPosting:(\d+)/i)?.[1]
      ?? chunk.match(/\/jobs\/view\/(?:[^"'/?]+-)?(\d+)(?:[/?"'])/i)?.[1];
    if (!id || seen.has(id)) continue;
    const title = classContent(chunk, "base-search-card__title");
    const company = classContent(chunk, "base-search-card__subtitle");
    const location = classContent(chunk, "job-search-card__location");
    const anchor = chunk.match(/<a\b[^>]*class=["'][^"']*\bbase-card__full-link\b[^"']*["'][^>]*>/i)?.[0];
    const time = chunk.match(/<time\b[^>]*>/i)?.[0];
    const dateValue = time ? attr(time, "datetime") : undefined;
    const published = dateValue ? new Date(dateValue) : undefined;
    if (!title || !anchor) continue;
    seen.add(id);
    cards.push({
      id,
      title,
      company: company || "Não informada",
      location: location || "Brasil",
      url: `https://www.linkedin.com/jobs/view/${id}`,
      ...(published && !isNaN(published.getTime()) ? { publishedAt: published } : {}),
    });
  }
  return cards;
}

export function parseLinkedInDetail(html: string): { description: string; applicants?: number } {
  const start = html.search(/<div\b[^>]*class=["'][^"']*\bshow-more-less-html__markup\b/i);
  let description = "";
  if (start >= 0) {
    const tail = html.slice(start);
    const end = tail.search(/<\/section>|<section\b|<div\b[^>]*class=["'][^"']*\bdescription__job-criteria-list\b/i);
    description = htmlToText(tail.slice(0, end > 0 ? end : Math.min(tail.length, 80_000)));
  }
  const pageText = htmlToText(html).slice(0, 40_000);
  const applicantsText = pageText.match(/(?:seja um dos primeiros\s*)?(\d[\d.,]*)\s+(?:candidatos?|applicants?)/i)?.[1];
  const applicants = applicantsText ? Number(applicantsText.replace(/\D/g, "")) : undefined;
  return { description, ...(applicants && applicants > 0 ? { applicants } : {}) };
}

export function normalizeLinkedIn(card: LinkedInCard, detail: { description?: string; applicants?: number } = {}, now = new Date()): Job {
  const description = detail.description?.trim() || `${card.title}\n${card.company}\n${card.location}`;
  const contract = inferContractType(`${card.title}\n${description}`);
  const seniority = inferSeniority(card.title);
  return {
    externalId: card.id,
    source: "zenrows/linkedin",
    title: card.title,
    company: card.company,
    location: /brasil|brazil/i.test(card.location) ? card.location : `${card.location}, Brasil`,
    remote: true, // a URL enviada ao LinkedIn contém f_WT=2 (remote)
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    technologies: detectTechnologies(card.title, description),
    description,
    url: card.url,
    ...(card.publishedAt ? { publishedAt: card.publishedAt } : {}),
    discoveredAt: now,
    ...(detail.applicants !== undefined ? { applicants: detail.applicants } : {}),
  };
}

export class ZenRowsLinkedInCollector implements Collector {
  readonly name = "zenrows-linkedin";
  private options: Required<ZenRowsLinkedInOptions>;

  constructor(private client: ZenRowsClient, options: ZenRowsLinkedInOptions) {
    this.options = {
      queries: options.queries,
      location: options.location ?? "Brasil",
      maxDaysOld: options.maxDaysOld ?? 7,
      maxResultsPerQuery: options.maxResultsPerQuery ?? 10,
      maxDetailsPerQuery: options.maxDetailsPerQuery ?? 6,
    };
  }

  private searchUrl(query: string): string {
    const seconds = Math.max(1, this.options.maxDaysOld) * 86_400;
    const qs = new URLSearchParams({
      keywords: query,
      location: this.options.location,
      f_WT: "2",
      f_TPR: `r${seconds}`,
      sortBy: "DD",
    });
    return `https://www.linkedin.com/jobs/search/?${qs}`;
  }

  async collect(): Promise<CollectResult> {
    const jobs = new Map<string, Job>();
    const warnings: string[] = [];
    const now = new Date();
    for (const query of this.options.queries) {
      try {
        const searchHtml = await this.client.fetchPage(this.searchUrl(query), { proxyCountry: "br" });
        const cards = parseLinkedInSearch(searchHtml).slice(0, this.options.maxResultsPerQuery);
        if (!cards.length) warnings.push(`"${query}": nenhum card reconhecido no HTML do LinkedIn`);
        for (const [index, card] of cards.entries()) {
          let detail: ReturnType<typeof parseLinkedInDetail> = { description: "" };
          if (index < this.options.maxDetailsPerQuery && !jobs.has(card.id)) {
            try {
              const html = await this.client.fetchPage(card.url, { proxyCountry: "br" });
              detail = parseLinkedInDetail(html);
            } catch (error) {
              warnings.push(`detalhe ${card.id}: ${(error as Error).message}`);
            }
          }
          if (!jobs.has(card.id) || detail.description) jobs.set(card.id, normalizeLinkedIn(card, detail, now));
        }
      } catch (error) {
        warnings.push(`"${query}": ${(error as Error).message}`);
      }
    }
    if (!jobs.size && warnings.length) throw new Error(warnings.join("; "));
    return { jobs: [...jobs.values()], warnings };
  }
}
