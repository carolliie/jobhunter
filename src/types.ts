export interface Job {
  externalId: string;
  source: string;
  title: string;
  company: string;
  location: string;
  remote: boolean | null;
  contractType?: string;
  seniority?: string;
  /** Valores MENSAIS na moeda `currency` (a normalização converte anual/hora). */
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  technologies: string[];
  description: string;
  url: string;
  publishedAt?: Date;
  discoveredAt: Date;
  /** Extensões além do modelo base: tipo de oportunidade e nº de candidatos (quando a fonte informa). */
  kind?: "job" | "freelance";
  applicants?: number;
}
