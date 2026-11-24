import type { Job } from "../types";
import type { Profile } from "../config/profile";
import { inferSeniority, looksFreelance, titleHasAny } from "./normalize";

export type LocationEligibility = "eligible" | "incompatible" | "unknown";

export interface FilterResult {
  kind: "job" | "freelance";
  accepted: boolean;
  /** Motivos de descarte (evidências claras de incompatibilidade) */
  rejectReasons: string[];
  /** Informações que não puderam ser verificadas (não descartam a vaga) */
  unverified: string[];
  locationEligibility: LocationEligibility;
  /** Publicada dentro da janela preferencial (ex.: 24h) */
  fresh: boolean;
}

const ELIGIBLE_LOCATION =
  /brazil|brasil|latam|latin america|south america|am[eé]rica latina|worldwide|world-?wide|anywhere|global(?:ly)?|\bs[ãa]o paulo\b|rio de janeiro|belo horizonte|curitiba|porto alegre|florian[óo]polis|bras[ií]lia|recife|fortaleza/i;

const INCOMPATIBLE_LOCATION_CI =
  /united states|united kingdom|canada|europe|germany|france|spain|portugal|netherlands|poland|ireland|india|australia|new zealand|singapore|japan|israel|mexico|argentina|colombia|philippines|emea|apac|north america|\bamericas?\b(?!\s*latina)|\bnorth america\b|\bukraine\b|\bromania\b|\bturkey\b|\bsouth africa\b|\bnigeria\b|\begypt\b/i;
const INCOMPATIBLE_LOCATION_CS = /\b(US|USA|U\.S\.A?\.?|UK|EU|UAE|EST|PST|CET|GMT)\b/;

const GENERIC_LOCATION_WORDS =
  /\b(remote|remoto|remotely|work from home|wfh|home[\s-]?office|fully|100%|distributed|flexible|anywhere|n[ãa]o informado|not specified|unspecified|global)\b/gi;

const DESC_INCOMPATIBLE =
  /(must|need to|required to)\s+(be\s+)?(located|reside|live|based)\s+in\s+(the\s+)?(us|u\.s\.|usa|united states|uk|united kingdom|canada|eu|europe)|authori[sz]ed to work in (the )?(us|u\.s\.|united states|uk|canada|eu)|(us|u\.s\.)\s+work authori[sz]ation|(us|u\.s\.)\s+(citizens?|residents?)\s+only|(only|must)[^.]{0,40}(us|u\.s\.|united states)[- ]based|no (visa )?sponsorship[^.]{0,40}(outside|non)/i;

export function classifyLocation(job: Pick<Job, "location" | "description">): LocationEligibility {
  const loc = job.location ?? "";
  if (ELIGIBLE_LOCATION.test(loc)) return "eligible";
  if (INCOMPATIBLE_LOCATION_CI.test(loc) || INCOMPATIBLE_LOCATION_CS.test(loc)) return "incompatible";
  // Local específico que não menciona Brasil/mundo (ex.: "New York, NY", "Dubai"): evidência de incompatibilidade.
  const specific = loc.replace(GENERIC_LOCATION_WORDS, " ").replace(/[\s\-–—,;/|()·.:]+/g, " ").trim();
  if (specific.length > 0) return "incompatible";
  // Local genérico ("Remote", "Não informado"): procura evidência explícita na descrição
  if (DESC_INCOMPATIBLE.test(job.description ?? "")) return "incompatible";
  return "unknown";
}

function toBRL(amount: number, currency: string, rates: Record<string, number>): number | undefined {
  const rate = rates[currency.toUpperCase()];
  return rate === undefined ? undefined : amount * rate;
}

export function kindOf(job: Job, profile: Profile): "job" | "freelance" {
  if (!profile.filters.freelance.enabled) return "job";
  return looksFreelance(job.title, job.contractType, job.description) ? "freelance" : "job";
}

