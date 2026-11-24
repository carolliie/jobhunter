import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const profileSchema = z.object({
  name: z.string().default("default"),
  candidate: z.object({ summary: z.string(), skills: z.array(z.string()) }),
  filters: z.object({
    remoteOnly: z.boolean(),
    requireBrazilEligible: z.boolean(),
    contractTypes: z.array(z.string()),
    minSalaryBRL: z.number().nonnegative(),
    /** true = salário precisa ser MAIOR que o mínimo (e não apenas igual) */
    salaryStrictlyGreater: z.boolean().default(false),
    seniorities: z.array(z.enum(["junior", "mid", "senior"])),
    preferredAgeHours: z.number().positive(),
    /** Campos que a vaga PRECISA ter (senão é descartada). Os demais aparecem sempre na mensagem como "não informado". */
    requiredFields: z.array(z.enum(["company", "url", "salary", "modality", "publishedAt"])).default(["company", "url"]),
    /** Teto absoluto de idade da vaga */
    maxAgeHours: z.number().positive(),
    /** "Muito recente": sem nº de candidatos informado, a vaga precisa ser mais nova que isto */
    veryRecentHours: z.number().positive().default(48),
    /** Se a fonte informar candidatos, aceita até este número */
    maxApplicants: z.number().int().positive().default(30),
    freelance: z.object({
      enabled: z.boolean(),
      keywords: z.array(z.string()),
      excludeKeywords: z.array(z.string()),
      requireRemote: z.boolean().default(true),
    }),
    requireTechMatch: z.boolean(),
    minMatchScore: z.number().min(0).max(100),
    titleKeywords: z.array(z.string()),
    excludeTitleKeywords: z.array(z.string()),
    interestTechnologies: z.array(z.string()),
  }),
  currencyToBRL: z.record(z.string(), z.number().positive()),
  sources: z.object({
    remotive: z.object({ enabled: z.boolean(), category: z.string().optional(), refreshMinutes: z.number().default(360) }),
    remoteok: z.object({ enabled: z.boolean(), refreshMinutes: z.number().default(120) }).default({ enabled: true, refreshMinutes: 120 }),
    jobicy: z.object({ enabled: z.boolean(), refreshMinutes: z.number().default(120) }).default({ enabled: true, refreshMinutes: 120 }),
    himalayas: z.object({ enabled: z.boolean(), refreshMinutes: z.number().default(60) }).default({ enabled: true, refreshMinutes: 60 }),
    adzuna: z.object({ enabled: z.boolean(), refreshMinutes: z.number().default(120), maxDaysOld: z.number().default(7), queries: z.array(z.string()) })
      .default({ enabled: true, refreshMinutes: 120, maxDaysOld: 7, queries: ["desenvolvedor junior remoto"] }),
    jooble: z.object({ enabled: z.boolean(), refreshMinutes: z.number().default(120), location: z.string().default("Brasil"), queries: z.array(z.string()) })
      .default({ enabled: true, refreshMinutes: 120, location: "Brasil", queries: ["desenvolvedor junior remoto"] }),
    jsearch: z.object({ enabled: z.boolean(), refreshMinutes: z.number().default(720), datePosted: z.string().default("3days"), queries: z.array(z.string()) })
      .default({ enabled: true, refreshMinutes: 720, datePosted: "3days", queries: ["desenvolvedor junior remoto"] }),
    zenrowsLinkedin: z.object({
      enabled: z.boolean(),
      refreshMinutes: z.number().int().positive().default(360),
      location: z.string().default("Brasil"),
      maxDaysOld: z.number().int().min(1).max(30).default(7),
      maxResultsPerQuery: z.number().int().min(1).max(25).default(10),
      maxDetailsPerQuery: z.number().int().min(0).max(25).default(6),
      queries: z.array(z.string()).min(1),
    }).default({
      enabled: true, refreshMinutes: 360, location: "Brasil", maxDaysOld: 7,
      maxResultsPerQuery: 10, maxDetailsPerQuery: 6, queries: ["desenvolvedor junior remoto"],
    }),
    greenhouse: z.object({ enabled: z.boolean(), companies: z.array(z.string()), refreshMinutes: z.number().default(30) }),
    lever: z.object({
      enabled: z.boolean(),
      refreshMinutes: z.number().default(30),
      companies: z.array(z.object({ name: z.string(), region: z.enum(["global", "eu"]).optional() })),
    }),
  }),
});

export type Profile = z.infer<typeof profileSchema>;

export function loadProfile(file: string): Profile {
  const abs = path.resolve(process.cwd(), file);
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  return profileSchema.parse(raw);
}
