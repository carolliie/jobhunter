import { fetchWithRetry, HttpError } from "../utils/http";

export interface ZenRowsOptions {
  proxyCountry?: string;
  timeoutMs?: number;
}

/** Cliente mínimo do Fetch API. A chave nunca é incluída em mensagens de erro. */
export class ZenRowsClient {
  constructor(private apiKey: string) {}

  async fetchPage(targetUrl: string, options: ZenRowsOptions = {}): Promise<string> {
    const target = new URL(targetUrl);
    if (target.protocol !== "https:") throw new Error("O ZenRows só pode acessar alvos HTTPS");

    const params = new URLSearchParams({
      apikey: this.apiKey,
      url: target.toString(),
      mode: "auto",
      original_status: "true",
    });
    if (options.proxyCountry) params.set("proxy_country", options.proxyCountry);

    const response = await fetchWithRetry(`https://api.zenrows.com/v1/?${params}`, {
      timeoutMs: options.timeoutMs ?? 180_000,
      retries: 1,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) throw new HttpError(`ZenRows respondeu HTTP ${response.status}`, response.status);
    return response.text();
  }
}