const hasWord = (text: string, w: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu").test(text);

/** Campos obrigatórios configurados: ausência = descarte (nunca preenchemos dados inventados). */
function requiredChecks(job: Job, profile: Profile, reject: string[]) {
  const req = new Set(profile.filters.requiredFields);
  if (req.has("company") && (!job.company.trim() || /^n[ãa]o informada$/i.test(job.company.trim()))) reject.push("sem nome da empresa");
  if (req.has("url") && !/^https?:\/\//i.test(job.url)) reject.push("sem link de acesso");
  if (req.has("salary") && job.salaryMin === undefined && job.salaryMax === undefined) reject.push("salário não divulgado (campo obrigatório)");
  if (req.has("modality") && job.remote === null) reject.push("modalidade não informada (campo obrigatório)");
  if (req.has("publishedAt") && !job.publishedAt) reject.push("data de publicação ausente (campo obrigatório)");
}

/** Regras comuns: localização e recência (poucos candidatos OU muito recente). */
function commonChecks(job: Job, profile: Profile, now: Date, reject: string[], unverified: string[]) {
  const f = profile.filters;
  const locationEligibility = classifyLocation(job);
  if (locationEligibility === "incompatible" && f.requireBrazilEligible) {
    reject.push(`localização incompatível com candidatos no Brasil (${job.location})`);
  } else if (locationEligibility === "unknown") unverified.push("elegibilidade para o Brasil");

  let fresh = false;
  if (!job.publishedAt) unverified.push("data de publicação");
  else {
    const ageH = (now.getTime() - job.publishedAt.getTime()) / 3_600_000;
    fresh = ageH <= f.preferredAgeHours;
    if (ageH > f.maxAgeHours) reject.push(`publicada há mais de ${f.maxAgeHours}h`);
    else if (job.applicants !== undefined) {
      if (job.applicants > f.maxApplicants) reject.push(`muitos candidatos (${job.applicants})`);
    } else if (ageH > f.veryRecentHours) {
      // Sem contagem de candidatos, só "muito recente" garante pouca concorrência
      reject.push(`sem nº de candidatos e publicada há mais de ${f.veryRecentHours}h`);
    }
  }
  if (job.applicants === undefined) unverified.push("nº de candidatos");
  return { locationEligibility, fresh };
}

function evaluateFreelance(job: Job, profile: Profile, now: Date): FilterResult {
  const f = profile.filters;
  const reject: string[] = [];
  const unverified: string[] = [];
  const text = `${job.title}\n${job.description.slice(0, 3000)}`;
  requiredChecks(job, profile, reject);

  const excluded = f.freelance.excludeKeywords.find((k) => hasWord(job.title, k));
  if (excluded) reject.push(`título contém "${excluded}"`);
  const relevant = f.freelance.keywords.some((k) => hasWord(text, k)) ||
    job.technologies.some((t) => f.interestTechnologies.some((i) => i.toLowerCase() === t.toLowerCase()));
  if (!relevant) reject.push("escopo sem relação com o seu currículo/stack");
  if (job.remote === false && f.freelance.requireRemote) reject.push("freela não remoto");
  else if (job.remote === null) unverified.push("modalidade remota");
  if (job.contractType?.toLowerCase() === "internship") reject.push("estágio não é freela");
  if (job.salaryMax === undefined && job.salaryMin === undefined) unverified.push("orçamento/valor");

  const c = commonChecks(job, profile, now, reject, unverified);
  return { kind: "freelance", accepted: reject.length === 0, rejectReasons: reject, unverified, ...c };
}

export function evaluateJob(job: Job, profile: Profile, now: Date = new Date()): FilterResult {
  if (kindOf(job, profile) === "freelance") return evaluateFreelance(job, profile, now);
  const f = profile.filters;
  const reject: string[] = [];
  const unverified: string[] = [];
  requiredChecks(job, profile, reject);

  // Cargo relevante
  if (!titleHasAny(job.title, f.titleKeywords)) reject.push("cargo fora da área de tecnologia desejada");
  const excluded = titleHasAny(job.title, f.excludeTitleKeywords);
  if (excluded) reject.push(`título contém "${excluded}"`);

  // Senioridade
  const seniority = job.seniority ?? inferSeniority(job.title);
  if (seniority) {
    if (!(f.seniorities as string[]).includes(seniority)) reject.push(`senioridade ${seniority} fora do perfil`);
  } else unverified.push("senioridade");

  // Modalidade
  if (job.remote === false) {
    if (f.remoteOnly) reject.push("vaga não é 100% remota");
  } else if (job.remote === null) unverified.push("modalidade remota");

  // Contratação (somente PJ/CLT; desconhecido não descarta)
  const ct = job.contractType?.toLowerCase();
  if (ct === "internship" || ct === "part-time") {
    reject.push(`contratação ${job.contractType} incompatível`);
  } else if (!ct) unverified.push("tipo de contratação");
  else if (!f.contractTypes.some((c) => c.toLowerCase() === ct)) unverified.push("contratação PJ/CLT");

  // Salário (maior que o mínimo)
  const top = job.salaryMax ?? job.salaryMin;
  if (top === undefined || !job.currency) unverified.push("salário");
  else {
    const brl = toBRL(top, job.currency, profile.currencyToBRL);
    if (brl === undefined) unverified.push("salário (moeda desconhecida)");
    else if (f.salaryStrictlyGreater ? brl <= f.minSalaryBRL : brl < f.minSalaryBRL) {
      reject.push(`salário não supera o mínimo (≈ R$ ${Math.round(brl)})`);
    }
  }

  const c = commonChecks(job, profile, now, reject, unverified);

  // Tecnologias de interesse (basta uma)
  if (f.requireTechMatch) {
    const interest = new Set(f.interestTechnologies.map((t) => t.toLowerCase()));
    if (!job.technologies.some((t) => interest.has(t.toLowerCase()))) reject.push("nenhuma tecnologia de interesse identificada");
  }

  return { kind: "job", accepted: reject.length === 0, rejectReasons: reject, unverified, ...c };
}

export function filterJobs(jobs: Job[], profile: Profile, now = new Date()) {
  const accepted: Array<{ job: Job; result: FilterResult }> = [];
  const rejected: Array<{ job: Job; result: FilterResult }> = [];
  const urls = new Set<string>();
  const byText = new Map<string, string>(); // empresa|título|local -> fonte
  for (const job of jobs) {
    // Mesma vaga repetida: mesmo link, ou mesma empresa+título+local vindos de fontes diferentes
    const textKey = `${job.company}|${job.title}|${job.location}`.toLowerCase().replace(/\s+/g, " ");
    const other = byText.get(textKey);
    if (urls.has(job.url) || (other !== undefined && other !== job.source)) continue;
    urls.add(job.url);
    if (other === undefined) byText.set(textKey, job.source);
    const result = evaluateJob(job, profile, now);
    (result.accepted ? accepted : rejected).push({ job, result });
  }
  // Mais recentes primeiro
  accepted.sort((a, b) => (b.job.publishedAt?.getTime() ?? 0) - (a.job.publishedAt?.getTime() ?? 0));
  return { accepted, rejected };
}
