import { describe, expect, it, vi, afterEach } from "vitest";
import { AdzunaCollector, normalizeAdzuna } from "../src/collectors/adzuna.collector";
import { JSearchCollector, normalizeJSearch } from "../src/collectors/jsearch.collector";
import { parseRelativeTime } from "../src/services/normalize";
import { verifyJob } from "../src/services/job-verification.service";
import { evaluateJob } from "../src/services/job-filter.service";
import { NOW, profile } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("fontes brasileiras e agregadores", () => {
  it("normaliza Adzuna: Brasil, remoto por texto, ignora salário estimado", () => {
    const j = normalizeAdzuna({
      id: 1, title: "Desenvolvedor Node.js Pleno - Home Office", description: "Vaga CLT 100% remoto. Node.js, PostgreSQL e Docker.",
      created: "2026-11-23T08:00:00Z", redirect_url: "https://www.adzuna.com.br/land/ad/1", company: { display_name: "Empresa BR" },
      location: { display_name: "Santarém, Pará" }, salary_min: 60000, salary_max: 72000, salary_is_predicted: "1",
    });
    expect(j).toMatchObject({ source: "adzuna", remote: true, seniority: "mid", contractType: "CLT", location: "Santarém, Pará, Brasil" });
    expect(j.salaryMin).toBeUndefined();
    const real = normalizeAdzuna({ id: 2, title: "Dev", redirect_url: "u", salary_min: 60000, salary_max: 72000, salary_is_predicted: "0" });
    expect(real).toMatchObject({ salaryMin: 5000, salaryMax: 6000, currency: "BRL" });
  });

  it("vaga brasileira (Adzuna) passa nos filtros e não é barrada por localização", () => {
    const j = normalizeAdzuna({
      id: 3, title: "Desenvolvedor React Júnior", company: { display_name: "Empresa BR" }, description: "Remoto, CLT. React, TypeScript e APIs REST.",
      created: new Date(NOW.getTime() - 5 * 3600_000).toISOString(), redirect_url: "https://www.adzuna.com.br/land/ad/3",
      location: { display_name: "São Paulo" }, salary_min: 54000, salary_max: 60000, salary_is_predicted: "0",
    }, NOW);
    expect(evaluateJob(j, profile, NOW).accepted).toBe(true);
  });

  it("normaliza JSearch com publisher no source (LinkedIn/Indeed/Glassdoor)", () => {
    const j = normalizeJSearch({
      job_id: "abc", job_title: "Desenvolvedor Full Stack Jr", employer_name: "Acme", job_publisher: "LinkedIn",
      job_apply_link: "https://br.linkedin.com/jobs/view/1", job_is_remote: true, job_employment_type: "CONTRACTOR",
      job_posted_at_datetime_utc: "2026-11-23T09:00:00.000Z", job_city: "Recife", job_state: "PE", job_country: "BR",
      job_min_salary: 4000, job_max_salary: 6000, job_salary_currency: "BRL", job_salary_period: "MONTH", job_description: "React e Node.js",
    });
    expect(j).toMatchObject({ source: "jsearch/linkedin", remote: true, contractType: "PJ", seniority: "junior", location: "Recife, PE, Brasil", salaryMin: 4000, salaryMax: 6000 });
  });

  it("coletores enviam a chave por header/query e não vazam a chave em erros", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 403 }));
    await expect(new JSearchCollector("SECRETKEY123", ["q"]).collect()).rejects.toThrow();
    expect(JSON.stringify(f.mock.calls[0]![1]!.headers)).toContain("SECRETKEY123");
    const err = await new AdzunaCollector({ appId: "id", appKey: "SECRETKEY123" }, ["q"]).collect().catch((e: Error) => e);
    expect((err as Error).message).not.toContain("SECRETKEY123");
  });

  it("não acessa páginas do LinkedIn/Indeed/Glassdoor na verificação", async () => {
    const fetchPage = vi.fn();
    for (const host of ["https://br.linkedin.com/jobs/view/1", "https://br.indeed.com/viewjob?jk=1", "https://www.glassdoor.com.br/job/1"]) {
      const r = await verifyJob({ ...normalizeJSearch({ job_id: "x", job_title: "Dev", job_apply_link: host }), url: host }, { fetchPage });
      expect(r.status).toBe("unverified");
      expect(r.evidence.join()).toMatch(/não acessada/);
    }
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

import { JoobleCollector, normalizeJooble } from "../src/collectors/jooble.collector";

describe("Jooble", () => {
  it("normaliza vaga brasileira: remoto por texto, salário em R$, Brasil no local", () => {
    const j = normalizeJooble({
      id: 77, title: "Desenvolvedor Node.js Júnior", location: "Belém", snippet: "Vaga 100% remoto, CLT. Node.js e PostgreSQL.",
      salary: "R$ 4.500 por mês", type: "Full-time", link: "https://jooble.org/desc/77", company: "Empresa BR", updated: "2026-11-23T08:00:00.0000000",
    });
    expect(j).toMatchObject({ source: "jooble", remote: true, seniority: "junior", contractType: "CLT", currency: "BRL", salaryMin: 4500, location: "Belém, Brasil" });
    expect(j.publishedAt).toBeInstanceOf(Date);
    expect(normalizeJooble({ title: "Dev", link: "u", salary: "" }).salaryMin).toBeUndefined();
  });

  it("faz POST com a consulta, tolera falha parcial e não vaza a chave", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      const q = JSON.parse(String((init as RequestInit).body)).keywords;
      return q === "ok" ? new Response(JSON.stringify({ jobs: [{ id: 1, title: "Dev React", link: "https://jooble.org/desc/1" }, { title: "sem link" }] }), { status: 200 }) : new Response("no", { status: 403 });
    });
    const r = await new JoobleCollector("SECRETJOOBLE", ["ok", "bad"]).collect();
    expect(r.jobs).toHaveLength(1);
    expect(r.warnings.join()).not.toContain("SECRETJOOBLE");
    expect(f.mock.calls[0]![1]!.method).toBe("POST");
    await expect(new JoobleCollector("SECRETJOOBLE", ["bad"]).collect()).rejects.toThrow();
  });
});

