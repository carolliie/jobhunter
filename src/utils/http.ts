export class HttpError extends Error {
  constructor(message: string, public status?: number, public retryAfterMs?: number) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = Number(h);
  return Number.isFinite(n) ? n * 1000 : undefined;
}

/** fetch com timeout, tentativas controladas (429/5xx/rede) e backoff exponencial. */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 20_000, retries = 2 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        headers: { "user-agent": "JobHunterBot/1.0 (personal use)", ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new HttpError(`HTTP ${res.status}`, res.status, retryAfter(res));
      }
      return res;
    } catch (e) {
      lastErr = e;
      const retriable = !(e instanceof HttpError) || e.status === 429 || (e.status ?? 0) >= 500;
      if (!retriable || attempt === retries) break;
      const wait = (e instanceof HttpError && e.retryAfterMs) || 1000 * 2 ** attempt;
      await sleep(Math.min(wait, 30_000));
    }
  }
  if (lastErr instanceof HttpError) throw lastErr;
  throw new HttpError(`Falha de rede: ${(lastErr as Error)?.message ?? lastErr}`);
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, { ...opts, headers: { accept: "application/json", ...opts.headers } });
  if (!res.ok) throw new HttpError(`HTTP ${res.status} em ${new URL(url).host}`, res.status);
  return (await res.json()) as T;
}
