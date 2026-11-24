import { describe, expect, it, vi, afterEach } from "vitest";
import { detectTechnologies, inferSeniority, parseSalaryText, toMonthly } from "../src/services/normalize";
import { normalizeRemotive, RemotiveCollector } from "../src/collectors/remotive.collector";
import { normalizeGreenhouse, GreenhouseCollector } from "../src/collectors/greenhouse.collector";
import { normalizeLever } from "../src/collectors/lever.collector";
import { normalizeRemoteOk } from "../src/collectors/remoteok.collector";
import { normalizeJobicy } from "../src/collectors/jobicy.collector";
import { normalizeHimalayas } from "../src/collectors/himalayas.collector";
import { htmlToText } from "../src/utils/text";

afterEach(() => vi.restoreAllMocks());

describe("normalização", () => {
  it("detecta tecnologias sem confundir React com React Native", () => {
    expect(detectTechnologies("We use React and TypeScript with Node.js")).toEqual(["TypeScript", "Node.js", "React"]);
    const rn = detectTechnologies("React Native developer");
    expect(rn).toContain("React Native");
    expect(rn).not.toContain("React");
  });

  it("infere senioridade pelo título", () => {
    expect(inferSeniority("Senior Backend Engineer")).toBe("senior");
    expect(inferSeniority("Software Engineer Jr.")).toBe("junior");
    expect(inferSeniority("Desenvolvedor Pleno")).toBe("mid");
    expect(inferSeniority("Software Engineer")).toBeUndefined();
  });

  it("interpreta salários em texto livre e normaliza para mensal", () => {
    expect(parseSalaryText("$60k - $120k/year")).toEqual({ min: 5000, max: 10000, currency: "USD" });
    expect(parseSalaryText("$20/hour")).toEqual({ min: 3200, max: 3200, currency: "USD" });
    expect(parseSalaryText("R$ 4.500 por mês")).toMatchObject({ min: 4500, currency: "BRL" });
    expect(parseSalaryText("Competitive")).toEqual({});
    expect(toMonthly(120000, "USD", undefined)).toBe(10000);
  });

  it("remove HTML e decodifica entidades", () => {
    expect(htmlToText("<p>Olá &amp; bem-vindo</p>")).toBe("Olá & bem-vindo");
    expect(htmlToText("<p>A</p><script>alert(1)</script><p>B</p>")).not.toContain("alert");
  });

  it("normaliza Remotive (data sem fuso tratada como UTC)", () => {
    const j = normalizeRemotive({
      id: 7, url: "https://remotive.com/x", title: "Junior React Developer", company_name: "Acme",
      job_type: "contract", publication_date: "2026-11-23T10:00:00", candidate_required_location: "Brazil",
      salary: "$3k - $4k/month", description: "<p>React and Node.js</p>",
    });
    expect(j).toMatchObject({ externalId: "7", source: "remotive", remote: true, contractType: "PJ", seniority: "junior", currency: "USD", salaryMin: 3000, salaryMax: 4000 });
    expect(j.publishedAt?.toISOString()).toBe("2026-11-23T10:00:00.000Z");
    expect(j.technologies).toEqual(["Node.js", "React"]);
  });

  it("normaliza Greenhouse: content escapado, remote nulo quando incerto, sem salário inventado", () => {
    const j = normalizeGreenhouse({
      id: 99, title: "Software Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/99",
      company_name: "Acme", location: { name: "Remote" }, first_published: "2026-11-22T12:00:00-03:00",
      content: "&lt;p&gt;TypeScript &amp;amp; Docker&lt;/p&gt;",
    }, "acme");
    expect(j.externalId).toBe("acme:99");
    expect(j.remote).toBe(true);
    expect(j.salaryMin).toBeUndefined();
    expect(j.description).toBe("TypeScript & Docker");
    expect(j.technologies).toEqual(["TypeScript", "Docker"]);
    expect(normalizeGreenhouse({ id: 1, title: "x", absolute_url: "u", location: { name: "São Paulo" } }, "acme").remote).toBeNull();
  });

  it("normaliza Lever: workplaceType, salaryRange anual -> mensal, createdAt em ms", () => {
    const j = normalizeLever({
      id: "abc", text: "Backend Engineer (Pleno)", hostedUrl: "https://jobs.lever.co/acme/abc", createdAt: 1_790_000_000_000,
      workplaceType: "remote", categories: { location: "Brazil", commitment: "Full-time" },
      descriptionPlain: "Node.js and PostgreSQL",
      salaryRange: { currency: "BRL", interval: "per-year-salary", min: 120000, max: 180000 },
    }, "acme");
    expect(j).toMatchObject({ remote: true, seniority: "mid", currency: "BRL", salaryMin: 10000, salaryMax: 15000 });
    expect(j.publishedAt?.getTime()).toBe(1_790_000_000_000);
  });

  it("normaliza RemoteOK, Jobicy e Himalayas", () => {
    const ok = normalizeRemoteOk({ id: "9", epoch: 1_790_000_000, company: "A", position: "Junior Node.js Developer", tags: ["freelance", "node"], url: "https://remoteok.com/x", salary_min: 60000, salary_max: 0, location: "Worldwide" });
    expect(ok).toMatchObject({ source: "remoteok", remote: true, contractType: "Freelance", salaryMin: 5000, currency: "USD", seniority: "junior" });
    expect(ok.salaryMax).toBeUndefined();
    const jb = normalizeJobicy({ id: 5, url: "https://jobicy.com/jobs/5", jobTitle: "React Dev", jobType: ["Contract"], jobGeo: "LATAM,  USA", jobLevel: "Midlevel", pubDate: "2026-11-23T10:00:00+00:00", salaryMin: 36000, salaryMax: 48000, salaryCurrency: "USD", salaryPeriod: "yearly" });
    expect(jb).toMatchObject({ contractType: "PJ", seniority: "mid", location: "LATAM, USA", salaryMin: 3000, salaryMax: 4000 });
    const hm = normalizeHimalayas({ title: "Backend Dev", guid: "g1", applicationLink: "https://himalayas.app/x", employmentType: "Contractor", minSalary: 20, maxSalary: 30, salaryPeriod: "hourly", currency: "USD", seniority: ["Entry-level"], locationRestrictions: [], pubDate: 1_790_000_000 });
    expect(hm).toMatchObject({ location: "Worldwide", contractType: "PJ", seniority: "junior", salaryMin: 3200, salaryMax: 4800 });
  });

  it("detecta stack do currículo (Spring Boot, WordPress, SQL)", () => {
    expect(detectTechnologies("Java Spring Boot, WordPress and SQL")).toEqual(expect.arrayContaining(["Spring Boot", "WordPress", "SQL", "Java"]));
  });

  it("coletores usam a API e toleram falha parcial", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("remotive.com")) {
        return new Response(JSON.stringify({ jobs: [{ id: 1, url: "https://remotive.com/1", title: "Dev", company_name: "A" }, { bad: true }] }), { status: 200 });
      }
      if (url.includes("/boards/ok/")) return new Response(JSON.stringify({ jobs: [{ id: 5, title: "Dev", absolute_url: "https://x/5" }] }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    expect((await new RemotiveCollector().collect()).jobs).toHaveLength(1);
    const r = await new GreenhouseCollector(["ok", "missing"]).collect();
    expect(r.jobs).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/missing/);
    expect(fetchMock).toHaveBeenCalled();
    await expect(new GreenhouseCollector(["missing"]).collect()).rejects.toThrow();
  });
});
