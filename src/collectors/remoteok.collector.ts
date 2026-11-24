import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";
import { fetchJson } from "../utils/http";
import { htmlToText } from "../utils/text";
import { detectTechnologies, inferContractType, inferSeniority, toMonthly } from "../services/normalize";

interface RemoteOkJob {
  id?: string | number;
  epoch?: number | string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  url?: string;
  apply_url?: string;
  salary_min?: number | string;
  salary_max?: number | string;
}

export function normalizeRemoteOk(j: RemoteOkJob, now = new Date()): Job {
  const description = htmlToText(j.description ?? "");
  const title = (j.position ?? "").trim();
  const tags = (j.tags ?? []).join(" ");
  const min = Number(j.salary_min) || 0;
  const max = Number(j.salary_max) || 0;
  const epoch = Number(j.epoch);
  const seniority = inferSeniority(title);
  const contract = /freelance/i.test(tags) ? "Freelance" : /contract/i.test(tags) ? "PJ" : inferContractType(description);
  return {
    externalId: String(j.id),
    source: "remoteok",
    title,
    company: (j.company ?? "").trim() || "Não informada",
    location: (j.location ?? "").trim() || "Não informado",
    remote: true, // RemoteOK lista apenas vagas remotas
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    // salary_* é anual em USD; 0 = não divulgado
    ...(min > 0 ? { salaryMin: toMonthly(min, "USD", "year") } : {}),
    ...(max > 0 ? { salaryMax: toMonthly(max, "USD", "year") } : {}),
    ...(min > 0 || max > 0 ? { currency: "USD" } : {}),
    technologies: detectTechnologies(title, tags, description),
    description,
    // Termos da API: o link deve apontar para a página no RemoteOK.
    url: j.url ?? j.apply_url ?? "",
    ...(Number.isFinite(epoch) && epoch > 0 ? { publishedAt: new Date(epoch * 1000) } : {}),
    discoveredAt: now,
  };
}

export class RemoteOkCollector implements Collector {
  readonly name = "remoteok";
  async collect(): Promise<CollectResult> {
    const data = await fetchJson<RemoteOkJob[]>("https://remoteok.com/api");
    const now = new Date();
    // O primeiro item é um aviso legal, sem id/position.
    const jobs = (Array.isArray(data) ? data : []).filter((j) => j?.id && j.position && j.url).map((j) => normalizeRemoteOk(j, now));
    return { jobs, warnings: [] };
  }
}
