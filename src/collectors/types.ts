import type { Job } from "../types";

export interface CollectResult {
  jobs: Job[];
  /** Falhas parciais (ex.: uma empresa fora do ar) que não impedem o restante. */
  warnings: string[];
}

export interface Collector {
  readonly name: string;
  collect(): Promise<CollectResult>;
}
