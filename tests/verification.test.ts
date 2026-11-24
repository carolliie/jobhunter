import { describe, expect, it } from "vitest";
import { isPrivateIp, scanTextSigns, validateExternalUrl, verifyJob } from "../src/services/job-verification.service";
import { makeJob } from "./helpers";

describe("verificação externa", () => {
  it("bloqueia IPs internos (SSRF)", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(() => validateExternalUrl("http://169.254.169.254/latest")).toThrow();
    expect(() => validateExternalUrl("http://localhost:3000")).toThrow();
    expect(() => validateExternalUrl("file:///etc/passwd")).toThrow();
    expect(() => validateExternalUrl("https://user:pw@example.com")).toThrow();
    expect(() => validateExternalUrl("https://example.com:8443")).toThrow();
  });

  it("vaga no ATS oficial com título na página => verified", async () => {
    const job = makeJob({ source: "greenhouse", url: "https://job-boards.greenhouse.io/acme/jobs/1", title: "Software Engineer", company: "Acme" });
    const r = await verifyJob(job, { fetchPage: async (u) => ({ finalUrl: u, status: 200, text: "<title>Job Application for Software Engineer at Acme</title>" }) });
    expect(r.status).toBe("verified");
  });

  it("agregador acessível => partially_verified, nunca verified", async () => {
    const job = makeJob({ url: "https://remotive.com/remote-jobs/x" });
    const r = await verifyJob(job, { fetchPage: async (u) => ({ finalUrl: u, status: 200, text: "Software Engineer Jr." }) });
    expect(r.status).toBe("partially_verified");
    expect(r.missing.join()).toMatch(/página de carreiras/);
  });

  it("falha de rede => unverified (sem inventar resultado)", async () => {
    const r = await verifyJob(makeJob(), { fetchPage: async () => { throw new Error("timeout"); } });
    expect(r.status).toBe("unverified");
    expect(r.missing.join()).toMatch(/timeout/);
  });

  it("encurtador, http e URL interna => suspicious", async () => {
    const fp = async (u: string) => ({ finalUrl: u, status: 200, text: "" });
    expect((await verifyJob(makeJob({ url: "https://bit.ly/abc" }), { fetchPage: fp })).status).toBe("suspicious");
    expect((await verifyJob(makeJob({ url: "http://127.0.0.1/admin" }), { fetchPage: fp })).status).toBe("suspicious");
  });

  it("detecta sinais textuais de golpe", () => {
    const signs = scanTextSigns({ title: "Dev", url: "", description: "Pay a fee for training kit. Send your bank details. Contact on WhatsApp to apply: https://wa.me/123" });
    expect(signs.length).toBeGreaterThanOrEqual(3);
    expect(scanTextSigns({ title: "Dev", url: "", description: "We build SaaS with React." })).toEqual([]);
  });
});
