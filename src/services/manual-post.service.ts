import { createHash } from "node:crypto";
import type { Job } from "../types";
import type { JobAnalysisService } from "./job-analysis.service";
import { detectTechnologies, inferContractType, inferSeniority, looksFreelance, parseSalaryText, remoteFromText } from "./normalize";
import { truncate } from "../utils/text";

const URL_RE = /https?:\/\/[^\s<>()"']+/gi;

export class NotAJobPostError extends Error {}

/**
 * Transforma um post colado pelo usuário (LinkedIn, grupos, WhatsApp...) em Job.
 * O LinkedIn não oferece API para ler posts do feed e proíbe coleta automatizada; por isso o usuário
 * cola/encaminha o post e o bot analisa. Nada é inventado: o que não estiver no texto fica vazio.
 */
export async function postToJob(
  text: string,
  entityUrls: string[],
  analyzer: Pick<JobAnalysisService, "enabled" | "extractPost">,
  now = new Date(),
): Promise<Job> {
  const body = text.trim();
  const urls = [...new Set([...(body.match(URL_RE) ?? []).map((u) => u.replace(/[.,;!?]+$/, "")), ...entityUrls])];
  let ext: Awaited<ReturnType<typeof analyzer.extractPost>> | undefined;
  if (analyzer.enabled) {
    try { ext = await analyzer.extractPost(body); } catch { /* cai na extração por regras */ }
  }
  if (ext && !ext.isJobPost) throw new NotAJobPostError("O texto não parece ser um anúncio de vaga.");

  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l.length > 3) ?? "Vaga (post)";
  const title = truncate((ext?.title || firstLine).replace(URL_RE, "").trim() || "Vaga (post)", 120);
  // Só aceita link que realmente esteja no texto/entidades do post (nunca um link gerado pela IA)
  const aiUrl = ext?.applyUrl && urls.includes(ext.applyUrl) ? ext.applyUrl : undefined;
  const url = aiUrl ?? urls.find((u) => !/linkedin\.com\/(feed|in\/|company\/)/i.test(u)) ?? urls[0] ?? "";
  const salary = parseSalaryText(ext?.salaryText || body);
  const contract = ext?.contractType || inferContractType(body);
  const seniority = inferSeniority(title);
  const remote = ext?.remote ?? remoteFromText(body);
  const kind = looksFreelance(title, contract, body) ? "freelance" : "job";
  const techs = [...new Set([...(ext?.technologies ?? []), ...detectTechnologies(title, body)])];
  return {
    externalId: createHash("sha1").update(body.toLowerCase().replace(/\s+/g, " ").slice(0, 2000)).digest("hex").slice(0, 24),
    source: "post-linkedin",
    title,
    company: ext?.company || "Não informada",
    location: ext?.location || "Não informado",
    remote,
    ...(contract ? { contractType: contract } : {}),
    ...(seniority ? { seniority } : {}),
    ...(salary.min !== undefined ? { salaryMin: salary.min } : {}),
    ...(salary.max !== undefined ? { salaryMax: salary.max } : {}),
    ...(salary.currency ? { currency: salary.currency } : {}),
    technologies: techs,
    description: body,
    url,
    kind,
    discoveredAt: now, // a data do post não é conhecida: a publicação fica "não informada"
  };
}
