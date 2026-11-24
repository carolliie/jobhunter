import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLinkedInDetail, parseLinkedInSearch, normalizeLinkedIn, ZenRowsLinkedInCollector } from "../src/collectors/zenrows-linkedin.collector";
import { ZenRowsClient } from "../src/services/zenrows.service";
import { NOW } from "./helpers";

const SEARCH_HTML = `
<ul class="jobs-search__results-list">
  <li>
    <div class="base-card base-search-card" data-entity-urn="urn:li:jobPosting:40999123">
      <a class="base-card__full-link" href="https://br.linkedin.com/jobs/view/dev-react-40999123?position=1"></a>
      <h3 class="base-search-card__title">Desenvolvedor React Júnior</h3>
      <h4 class="base-search-card__subtitle"><a>Acme &amp; Co</a></h4>
      <span class="job-search-card__location">Brasil</span>
      <time class="job-search-card__listdate" datetime="2026-11-23"></time>
    </div>
  </li>
</ul>`;

const DETAIL_HTML = `
<main>
  <div class="show-more-less-html__markup relative overflow-hidden">
    <p>Vaga CLT para construir aplicações com React, TypeScript e Node.js.</p>
    <ul><li>PostgreSQL</li><li>APIs REST</li></ul>
  </div>
  <section class="description__job-criteria-list">Tempo integral</section>
  <span>12 candidatos</span>
</main>`;

afterEach(() => vi.restoreAllMocks());

describe("ZenRows + LinkedIn", () => {
  it("extrai e normaliza cards e detalhes públicos do LinkedIn", () => {
    const cards = parseLinkedInSearch(SEARCH_HTML);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "40999123", title: "Desenvolvedor React Júnior", company: "Acme & Co",
      location: "Brasil", url: "https://www.linkedin.com/jobs/view/40999123",
    });
    const detail = parseLinkedInDetail(DETAIL_HTML);
    expect(detail.description).toContain("React, TypeScript e Node.js");
    expect(detail.applicants).toBe(12);
    expect(normalizeLinkedIn(cards[0]!, detail, NOW)).toMatchObject({
      source: "zenrows/linkedin", remote: true, seniority: "junior", contractType: "CLT", applicants: 12,
    });
  });

  it("chama apenas a API ZenRows com modo automático e proxy BR", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(SEARCH_HTML, { status: 200 }));
    const client = new ZenRowsClient("SECRET_ZENROWS");
    await client.fetchPage("https://www.linkedin.com/jobs/search/?keywords=react", { proxyCountry: "br" });
    const called = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(called.origin).toBe("https://api.zenrows.com");
    expect(called.searchParams.get("apikey")).toBe("SECRET_ZENROWS");
    expect(called.searchParams.get("mode")).toBe("auto");
    expect(called.searchParams.get("proxy_country")).toBe("br");
    expect(called.searchParams.get("url")).toContain("linkedin.com/jobs/search/");
  });

  it("limita detalhes por consulta e preserva resultados se o detalhe falhar", async () => {
    const client = { fetchPage: vi.fn()
      .mockResolvedValueOnce(SEARCH_HTML)
      .mockRejectedValueOnce(new Error("detalhe indisponível")) } as unknown as ZenRowsClient;
    const result = await new ZenRowsLinkedInCollector(client, {
      queries: ["react junior"], maxResultsPerQuery: 10, maxDetailsPerQuery: 1,
    }).collect();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.description).toContain("Desenvolvedor React Júnior");
    expect(result.warnings.join()).toContain("detalhe 40999123");
    expect((client.fetchPage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it("não inclui a chave do ZenRows nos erros", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 401 }));
    const error = await new ZenRowsClient("NEVER_LEAK_THIS").fetchPage("https://www.linkedin.com/jobs/search/").catch((e: Error) => e);
    expect(error.message).not.toContain("NEVER_LEAK_THIS");
  });
});
