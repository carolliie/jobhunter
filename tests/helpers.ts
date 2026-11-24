import type { Job } from "../src/types";
import { profileSchema, type Profile } from "../src/config/profile";
import { readFileSync } from "node:fs";

/** Configuração real (campos obrigatórios completos). */
export const realProfile: Profile = profileSchema.parse(JSON.parse(readFileSync("config/profile.json", "utf8")));
/** Base dos testes unitários: só empresa e link obrigatórios, para isolar cada regra. */
export const profile: Profile = { ...realProfile, filters: { ...realProfile.filters, requiredFields: ["company", "url"] } };
export const NOW = new Date("2026-11-23T12:00:00Z");

export function makeJob(over: Partial<Job> = {}): Job {
  return {
    externalId: "1", source: "remotive", title: "Software Engineer Jr.", company: "Exemplo Tech",
    location: "Worldwide", remote: true, contractType: "PJ", seniority: "junior",
    technologies: ["React", "Node.js", "PostgreSQL"], description: "Build SaaS apps with React and Node.js.",
    url: `https://exemplo.com/jobs/${over.externalId ?? "1"}`, publishedAt: new Date(NOW.getTime() - 3 * 3600_000), discoveredAt: NOW, ...over,
  };
}
