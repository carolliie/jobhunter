import { describe, expect, it } from "vitest";
import { classifyLocation, evaluateJob, filterJobs } from "../src/services/job-filter.service";
import { makeJob, NOW, profile } from "./helpers";

describe("filtros de vagas", () => {
  it("aceita uma vaga compatível", () => {
    const r = evaluateJob(makeJob({ salaryMin: 5000, salaryMax: 6000, currency: "BRL" }), profile, NOW);
    expect(r.accepted).toBe(true);
    expect(r.fresh).toBe(true);
  });

  it("não descarta vaga sem salário/contrato/data: marca como não verificado", () => {
    const { contractType, publishedAt, ...rest } = makeJob();
    const r = evaluateJob(rest as any, profile, NOW);
    expect(r.accepted).toBe(true);
    expect(r.unverified).toEqual(expect.arrayContaining(["salário", "tipo de contratação", "data de publicação"]));
  });

  it("descarta vaga presencial, sênior, salário baixo e antiga", () => {
    expect(evaluateJob(makeJob({ remote: false }), profile, NOW).accepted).toBe(false);
    expect(evaluateJob(makeJob({ title: "Senior Software Engineer", seniority: "senior" }), profile, NOW).accepted).toBe(false);
    expect(evaluateJob(makeJob({ salaryMax: 400, currency: "USD" }), profile, NOW).rejectReasons.join()).toMatch(/salário não supera/);
    expect(evaluateJob(makeJob({ publishedAt: new Date(NOW.getTime() - 10 * 24 * 3600_000) }), profile, NOW).accepted).toBe(false);
  });

  it("converte moeda para BRL ao comparar salário", () => {
    expect(evaluateJob(makeJob({ salaryMax: 1000, currency: "USD" }), profile, NOW).accepted).toBe(true); // ≈ R$ 5.500
  });

  it("descarta cargos fora de tecnologia e vagas sem tecnologia de interesse", () => {
    expect(evaluateJob(makeJob({ title: "Account Executive" }), profile, NOW).accepted).toBe(false);
    expect(evaluateJob(makeJob({ technologies: ["Python"] }), profile, NOW).accepted).toBe(false);
  });

  it("descarta contratos incompatíveis (estágio/part-time)", () => {
    expect(evaluateJob(makeJob({ contractType: "Part-time" }), profile, NOW).accepted).toBe(false);
  });

  it("exige salário MAIOR que R$ 3.000 (igual é descartado)", () => {
    expect(evaluateJob(makeJob({ salaryMax: 3000, currency: "BRL" }), profile, NOW).accepted).toBe(false);
    expect(evaluateJob(makeJob({ salaryMax: 3001, currency: "BRL" }), profile, NOW).accepted).toBe(true);
  });

  it("poucos candidatos OU muito recente", () => {
    const old = new Date(NOW.getTime() - 150 * 3600_000);
    // antiga e sem contagem de candidatos: descartada
    expect(evaluateJob(makeJob({ publishedAt: old }), profile, NOW).accepted).toBe(false);
    // antiga, mas com poucos candidatos: aceita
    expect(evaluateJob(makeJob({ publishedAt: old, applicants: 5 }), profile, NOW).accepted).toBe(true);
    // muitos candidatos: descartada mesmo se recente
    expect(evaluateJob(makeJob({ applicants: 500 }), profile, NOW).accepted).toBe(false);
    // recente sem contagem: aceita e avisa que o nº de candidatos não foi verificado
    expect(evaluateJob(makeJob(), profile, NOW).unverified).toContain("nº de candidatos");
  });

  it("classifica e filtra freelas compatíveis com o currículo", () => {
    const freela = makeJob({ title: "WordPress site for small business", contractType: "Freelance", seniority: undefined, technologies: ["WordPress"], description: "Build a landing page" });
    const r = evaluateJob(freela, profile, NOW);
    expect(r.kind).toBe("freelance");
    expect(r.accepted).toBe(true);
    // freela não exige salário nem senioridade
    expect(evaluateJob(makeJob({ title: "Telegram bot automation", contractType: "Freelance", technologies: [] }), profile, NOW).accepted).toBe(true);
    // fora do escopo / design / presencial
    expect(evaluateJob(makeJob({ title: "Logo designer", contractType: "Freelance", technologies: [] }), profile, NOW).accepted).toBe(false);
    expect(evaluateJob(makeJob({ title: "Video editor", contractType: "Freelance", technologies: [], description: "react" }), profile, NOW).accepted).toBe(false);
    expect(evaluateJob({ ...freela, remote: false }, profile, NOW).accepted).toBe(false);
  });

  it("classifica localização", () => {
    expect(classifyLocation({ location: "Brazil", description: "" })).toBe("eligible");
    expect(classifyLocation({ location: "Worldwide", description: "" })).toBe("eligible");
    expect(classifyLocation({ location: "Remote, United States", description: "" })).toBe("incompatible");
    expect(classifyLocation({ location: "USA Only", description: "" })).toBe("incompatible");
    expect(classifyLocation({ location: "Remote", description: "You must be located in the US." })).toBe("incompatible");
    expect(classifyLocation({ location: "Remote", description: "Great team." })).toBe("unknown");
  });

  it("ordena aprovadas da mais recente para a mais antiga", () => {
    const a = makeJob({ externalId: "a", publishedAt: new Date(NOW.getTime() - 5 * 3600_000) });
    const b = makeJob({ externalId: "b", publishedAt: new Date(NOW.getTime() - 1 * 3600_000) });
    const { accepted } = filterJobs([a, b], profile, NOW);
    expect(accepted.map((x) => x.job.externalId)).toEqual(["b", "a"]);
  });
});

describe("duplicadas entre fontes", () => {
  it("ignora a mesma vaga com mesmo link ou mesma empresa+título", () => {
    const a = makeJob({ externalId: "1", url: "https://x.com/a" });
    const b = makeJob({ externalId: "2", url: "https://x.com/a" });
    const c = makeJob({ externalId: "3", source: "jooble", url: "https://y.com/c" }); // outra fonte, mesma empresa+título+local
    expect(filterJobs([a, b, c], profile, NOW).accepted).toHaveLength(1);
  });
});