describe("verificação x Jooble", () => {
  it("não baixa páginas do Jooble", async () => {
    const fetchPage = vi.fn();
    const r = await verifyJob({ ...normalizeJooble({ title: "Dev", link: "https://jooble.org/desc/1" }), url: "https://jooble.org/desc/1" }, { fetchPage });
    expect(r.status).toBe("unverified");
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe("JSearch v2 / datas relativas", () => {
  it("interpreta datas relativas em português e inglês", () => {
    expect(parseRelativeTime("há 2 dias", NOW)?.getTime()).toBe(NOW.getTime() - 2 * 86_400_000);
    expect(parseRelativeTime("3 hours ago", NOW)?.getTime()).toBe(NOW.getTime() - 3 * 3_600_000);
    expect(parseRelativeTime("há 1 semana", NOW)?.getTime()).toBe(NOW.getTime() - 7 * 86_400_000);
    expect(parseRelativeTime("Ontem", NOW)?.getTime()).toBe(NOW.getTime() - 86_400_000);
    expect(parseRelativeTime("data estranha", NOW)).toBeUndefined();
  });

  it("normaliza o formato real do search-v2 (Glassdoor, 'Qualquer lugar', tempo relativo)", () => {
    const j = normalizeJSearch({
      job_id: "g1", job_title: "DESENVOLVEDOR FRONT-END JÚNIOR", employer_name: "Jobbol", job_publisher: "Glassdoor",
      job_employment_type: "Tempo integral", job_employment_types: ["FULLTIME"], job_is_remote: true, job_location: "Qualquer lugar",
      job_posted_at: "há 2 dias", job_posted_at_datetime_utc: null, job_country: null, job_apply_link: "https://www.glassdoor.com.br/job-listing/x",
      job_min_salary: null, job_max_salary: null, job_description: "React",
    }, NOW);
    expect(j).toMatchObject({ source: "jsearch/glassdoor", remote: true, contractType: "Full-time", location: "Qualquer lugar, Brasil" });
    expect(j.publishedAt?.getTime()).toBe(NOW.getTime() - 2 * 86_400_000);
  });
});

describe("JSearch: híbrido e duplicadas", () => {
  it("título 'Híbrido' prevalece sobre job_is_remote", () => {
    expect(normalizeJSearch({ job_id: "h", job_title: "Desenvolvedor Java Junior - Blumenau - Híbrido", job_is_remote: true, job_apply_link: "u" }).remote).toBe(false);
  });
});
