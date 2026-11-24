import cron, { type ScheduledTask } from "node-cron";

/** Converte minutos em expressão cron (divisores de 60 ou múltiplos de 60 até 24h). */
export function intervalToCron(minutes: number): string {
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes % 60 === 0 && minutes <= 1440 && 24 % (minutes / 60) === 0) return minutes === 1440 ? "0 0 * * *" : `0 */${minutes / 60} * * *`;
  throw new Error(`SEARCH_INTERVAL_MINUTES=${minutes} inválido: use um divisor de 60 (5,10,15,20,30) ou múltiplos de 60 (60,120,...)`);
}

export function startScheduler(minutes: number, job: () => Promise<void>): ScheduledTask {
  const task = cron.schedule(intervalToCron(minutes), async () => { await job(); }, { noOverlap: true });
  return task;
}
