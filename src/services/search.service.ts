import type { Collector } from "../collectors/types";
import type { Job } from "../types";
import type { JobStore } from "../database/store";
import type { Profile } from "../config/profile";
import type { Notifier } from "./notification.service";
import type { Reviewer } from "./job-review.service";
import { filterJobs } from "./job-filter.service";
import { isUntrustworthy } from "./job-analysis.service";
import { scanTextSigns } from "./job-verification.service";
import { logger } from "../utils/logger";

export type Trigger = "manual" | "scheduled" | "startup";

export interface SourceStat { collected: number; error?: string; warnings?: string[] }

export interface SearchSummary {
  executionId: string;
  status: "OK" | "PARTIAL" | "FAILED";
  collected: number;
  accepted: number;
  rejected: number;
  newJobs: number;
  notified: number;
  skippedLowScore: number;
  skippedRisk: number;
  freelas: number;
  pending: number;
  sources: Record<string, SourceStat>;
  errors: string[];
}

export interface SearchDeps {
  collectors: Collector[];
  store: JobStore;
  reviewer: Reviewer;
  notifier: Notifier;
  profile: Profile;
  chatId: string;
  maxNotifications: number;
  now?: () => Date;
}

export class SearchService {
  private running = false;
  constructor(private d: SearchDeps) {}

  get isRunning() { return this.running; }

  /** Executa uma busca completa. Execuções simultâneas são recusadas (evita duplicação e gasto de IA). */
  async run(trigger: Trigger, kinds: Array<"job" | "freelance"> = ["job", "freelance"]): Promise<SearchSummary | null> {
    if (this.running) return null;
    this.running = true;
    const { store, profile } = this.d;
    const executionId = await store.startExecution(trigger);
    const sources: Record<string, SourceStat> = {};
    const errors: string[] = [];
    const s: SearchSummary = {
      executionId, status: "OK", collected: 0, accepted: 0, rejected: 0, newJobs: 0, notified: 0,
      skippedLowScore: 0, skippedRisk: 0, freelas: 0, pending: 0, sources, errors,
    };
    try {
      // 1) Coleta: falha de uma fonte não derruba as demais
      const results = await Promise.allSettled(this.d.collectors.map((c) => c.collect()));
      const all: Job[] = [];
      results.forEach((r, i) => {
        const name = this.d.collectors[i]!.name;
        if (r.status === "fulfilled") {
          sources[name] = { collected: r.value.jobs.length, ...(r.value.warnings.length ? { warnings: r.value.warnings } : {}) };
          r.value.warnings.forEach((w) => errors.push(`${name}: ${w}`));
          all.push(...r.value.jobs);
        } else {
          const msg = (r.reason as Error)?.message ?? String(r.reason);
          sources[name] = { collected: 0, error: msg };
          errors.push(`${name}: ${msg}`);
          logger.error(`Coletor ${name} falhou: ${msg}`);
        }
      });
      s.collected = all.length;
      if (this.d.collectors.length && Object.values(sources).every((x) => x.error)) s.status = "FAILED";
      else if (errors.length) s.status = "PARTIAL";

      // 2) Filtro
      const filtered = filterJobs(all, profile, this.d.now?.());
      const accepted = filtered.accepted.filter((x) => kinds.includes(x.result.kind));
      const rejected = filtered.rejected.filter((x) => kinds.includes(x.result.kind));
      s.accepted = accepted.length;
      s.rejected = rejected.length;

      // 3) Persistência + deduplicação
      const recs: Array<{ id: string; job: Job; unverified: string[] }> = [];
      for (const { job, result } of accepted) {
        job.kind = result.kind;
        const { id, created } = await store.upsertJob(job, result.unverified);
        if (created) s.newJobs++;
        if (recs.some((r) => r.id === id) || (await store.hasNotification(id))) continue;
        recs.push({ id, job, unverified: result.unverified });
      }

      // 4) Análise + notificação (limitada por execução)
      const batch = recs.slice(0, this.d.maxNotifications);
      s.pending = recs.length - batch.length;
      for (const rec of batch) {
        try {
          const analysis = await this.d.reviewer.review(rec.id, rec.job);
          const score = analysis.match?.matchScore;
          if (score !== undefined && score < profile.filters.minMatchScore) {
            await store.saveNotification(rec.id, "SKIPPED_LOW_SCORE");
            s.skippedLowScore++;
            continue;
          }
          const distrust = isUntrustworthy({
            job: rec.job, risk: analysis.risk, verificationStatus: analysis.verification?.status, heuristicSigns: scanTextSigns(rec.job),
          });
          if (distrust) {
            await store.saveNotification(rec.id, "SKIPPED_RISK");
            s.skippedRisk++;
            logger.info(`Vaga descartada por confiabilidade (${distrust}): ${rec.job.company} – ${rec.job.title}`);
            continue;
          }
          const messageId = await this.d.notifier.send(rec.id, rec.job, analysis, rec.unverified);
          await store.saveNotification(rec.id, "SENT", this.d.chatId, messageId);
          s.notified++;
          if (rec.job.kind === "freelance") s.freelas++;
        } catch (e) {
          // Sem notificação gravada: a vaga será tentada de novo na próxima execução.
          const msg = `notificação ${rec.job.company} – ${rec.job.title}: ${(e as Error).message}`;
          errors.push(msg);
          logger.error(msg);
          if (s.status === "OK") s.status = "PARTIAL";
        }
      }
    } catch (e) {
      s.status = "FAILED";
      errors.push((e as Error).message);
      logger.error("Busca falhou:", e);
    } finally {
      this.running = false;
      await store.finishExecution(executionId, {
        status: s.status, collected: s.collected, accepted: s.accepted, rejected: s.rejected,
        newJobs: s.newJobs, notified: s.notified, errors, sources,
      }).catch((e) => logger.error("Falha ao registrar execução:", e));
    }
    return s;
  }
}

export function summaryText(s: SearchSummary): string {
  const src = Object.entries(s.sources).map(([n, v]) => `${n}: ${v.error ? "❌ erro" : `${v.collected}`}`).join(" | ");
  return [
    `Busca concluída (${s.status}).`,
    `Coletadas: ${s.collected} • Aprovadas nos filtros: ${s.accepted} • Novas: ${s.newJobs}`,
    `Notificadas: ${s.notified}${s.freelas ? ` (freelas: ${s.freelas})` : ""}${s.skippedLowScore ? ` • Baixa compatibilidade: ${s.skippedLowScore}` : ""}${s.skippedRisk ? ` • Descartadas por confiança: ${s.skippedRisk}` : ""}${s.pending ? ` • Aguardando próxima execução: ${s.pending}` : ""}`,
    `Fontes → ${src}`,
    ...(s.errors.length ? [`Avisos: ${s.errors.slice(0, 3).join("; ")}`.slice(0, 500)] : []),
  ].join("\n");
}
