import type { Job } from "../types";
import type { JobStore, StoredAnalysis } from "../database/store";
import type { JobAnalysisService } from "./job-analysis.service";
import { scanTextSigns, verifyJob, type VerificationResult } from "./job-verification.service";
import { logger } from "../utils/logger";

export interface Reviewer {
  review(jobId: string, job: Job, opts?: { force?: boolean }): Promise<StoredAnalysis>;
}

/**
 * Orquestra análise textual (IA) + verificação externa (URL) e usa o banco como cache,
 * para não repetir chamadas ao OpenRouter sem necessidade.
 */
export class JobReviewService implements Reviewer {
  constructor(
    private store: JobStore,
    private analyzer: JobAnalysisService,
    private verify: (job: Job) => Promise<VerificationResult> = verifyJob,
  ) {}

  async review(jobId: string, job: Job, opts: { force?: boolean } = {}): Promise<StoredAnalysis> {
    const cached = await this.store.getAnalysis(jobId);
    // Reaproveita se completo; refaz se houve falha anterior e a IA está disponível, ou se forçado.
    if (cached && !opts.force && !(cached.error && this.analyzer.enabled)) return cached;

    const result: StoredAnalysis = { model: this.analyzer.model, match: null, risk: null, verification: null, error: null };
    const errors: string[] = [];

    try { result.verification = await this.verify(job); }
    catch (e) { errors.push(`verificação: ${(e as Error).message}`); }

    if (this.analyzer.enabled) {
      // Sequencial: o serviço já serializa as chamadas, mas evitamos enfileirar trabalho inútil se a primeira falhar por limite.
      try { result.match = await this.analyzer.analyzeMatch(job); }
      catch (e) { errors.push(`compatibilidade: ${(e as Error).message}`); }
      try { result.risk = await this.analyzer.analyzeRisk(job); }
      catch (e) { errors.push(`risco: ${(e as Error).message}`); }
    } else errors.push("IA desativada (sem OPENROUTER_API_KEY)");

    result.error = errors.length ? errors.join("; ") : null;
    if (result.error) logger.warn(`Análise parcial da vaga ${job.source}/${job.externalId}: ${result.error}`);
    await this.store.saveAnalysis(jobId, result);
    return result;
  }
}

export { scanTextSigns };
