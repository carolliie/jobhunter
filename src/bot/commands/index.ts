import type { Telegraf } from "telegraf";
import type { JobStore } from "../../database/store";
import type { Profile } from "../../config/profile";
import type { Reviewer } from "../../services/job-review.service";
import type { JobAnalysisService } from "../../services/job-analysis.service";
import { postToJob, NotAJobPostError } from "../../services/manual-post.service";
import { formatJobMessage, jobKeyboard } from "../message";
import { logger } from "../../utils/logger";
import type { SearchService } from "../../services/search.service";
import { summaryText } from "../../services/search.service";
import { escapeHtml as e } from "../../utils/text";

export interface BotContext {
  store: JobStore;
  profile: Profile;
  search: SearchService;
  intervalMinutes: number;
  aiModel: string | null; // null = IA desativada
  nextRun: () => Date | null;
  reviewer: Reviewer;
  analyzer: Pick<JobAnalysisService, "enabled" | "extractPost">;
}

const HELP = [
  "<b>Comandos</b>",
  "/buscar — busca vagas (CLT/PJ) e freelas agora",
  "/freelas — busca somente freelas (bots, automações, WordPress, sistemas pequenos)",
  "/filtros — mostra os filtros configurados",
  "/status — estado do monitoramento e última execução",
  "/analisar — como analisar um post de vaga do LinkedIn (cole ou encaminhe o texto)",
  "/ajuda — esta lista",
].join("\n");

export function fmtDate(d: Date | null | undefined): string {
  return d ? d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
}

export function filtersText(p: Profile): string {
  const f = p.filters;
  const src = p.sources;
  return [
    "<b>Filtros configurados</b>",
    `• Modalidade: ${f.remoteOnly ? "100% remota" : "qualquer"}${f.requireBrazilEligible ? ", elegível para o Brasil" : ""}`,
    `• Contratação: ${e(f.contractTypes.join(" / "))}`,
    `• Salário: acima de R$ ${f.minSalaryBRL.toLocaleString("pt-BR")} (vagas sem salário não são descartadas)`,
    `• Senioridade: ${e(f.seniorities.join(", "))}`,
    `• Concorrência: até ${f.maxApplicants} candidatos (quando a fonte informa) ou publicada há ≤ ${f.veryRecentHours}h; teto ${f.maxAgeHours}h`,
    "• Confiabilidade: descarta links suspeitos, risco alto e recomendação \"evitar\"",
    `• Freelas: ${f.freelance.enabled ? "ativos (bots, automações, WordPress, sites e sistemas pequenos)" : "desativados"}`,
    `• Compatibilidade mínima: ${f.minMatchScore}%`,
    `• Tecnologias: ${e(f.interestTechnologies.join(", "))}`,
    "",
    "<b>Fontes</b>",
    `• APIs públicas: ${["remotive", "remoteok", "jobicy", "himalayas", "adzuna", "jooble", "jsearch"].filter((k) => (src as Record<string, { enabled: boolean }>)[k]?.enabled).join(", ")}`,
    `• Greenhouse: ${src.greenhouse.enabled ? e(src.greenhouse.companies.join(", ")) : "desativada"}`,
    `• Lever: ${src.lever.enabled ? e(src.lever.companies.map((c) => c.name).join(", ")) : "desativada"}`,
    "",
    "<i>Edite config/profile.json e reinicie o bot para alterar.</i>",
  ].join("\n");
}

