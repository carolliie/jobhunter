import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { decodeEntities, htmlToText } from "../utils/text";
import { detectTechnologies, inferContractType, inferSeniority, remoteFromText } from "../services/normalize";

interface GreenhouseJob {
  id: number | string;
  title: string;
  absolute_url: string;
  company_name?: string;
  location?: { name?: string };
  first_published?: string;
  updated_at?: string;
  content?: string; // HTML escapado como entidades
}

export function normalizeGreenhouse(j: GreenhouseJob, board: string, now = new Date()): Job {
  const description = htmlToText(decodeEntities(j.content ?? "")) /* content vem com HTML escapado */;
  const location = j.location?.name?.trim() || "Não informado";
  // first_published = data de publicação; updated_at muda em qualquer edição, então só é fallback.
  const dateStr = j.first_published ?? j.updated_at;
  const published = dateStr ? new Date(dateStr) : undefined;
  const contract = inferContractType(description);
  const seniority = inferSeniority(j.title);
  return {
    externalId: `${board}:${j.id}`,
    source: "greenhouse",
    title: j.title.trim(),
    company: j.company_name?.trim() || board,
    location,
    remote: remoteFromText(location),
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    technologies: detectTechnologies(j.title, description),
    description,
    url: j.absolute_url,
    ...(published && !isNaN(published.getTime()) ? { publishedAt: published } : {}),
    discoveredAt: now,
  };
}

export class GreenhouseCollector implements Collector {
  readonly name = "greenhouse";
  constructor(private boards: string[]) {}

  async collect(): Promise<CollectResult> {
    const out: Job[] = [];
    const errors: string[] = [];
    // Sequencial, uma requisição por empresa, para não sobrecarregar a API.
    for (const board of this.boards) {
      try {
        const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
        const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(url, { timeoutMs: 30_000 });
        const now = new Date();
        for (const j of data.jobs ?? []) if (j?.id && j.title && j.absolute_url) out.push(normalizeGreenhouse(j, board, now));
      } catch (e) {
        errors.push(`${board}: ${(e as Error).message}`);
      }
    }
    if (errors.length && out.length === 0) throw new Error(errors.join("; "));
    return { jobs: out, warnings: errors };
  }
}
