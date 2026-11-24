import { describe, expect, it, vi } from "vitest";
import { SearchService } from "../src/services/search.service";
import type { JobStore, StoredAnalysis } from "../src/database/store";
import type { Collector } from "../src/collectors/types";
import type { Job } from "../src/types";
import { makeJob, NOW, profile } from "./helpers";

function memoryStore(): JobStore & { jobs: Map<string, Job>; notifs: Map<string, string> } {
  const jobs = new Map<string, Job>(); const keys = new Map<string, string>(); const notifs = new Map<string, string>();
  const analyses = new Map<string, StoredAnalysis>();
  return {
    jobs, notifs,
    async upsertJob(job) {
      const k = `${job.source}:${job.externalId}`;
      if (keys.has(k)) return { id: keys.get(k)!, created: false };
      const id = `id${keys.size + 1}`; keys.set(k, id); jobs.set(id, job); return { id, created: true };
    },
    async getJob(id) { const job = jobs.get(id); return job ? { id, job, unverified: [] } : null; },
    async hasNotification(id) { return notifs.has(id); },
    async getAnalysis(id) { return analyses.get(id) ?? null; },
    async saveAnalysis(id, a) { analyses.set(id, a); },
    async saveNotification(id, status) { if (notifs.has(id)) return false; notifs.set(id, status); return true; },
    async setSavedStatus() {}, async getSavedStatus() { return null; },
    async startExecution() { return "exec"; }, async finishExecution() {}, async lastExecutions() { return []; },
    async counts() { return { jobs: 0, notified: 0, saved: 0 }; }, async saveProfile() {},
  };
}

const analysis = (score: number): StoredAnalysis => ({
  model: "m", error: null, verification: null, risk: null,
  match: { matchScore: score, matchingSkills: [], missingSkills: [], summary: "", recommendation: "apply" },
});

function setup(collectors: Collector[], score = 90) {
  const store = memoryStore();
  const notifier = { send: vi.fn(async () => 1) };
  const reviewer = { review: vi.fn(async () => analysis(score)) };
  const svc = new SearchService({ collectors, store, reviewer, notifier, profile, chatId: "1", maxNotifications: 10, now: () => NOW });
  return { svc, store, notifier, reviewer };
}
const ok = (jobs: Job[]): Collector => ({ name: "fake", collect: async () => ({ jobs, warnings: [] }) });

describe("deduplicação e resiliência", () => {
  it("não notifica a mesma vaga duas vezes", async () => {
    const { svc, notifier, reviewer } = setup([ok([makeJob({ externalId: "a" }), makeJob({ externalId: "b" })])]);
    const r1 = await svc.run("manual");
    expect(r1).toMatchObject({ newJobs: 2, notified: 2 });
    const r2 = await svc.run("scheduled");
    expect(r2).toMatchObject({ newJobs: 0, notified: 0 });
    expect(notifier.send).toHaveBeenCalledTimes(2);
    expect(reviewer.review).toHaveBeenCalledTimes(2); // sem nova chamada de IA
  });

  it("deduplica a mesma vaga repetida na mesma coleta", async () => {
    const { svc, notifier } = setup([ok([makeJob({ externalId: "x" }), makeJob({ externalId: "x" })])]);
    await svc.run("manual");
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("vagas com baixa compatibilidade são registradas e não reenviadas", async () => {
    const { svc, notifier, store } = setup([ok([makeJob()])], 10);
    expect(await svc.run("manual")).toMatchObject({ notified: 0, skippedLowScore: 1 });
    expect([...store.notifs.values()]).toEqual(["SKIPPED_LOW_SCORE"]);
    await svc.run("manual");
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("não notifica vagas com risco alto/suspeitas (confiabilidade)", async () => {
    const store = memoryStore();
    const notifier = { send: vi.fn(async () => 1) };
    const risky: StoredAnalysis = { ...analysis(95), risk: { riskLevel: "high", riskScore: 90, authenticityStatus: "unverified", warningSigns: ["taxa"], positiveSignals: [], missingEvidence: [], explanation: "", recommendation: "avoid" } };
    const suspicious: StoredAnalysis = { ...analysis(95), verification: { status: "suspicious", checkedUrl: "", evidence: [], warnings: [], missing: [], checkedAt: "" } };
    const answers = [risky, suspicious];
    const reviewer = { review: vi.fn(async () => answers.shift()!) };
    const svc = new SearchService({ collectors: [ok([makeJob({ externalId: "r" }), makeJob({ externalId: "s" })])], store, reviewer, notifier, profile, chatId: "1", maxNotifications: 10, now: () => NOW });
    expect(await svc.run("manual")).toMatchObject({ notified: 0, skippedRisk: 2 });
    expect([...store.notifs.values()]).toEqual(["SKIPPED_RISK", "SKIPPED_RISK"]);
  });

  it("/freelas: busca somente freelas", async () => {
    const freela = makeJob({ externalId: "f", title: "Telegram bot automation", contractType: "Freelance", technologies: [] });
    const { svc, notifier } = setup([ok([makeJob({ externalId: "j" }), freela])]);
    const r = (await svc.run("manual", ["freelance"]))!;
    expect(r).toMatchObject({ notified: 1, freelas: 1 });
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("continua operando quando uma fonte falha", async () => {
    const bad: Collector = { name: "bad", collect: async () => { throw new Error("HTTP 500"); } };
    const { svc, notifier } = setup([bad, ok([makeJob()])]);
    const r = (await svc.run("manual"))!;
    expect(r.status).toBe("PARTIAL");
    expect(r.sources.bad!.error).toMatch(/500/);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("se o envio ao Telegram falhar, a vaga é tentada de novo na próxima busca", async () => {
    const { svc, notifier } = setup([ok([makeJob()])]);
    notifier.send.mockRejectedValueOnce(new Error("telegram down"));
    expect((await svc.run("manual"))!.notified).toBe(0);
    expect((await svc.run("manual"))!.notified).toBe(1);
  });

  it("respeita o limite por execução e recusa execuções simultâneas", async () => {
    const jobs = Array.from({ length: 15 }, (_, i) => makeJob({ externalId: String(i) }));
    const { svc } = setup([ok(jobs)]);
    const [a, b] = await Promise.all([svc.run("manual"), svc.run("manual")]);
    expect(b).toBeNull();
    expect(a).toMatchObject({ notified: 10, pending: 5 });
  });

  it("filtra antes de notificar", async () => {
    const { svc, notifier } = setup([ok([makeJob({ remote: false }), makeJob({ externalId: "2", title: "Senior Engineer" })])]);
    const r = (await svc.run("manual"))!;
    expect(r).toMatchObject({ accepted: 0, rejected: 2 });
    expect(notifier.send).not.toHaveBeenCalled();
  });
});