export function registerCommands(bot: Telegraf, ctx: BotContext) {
  bot.start((c) =>
    c.replyWithHTML(
      [
        "👋 <b>JobHunter</b> ativo!",
        "Busco vagas de tecnologia remotas (Remotive, Greenhouse e Lever), filtro pelo seu perfil, analiso compatibilidade e sinais de golpe com IA e envio aqui.",
        `Verifico novas vagas automaticamente a cada ${ctx.intervalMinutes} min.`,
        "",
        HELP,
      ].join("\n"),
    ),
  );

  bot.command("ajuda", (c) => c.replyWithHTML(HELP));
  bot.command("filtros", (c) => c.replyWithHTML(filtersText(ctx.profile), { link_preview_options: { is_disabled: true } }));

  bot.command("status", async (c) => {
    const [last] = await ctx.store.lastExecutions(1);
    const counts = await ctx.store.counts();
    const lines = [
      "<b>Status do monitoramento</b>",
      `• Busca automática: a cada ${ctx.intervalMinutes} min (próxima: ${fmtDate(ctx.nextRun())})`,
      `• Busca em andamento: ${ctx.search.isRunning ? "sim" : "não"}`,
      `• IA: ${ctx.aiModel ? `ativa (${e(ctx.aiModel)})` : "desativada (sem OPENROUTER_API_KEY)"}`,
      `• Vagas no banco: ${counts.jobs} • Notificadas: ${counts.notified} • Salvas: ${counts.saved}`,
    ];
    if (last) {
      lines.push(
        "",
        `<b>Última execução</b> (${last.trigger}, ${last.status})`,
        `Início: ${fmtDate(last.startedAt)}`,
        `Coletadas ${last.collected} • aprovadas ${last.accepted} • novas ${last.newJobs} • notificadas ${last.notified}`,
        ...(last.errors.length ? [`Avisos: ${e(last.errors.slice(0, 3).join("; ").slice(0, 400))}`] : []),
      );
    } else lines.push("", "Nenhuma execução registrada ainda.");
    await c.replyWithHTML(lines.join("\n"));
  });

  const manual = (kinds: Array<"job" | "freelance">, label: string) => async (c: { reply: (t: string) => Promise<unknown> }) => {
    if (ctx.search.isRunning) return void (await c.reply("⏳ Já existe uma busca em andamento. Aguarde."));
    await c.reply(`🔎 Buscando ${label}… isso pode levar alguns minutos.`);
    const summary = await ctx.search.run("manual", kinds);
    if (!summary) return void (await c.reply("⏳ Já existe uma busca em andamento."));
    await c.reply(summaryText(summary));
  };
  bot.command("buscar", manual(["job", "freelance"], "vagas e freelas"));
  bot.command("freelas", manual(["freelance"], "freelas"));

  bot.command("analisar", (c) =>
    c.reply("Cole aqui o texto do post da vaga (ou encaminhe a mensagem). Eu extraio os dados, analiso compatibilidade com o seu CV e sinais de golpe, e devolvo o card com os botões. Inclua o link do post/da vaga no texto, se houver."),
  );

  // Texto livre = post de vaga colado (o LinkedIn não permite ler posts automaticamente)
  bot.on("text", async (c) => {
    const text = c.message.text;
    if (text.startsWith("/")) return;
    if (text.length < 40) return void (await c.reply("Texto curto demais para ser uma vaga. Cole o post completo."));
    const entityUrls = (c.message.entities ?? []).flatMap((en) => (en.type === "text_link" ? [en.url] : []));
    const wait = await c.reply("🔍 Analisando o post…");
    try {
      const job = await postToJob(text, entityUrls, ctx.analyzer);
      const unverified = ["data de publicação", ...(job.salaryMax === undefined && job.salaryMin === undefined ? ["salário"] : [])];
      const { id } = await ctx.store.upsertJob(job, unverified);
      const analysis = await ctx.reviewer.review(id, job);
      await c.reply(formatJobMessage(job, analysis, unverified, ctx.profile.filters.interestTechnologies), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: jobKeyboard(id, job.url),
      });
    } catch (e) {
      if (e instanceof NotAJobPostError) await c.reply(e.message);
      else {
        logger.error("Falha ao analisar post:", e);
        await c.reply("Não consegui analisar esse texto. Tente novamente.");
      }
    } finally {
      await c.telegram.deleteMessage(c.chat.id, wait.message_id).catch(() => {});
    }
  });
}
