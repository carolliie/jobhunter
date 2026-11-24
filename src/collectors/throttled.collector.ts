import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Job } from "../types";
import type { Collector, CollectResult } from "./types";

/**
 * Respeita os limites de cada API pública: dentro do intervalo mínimo devolve o resultado em cache
 * (gravado em disco, para sobreviver a reinícios) em vez de chamar a API de novo.
 * A deduplicação no banco garante que vagas repetidas não geram novas notificações.
 */
export class ThrottledCollector implements Collector {
  constructor(private inner: Collector, private minIntervalMs: number, private dir = ".cache") {}
  get name() { return this.inner.name; }

  private file() { return path.resolve(process.cwd(), this.dir, `${this.inner.name}.json`); }

  private read(): { fetchedAt: number; jobs: Job[]; warnings: string[] } | null {
    try {
      const raw = JSON.parse(readFileSync(this.file(), "utf8"));
      const jobs = (raw.jobs as Array<Record<string, unknown>>).map((j) => ({
        ...j,
        discoveredAt: new Date(j.discoveredAt as string),
        ...(j.publishedAt ? { publishedAt: new Date(j.publishedAt as string) } : {}),
      })) as unknown as Job[];
      return { fetchedAt: raw.fetchedAt, jobs, warnings: raw.warnings ?? [] };
    } catch { return null; }
  }

  async collect(): Promise<CollectResult> {
    const cached = this.read();
    if (cached && Date.now() - cached.fetchedAt < this.minIntervalMs) return { jobs: cached.jobs, warnings: cached.warnings };
    const res = await this.inner.collect();
    try {
      mkdirSync(path.dirname(this.file()), { recursive: true });
      writeFileSync(this.file(), JSON.stringify({ fetchedAt: Date.now(), jobs: res.jobs, warnings: res.warnings }));
    } catch { /* cache é opcional */ }
    return res;
  }
}
