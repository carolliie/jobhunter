import { Prisma, type PrismaClient } from "@prisma/client";
import type { Job } from "../types";
import type { MatchAnalysis, RiskAnalysis } from "../services/job-analysis.service";
import type { VerificationResult } from "../services/job-verification.service";
import type { Profile } from "../config/profile";

export interface StoredAnalysis {
  model: string;
  match: MatchAnalysis | null;
  risk: RiskAnalysis | null;
  verification: VerificationResult | null;
  error: string | null;
}

export interface JobRecord { id: string; job: Job; unverified: string[] }

export interface ExecutionSummary {
  id: string;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  collected: number;
  accepted: number;
  rejected: number;
  newJobs: number;
  notified: number;
  errors: string[];
}

export interface JobStore {
  upsertJob(job: Job, unverified: string[]): Promise<{ id: string; created: boolean }>;
  getJob(id: string): Promise<JobRecord | null>;
  hasNotification(jobId: string): Promise<boolean>;
  getAnalysis(jobId: string): Promise<StoredAnalysis | null>;
  saveAnalysis(jobId: string, a: StoredAnalysis): Promise<void>;
  /** Retorna false se já existia notificação para a vaga (deduplicação). */
  saveNotification(jobId: string, status: "SENT" | "SKIPPED_LOW_SCORE" | "SKIPPED_RISK", chatId?: string, messageId?: number): Promise<boolean>;
  setSavedStatus(jobId: string, status: "SAVED" | "DISCARDED"): Promise<void>;
  getSavedStatus(jobId: string): Promise<"SAVED" | "DISCARDED" | null>;
  startExecution(trigger: string): Promise<string>;
  finishExecution(id: string, data: Omit<ExecutionSummary, "id" | "trigger" | "startedAt" | "finishedAt"> & { sources: unknown }): Promise<void>;
  lastExecutions(n: number): Promise<ExecutionSummary[]>;
  counts(): Promise<{ jobs: number; notified: number; saved: number }>;
  saveProfile(profile: Profile): Promise<void>;
}

type DbJob = Prisma.JobGetPayload<object>;

function toJob(r: DbJob): Job {
  return {
    externalId: r.externalId, source: r.source, title: r.title, company: r.company, location: r.location,
    remote: r.remote,
    ...(r.contractType ? { contractType: r.contractType } : {}),
    ...(r.seniority ? { seniority: r.seniority } : {}),
    ...(r.salaryMin !== null ? { salaryMin: r.salaryMin } : {}),
    ...(r.salaryMax !== null ? { salaryMax: r.salaryMax } : {}),
    ...(r.currency ? { currency: r.currency } : {}),
    technologies: r.technologies, description: r.description, url: r.url,
    ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    discoveredAt: r.discoveredAt,
    kind: r.kind === "freelance" ? "freelance" : "job",
    ...(r.applicants !== null ? { applicants: r.applicants } : {}),
  };
}

const json = (v: unknown) => (v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue));

export class PrismaJobStore implements JobStore {
  constructor(private db: PrismaClient) {}

  async upsertJob(job: Job, unverified: string[]) {
    const data = {
      title: job.title, company: job.company, location: job.location, remote: job.remote,
      contractType: job.contractType ?? null, seniority: job.seniority ?? null,
      salaryMin: job.salaryMin ?? null, salaryMax: job.salaryMax ?? null, currency: job.currency ?? null,
      technologies: job.technologies, description: job.description, url: job.url,
      publishedAt: job.publishedAt ?? null, unverified,
      kind: job.kind ?? "job", applicants: job.applicants ?? null,
    };
    const existing = await this.db.job.findUnique({
      where: { source_externalId: { source: job.source, externalId: job.externalId } }, select: { id: true },
    });
    if (existing) {
      await this.db.job.update({ where: { id: existing.id }, data });
      return { id: existing.id, created: false };
    }
    try {
      const c = await this.db.job.create({ data: { source: job.source, externalId: job.externalId, discoveredAt: job.discoveredAt, ...data } });
      return { id: c.id, created: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await this.db.job.findUniqueOrThrow({ where: { source_externalId: { source: job.source, externalId: job.externalId } } });
        return { id: row.id, created: false };
      }
      throw e;
    }
  }

  async getJob(id: string) {
    const r = await this.db.job.findUnique({ where: { id } });
    return r ? { id: r.id, job: toJob(r), unverified: r.unverified } : null;
  }

  async hasNotification(jobId: string) {
    return (await this.db.notification.count({ where: { jobId } })) > 0;
  }

  async getAnalysis(jobId: string) {
    const r = await this.db.jobAnalysis.findUnique({ where: { jobId } });
    if (!r) return null;
    return {
      model: r.model, match: r.match as MatchAnalysis | null, risk: r.risk as RiskAnalysis | null,
      verification: r.verification as VerificationResult | null, error: r.error,
    };
  }

  async saveAnalysis(jobId: string, a: StoredAnalysis) {
    const data = { model: a.model, match: json(a.match), risk: json(a.risk), verification: json(a.verification), error: a.error };
    await this.db.jobAnalysis.upsert({ where: { jobId }, create: { jobId, ...data }, update: data });
  }

  async saveNotification(jobId: string, status: "SENT" | "SKIPPED_LOW_SCORE" | "SKIPPED_RISK", chatId?: string, messageId?: number) {
    try {
      await this.db.notification.create({ data: { jobId, status, chatId: chatId ?? null, messageId: messageId ?? null } });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
      throw e;
    }
  }

  async setSavedStatus(jobId: string, status: "SAVED" | "DISCARDED") {
    await this.db.savedJob.upsert({ where: { jobId }, create: { jobId, status }, update: { status } });
  }

  async getSavedStatus(jobId: string) {
    const r = await this.db.savedJob.findUnique({ where: { jobId } });
    return (r?.status as "SAVED" | "DISCARDED" | undefined) ?? null;
  }

  async startExecution(trigger: string) {
    return (await this.db.searchExecution.create({ data: { trigger, status: "RUNNING" } })).id;
  }

  async finishExecution(id: string, d: Parameters<JobStore["finishExecution"]>[1]) {
    await this.db.searchExecution.update({
      where: { id },
      data: {
        finishedAt: new Date(), status: d.status, collected: d.collected, accepted: d.accepted, rejected: d.rejected,
        newJobs: d.newJobs, notified: d.notified, errors: d.errors, sources: json(d.sources),
      },
    });
  }

  async lastExecutions(n: number) {
    return this.db.searchExecution.findMany({ orderBy: { startedAt: "desc" }, take: n });
  }

  async counts() {
    const [jobs, notified, saved] = await Promise.all([
      this.db.job.count(),
      this.db.notification.count({ where: { status: "SENT" } }),
      this.db.savedJob.count({ where: { status: "SAVED" } }),
    ]);
    return { jobs, notified, saved };
  }

  async saveProfile(profile: Profile) {
    const config = profile as unknown as Prisma.InputJsonValue;
    await this.db.searchProfile.upsert({ where: { name: profile.name }, create: { name: profile.name, config }, update: { config } });
  }
}
