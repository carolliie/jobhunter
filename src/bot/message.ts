import type { Job } from "../types";
import type { StoredAnalysis } from "../database/store";
import { combineRisk } from "../services/job-analysis.service";
import { scanTextSigns } from "../services/job-verification.service";
import { escapeHtml as e, truncate } from "../utils/text";
import { describeLink } from "../utils/links";

export const TELEGRAM_LIMIT = 4096;

export function timeAgo(date: Date | undefined, now = new Date()): string {
  if (!date) return "data não informada";
  const min = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60_000));
  if (min < 60) return min <= 1 ? "agora há pouco" : `há ${min} minutos`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? "há 1 hora" : `há ${h} horas`;
  const d = Math.round(h / 24);
  return d === 1 ? "há 1 dia" : `há ${d} dias`;
}

export function formatSalary(job: Job): string {
  const { salaryMin: min, salaryMax: max, currency } = job;
  if ((min === undefined && max === undefined) || !currency) return "não divulgado";
  let fmt: (n: number) => string;
  try {
    const nf = new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 0 });
    fmt = (n) => nf.format(n);
  } catch { fmt = (n) => `${currency} ${Math.round(n)}`; }
  const range = min !== undefined && max !== undefined && min !== max ? `${fmt(min)} – ${fmt(max)}` : fmt((max ?? min)!);
  return `${range}/mês`;
}

const VERIFY_LABEL: Record<string, string> = {
  verified: "publicada no ATS oficial da empresa (verificado)",
  partially_verified: "parcialmente verificada",
  unverified: "não verificada",
  suspicious: "suspeita",
};

export function formatJobMessage(
  job: Job, analysis: StoredAnalysis | null, unverified: string[], interest: string[], now = new Date(),
): string {
  const lines: string[] = [];
  const freela = job.kind === "freelance";
  lines.push(freela ? "💼 <b>Novo freela encontrado!</b>" : "🆕 <b>Nova vaga encontrada!</b>", "");
  lines.push(`<b>${e(truncate(job.title, 120))}</b>`, `Empresa: ${e(truncate(job.company, 80))}`, "");
  const mode = job.remote === true ? "Remoto" : job.remote === false ? "Não remoto" : "Modalidade não informada";
  lines.push(`Modalidade: ${mode}`);
  lines.push(`Local: ${e(truncate(job.location, 100))}`);
  lines.push(`Contrato: ${e(freela ? "Freelance (por projeto)" : job.contractType ?? "não informado")}`);
  lines.push(`${freela ? "Valor" : "Salário"}: ${e(formatSalary(job))}`);
  lines.push(`Publicação: ${timeAgo(job.publishedAt, now)}`);
  lines.push(`Candidatos: ${job.applicants !== undefined ? job.applicants : "não informado"}`);
  lines.push(`Fonte: ${e(job.source === "post-linkedin" ? "LinkedIn (post colado por você)" : job.source)}`);
  if (/^https?:\/\//i.test(job.url)) {
    lines.push(`Link: <a href="${e(job.url).replace(/"/g, "&quot;")}">abrir vaga</a> — ${e(describeLink(job.url).label)}`, "");
  } else lines.push("Link: não informado no post", "");

  const m = analysis?.match;
  if (m) {
    lines.push(`<b>Compatibilidade: ${m.matchScore}%</b>`);
    if (m.summary) lines.push(e(truncate(m.summary, 300)));
  } else lines.push("<b>Compatibilidade:</b> análise de IA indisponível");
  const interestSet = new Set(interest.map((t) => t.toLowerCase()));
  const techs = m?.matchingSkills.length ? m.matchingSkills : job.technologies.filter((t) => interestSet.has(t.toLowerCase()));
  if (techs.length) lines.push("", "Tecnologias compatíveis:", ...techs.slice(0, 8).map((t) => `• ${e(t)}`));
  if (m?.missingSkills.length) lines.push("", `Faltam: ${e(m.missingSkills.slice(0, 5).join(", "))}`);

  // Segurança: análise textual e verificação externa mostradas separadamente
  const signs = scanTextSigns(job);
  const risk = combineRisk({ ai: analysis?.risk ?? undefined, heuristicSigns: signs, verificationStatus: analysis?.verification?.status });
  lines.push("", `<b>Segurança:</b> ${e(risk.label)}`);
  if (analysis?.risk?.explanation) lines.push(e(truncate(analysis.risk.explanation, 300)));
  const warnings = [...new Set([...(analysis?.risk?.warningSigns ?? []), ...signs, ...(analysis?.verification?.warnings ?? [])])];
  if (warnings.length) lines.push("⚠️ Sinais de alerta:", ...warnings.slice(0, 5).map((w) => `• ${e(truncate(w, 140))}`));
  const v = analysis?.verification;
  if (v) {
    lines.push(`Verificação externa: ${VERIFY_LABEL[v.status] ?? v.status}`);
    const missing = [...new Set([...v.missing, ...(analysis?.risk?.missingEvidence ?? [])])];
    if (missing.length) lines.push(...missing.slice(0, 3).map((x) => `• ${e(truncate(x, 140))}`));
  } else lines.push("Verificação externa: não realizada");
  lines.push("<i>Risco baixo não confirma autenticidade. Confirme na página oficial da empresa.</i>");

  if (unverified.length) lines.push("", `Não verificado: ${e(unverified.join(", "))}`);

  // Garante o limite do Telegram preservando o início da mensagem
  let text = lines.join("\n");
  if (text.length > TELEGRAM_LIMIT) text = text.slice(0, TELEGRAM_LIMIT - 20).replace(/<[^>]*$/, "") + "\n…";
  return text;
}

export function jobKeyboard(jobId: string, url: string, status: "SAVED" | "DISCARDED" | null = null) {
  const rows: Array<Array<{ text: string; url: string } | { text: string; callback_data: string }>> = [];
  if (/^https?:\/\//i.test(url)) rows.push([{ text: "🔗 Ver vaga", url }]);
  rows.push([
    { text: status === "SAVED" ? "✅ Salva" : "💾 Salvar", callback_data: `s:${jobId}` },
    { text: status === "DISCARDED" ? "🗑 Descartada" : "🗑 Descartar", callback_data: `d:${jobId}` },
  ]);
  rows.push([{ text: "🔄 Reanalisar", callback_data: `r:${jobId}` }]);
  return { inline_keyboard: rows };
}
