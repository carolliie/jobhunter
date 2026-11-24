import { describe, expect, it } from "vitest";
import { intervalToCron } from "../src/scheduler";
import { formatJobMessage, formatSalary, jobKeyboard, timeAgo, TELEGRAM_LIMIT } from "../src/bot/message";
import { redact, registerSecret } from "../src/utils/logger";
import { makeJob, NOW } from "./helpers";

describe("scheduler, mensagem e logs", () => {
  it("converte o intervalo em cron", () => {
    expect(intervalToCron(30)).toBe("*/30 * * * *");
    expect(intervalToCron(120)).toBe("0 */2 * * *");
    expect(() => intervalToCron(45)).toThrow();
  });

  it("formata a mensagem respeitando o limite do Telegram e escapando HTML", () => {
    const job = makeJob({ title: "<b>Dev</b> & Co", description: "x".repeat(50_000), salaryMin: 4500, salaryMax: 4500, currency: "BRL" });
    const msg = formatJobMessage(job, null, ["salário"], ["React"], NOW);
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(msg).toContain("&lt;b&gt;Dev&lt;/b&gt; &amp; Co");
    expect(msg).toContain("análise de IA indisponível");
    expect(formatSalary(makeJob())).toBe("não divulgado");
    expect(timeAgo(new Date(NOW.getTime() - 3 * 3600_000), NOW)).toBe("há 3 horas");
  });

  it("gera botões inline (abrir, salvar, descartar, reanalisar) com callback_data curto", () => {
    const kb = jobKeyboard("cm1234567890abcdefghijklm", "https://x.com/j");
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(4);
    for (const b of flat) if ("callback_data" in b) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it("nunca registra tokens em logs", () => {
    registerSecret("super-secret-token-value");
    expect(redact("erro com super-secret-token-value no meio")).not.toContain("super-secret");
    expect(redact("https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123/getMe")).toContain("bot***");
  });
});
