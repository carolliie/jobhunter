import { describe, expect, it, vi } from "vitest";
import { evaluateJob } from "../src/services/job-filter.service";
import { formatJobMessage } from "../src/bot/message";
import { describeLink } from "../src/utils/links";
import { normalizeJSearch } from "../src/collectors/jsearch.collector";
import { postToJob, NotAJobPostError } from "../src/services/manual-post.service";
import { makeJob, NOW, profile, realProfile } from "./helpers";

describe("campos obrigatórios e link direto", () => {
  it("descarta vaga sem empresa ou sem link", () => {
    expect(evaluateJob(makeJob({ company: "Não informada" }), profile, NOW).rejectReasons).toContain("sem nome da empresa");
    expect(evaluateJob(makeJob({ url: "" }), profile, NOW).rejectReasons).toContain("sem link de acesso");
  });

  it("campos obrigatórios configuráveis (salário, modalidade, data)", () => {
    const strict = { ...profile, filters: { ...profile.filters, requiredFields: ["company", "url", "salary", "modality", "publishedAt"] as const } };
    const r = evaluateJob(makeJob({ remote: null, publishedAt: undefined }), strict as any, NOW);
    expect(r.rejectReasons.join()).toMatch(/salário.*obrigatório/);
    expect(r.rejectReasons.join()).toMatch(/modalidade.*obrigatório/);
  });

  it("config real: vaga sem modalidade ou data de publicação NÃO é exibida (salário pode faltar)", () => {
    expect(realProfile.filters.requiredFields).toEqual(expect.arrayContaining(["company", "url", "modality", "publishedAt"]));
    expect(realProfile.filters.requiredFields).not.toContain("salary"); // salário pode vir "não divulgado"
    const complete = makeJob({ salaryMin: 5000, salaryMax: 6000, currency: "BRL" });
    expect(evaluateJob(complete, realProfile, NOW).accepted).toBe(true);
    // sem salário continua sendo aceita (aparece "não divulgado")
    expect(evaluateJob({ ...complete, salaryMin: undefined, salaryMax: undefined } as any, realProfile, NOW).accepted).toBe(true);
    for (const missing of [{ remote: null }, { publishedAt: undefined }, { company: "Não informada" }, { url: "" }]) {
      expect(evaluateJob({ ...complete, ...missing } as any, realProfile, NOW).accepted, JSON.stringify(missing)).toBe(false);
    }
  });

  it("a mensagem sempre traz empresa, modalidade, fonte, publicação, link e salário", () => {
    const msg = formatJobMessage(makeJob({ url: "https://boards.greenhouse.io/acme/jobs/1" }), null, [], [], NOW);
    for (const label of ["Empresa:", "Modalidade:", "Fonte:", "Publicação:", "Link:", "Salário:"]) expect(msg).toContain(label);
    expect(msg).toContain('href="https://boards.greenhouse.io/acme/jobs/1"');
    expect(msg).toContain("direto (boards.greenhouse.io)");
    const noData = formatJobMessage(makeJob({ remote: null, publishedAt: undefined }), null, [], [], NOW);
    expect(noData).toContain("Modalidade não informada");
    expect(noData).toContain("data não informada");
    expect(noData).toContain("Salário: não divulgado");
  });

  it("identifica link direto x agregador", () => {
    expect(describeLink("https://www.adzuna.com.br/land/ad/1")).toMatchObject({ direct: false });
    expect(describeLink("https://jobs.lever.co/acme/1").direct).toBe(true);
  });

  it("JSearch prefere o link direto da empresa", () => {
    const j = normalizeJSearch({ job_id: "1", job_title: "Dev", job_apply_link: "https://br.linkedin.com/jobs/view/1", apply_options: [{ publisher: "LinkedIn", apply_link: "https://br.linkedin.com/jobs/view/1", is_direct: false }, { publisher: "Acme", apply_link: "https://acme.com/careers/1", is_direct: true }] });
    expect(j.url).toBe("https://acme.com/careers/1");
  });
});

describe("post colado (LinkedIn)", () => {
  const noAi = { enabled: false, extractPost: vi.fn() };
  const text = "🚀 Estamos contratando! Desenvolvedor React Júnior - 100% remoto - CLT. Salário R$ 4.500. Candidate-se: https://acme.com/vagas/123. Stack: React, Node.js e PostgreSQL";

  it("extrai por regras quando a IA está desativada, sem inventar empresa", async () => {
    const j = await postToJob(text, [], noAi, NOW);
    expect(j).toMatchObject({ source: "post-linkedin", url: "https://acme.com/vagas/123", remote: true, seniority: "junior", contractType: "CLT", salaryMin: 4500, company: "Não informada" });
    expect(j.publishedAt).toBeUndefined();
  });

  it("usa dados da IA, mas ignora link que não esteja no texto e rejeita não-vagas", async () => {
    const ai = { enabled: true, extractPost: vi.fn(async () => ({ isJobPost: true, title: "Dev React", company: "Acme", location: "Brasil", remote: true, contractType: "CLT", salaryText: "", technologies: ["React"], applyUrl: "https://evil.example/inventado" })) };
    const j = await postToJob(text, [], ai, NOW);
    expect(j.company).toBe("Acme");
    expect(j.url).toBe("https://acme.com/vagas/123");
    const no = { enabled: true, extractPost: vi.fn(async () => ({ isJobPost: false } as any)) };
    await expect(postToJob("só um papo qualquer sobre o dia de ontem no trabalho e nada mais", [], no, NOW)).rejects.toBeInstanceOf(NotAJobPostError);
  });

  it("o mesmo post gera o mesmo id (sem duplicar no banco)", async () => {
    expect((await postToJob(text, [], noAi, NOW)).externalId).toBe((await postToJob(text + "  ", [], noAi, NOW)).externalId);
  });
});
