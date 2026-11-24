import { Telegraf } from "telegraf";
import { loadEnv } from "./config/env";
import { loadProfile } from "./config/profile";
import { getPrisma } from "./database/client";
import { PrismaJobStore } from "./database/store";
import { RemotiveCollector } from "./collectors/remotive.collector";
import { GreenhouseCollector } from "./collectors/greenhouse.collector";
import { LeverCollector } from "./collectors/lever.collector";
import { RemoteOkCollector } from "./collectors/remoteok.collector";
import { JobicyCollector } from "./collectors/jobicy.collector";
import { HimalayasCollector } from "./collectors/himalayas.collector";
import { AdzunaCollector } from "./collectors/adzuna.collector";
import { JoobleCollector } from "./collectors/jooble.collector";
import { JSearchCollector } from "./collectors/jsearch.collector";
import { ZenRowsLinkedInCollector } from "./collectors/zenrows-linkedin.collector";
import { ZenRowsClient } from "./services/zenrows.service";
import { ThrottledCollector } from "./collectors/throttled.collector";
import type { Collector } from "./collectors/types";
import { JobAnalysisService } from "./services/job-analysis.service";
import { JobReviewService } from "./services/job-review.service";
import { TelegramNotifier } from "./services/notification.service";
import { SearchService, summaryText } from "./services/search.service";
import { registerCommands } from "./bot/commands";
import { registerCallbacks } from "./bot/callbacks";
import { startScheduler } from "./scheduler";
import { logger, registerSecret, setLogLevel } from "./utils/logger";

async function main() {
  const env = loadEnv();
  setLogLevel(env.LOG_LEVEL);
  registerSecret(env.TELEGRAM_BOT_TOKEN);
  registerSecret(env.OPENROUTER_API_KEY);
  registerSecret(env.ADZUNA_APP_KEY);
  registerSecret(env.JOOBLE_API_KEY);
  registerSecret(env.JSEARCH_RAPIDAPI_KEY);
  registerSecret(env.ZENROWS_API_KEY);
  const profile = loadProfile(env.PROFILE_PATH);

  const db = getPrisma();
  await db.$connect();
  const store = new PrismaJobStore(db);
  await store.saveProfile(profile);

  const collectors: Collector[] = [];
  const src = profile.sources;
  // Cada API pública tem um intervalo mínimo (a Remotive pede no máx. 4 requisições/dia).
  const add = (c: Collector, minutes: number) => collectors.push(new ThrottledCollector(c, minutes * 60_000));
  if (src.remotive.enabled) add(new RemotiveCollector(src.remotive.category), src.remotive.refreshMinutes);
  if (src.remoteok.enabled) add(new RemoteOkCollector(), src.remoteok.refreshMinutes);
  if (src.jobicy.enabled) add(new JobicyCollector(), src.jobicy.refreshMinutes);
  if (src.himalayas.enabled) add(new HimalayasCollector(), src.himalayas.refreshMinutes);
  if (src.adzuna.enabled) {
    if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) add(new AdzunaCollector({ appId: env.ADZUNA_APP_ID, appKey: env.ADZUNA_APP_KEY }, src.adzuna.queries, src.adzuna.maxDaysOld), src.adzuna.refreshMinutes);
    else logger.info("Adzuna desativado: defina ADZUNA_APP_ID e ADZUNA_APP_KEY (vagas brasileiras).");
  }
  if (src.jooble.enabled) {
    if (env.JOOBLE_API_KEY) add(new JoobleCollector(env.JOOBLE_API_KEY, src.jooble.queries, src.jooble.location), src.jooble.refreshMinutes);
    else logger.info("Jooble desativado: defina JOOBLE_API_KEY (vagas brasileiras).");
  }
  if (src.jsearch.enabled) {
    if (env.JSEARCH_RAPIDAPI_KEY) add(new JSearchCollector(env.JSEARCH_RAPIDAPI_KEY, src.jsearch.queries, src.jsearch.datePosted), src.jsearch.refreshMinutes);
    else logger.info("JSearch desativado: defina JSEARCH_RAPIDAPI_KEY (LinkedIn/Indeed/Glassdoor).");
  }
  if (src.zenrowsLinkedin.enabled) {
    if (env.ZENROWS_API_KEY) {
      add(new ZenRowsLinkedInCollector(new ZenRowsClient(env.ZENROWS_API_KEY), src.zenrowsLinkedin), src.zenrowsLinkedin.refreshMinutes);
    } else logger.info("ZenRows/LinkedIn desativado: defina ZENROWS_API_KEY.");
  }
  if (src.greenhouse.enabled && src.greenhouse.companies.length) add(new GreenhouseCollector(src.greenhouse.companies), src.greenhouse.refreshMinutes);
  if (src.lever.enabled && src.lever.companies.length) add(new LeverCollector(src.lever.companies), src.lever.refreshMinutes);

  const analyzer = new JobAnalysisService({ apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL }, profile);
  if (!analyzer.enabled) logger.warn("OPENROUTER_API_KEY ausente: vagas serão enviadas sem análise de IA.");
  const reviewer = new JobReviewService(store, analyzer);

  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
  const notifier = new TelegramNotifier(bot.telegram, env.TELEGRAM_USER_ID, profile.filters.interestTechnologies);
  const search = new SearchService({
    collectors, store, reviewer, notifier, profile, chatId: env.TELEGRAM_USER_ID, maxNotifications: env.MAX_NOTIFICATIONS_PER_RUN,
  });

  // Acesso restrito: qualquer outro usuário é ignorado em silêncio (só registramos o evento).
  bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) !== env.TELEGRAM_USER_ID) {
      logger.warn(`Acesso negado a usuário não autorizado (id ${ctx.from?.id ?? "?"})`);
      return;
    }
    return next();
  });

  let task: ReturnType<typeof startScheduler> | undefined;
  registerCommands(bot, {
    store, profile, search, intervalMinutes: env.SEARCH_INTERVAL_MINUTES,
    aiModel: analyzer.enabled ? analyzer.model : null,
    reviewer, analyzer,
    nextRun: () => { try { return task?.getNextRun() ?? null; } catch { return null; } },
  });
  registerCallbacks(bot, { store, reviewer, profile });
  bot.catch((err) => logger.error("Erro no bot:", err));

  const scheduled = async (trigger: "scheduled" | "startup") => {
    try {
      const s = await search.run(trigger);
      if (s) logger.info(summaryText(s).replace(/\n/g, " | "));
    } catch (e) {
      logger.error("Erro na busca automática:", e);
    }
  };
  task = startScheduler(env.SEARCH_INTERVAL_MINUTES, () => scheduled("scheduled"));

  const me = await bot.telegram.getMe();
  logger.info(`Conectado ao Telegram como @${me.username}. Fontes: ${collectors.map((c) => c.name).join(", ")}. Intervalo: ${env.SEARCH_INTERVAL_MINUTES} min.`);
  await bot.telegram.setMyCommands([
    { command: "buscar", description: "Buscar vagas e freelas agora" },
    { command: "freelas", description: "Buscar somente freelas" },
    { command: "filtros", description: "Ver filtros configurados" },
    { command: "status", description: "Estado do monitoramento" },
    { command: "ajuda", description: "Lista de comandos" },
  ]);

  const stop = async (sig: string) => {
    logger.info(`Encerrando (${sig})…`);
    task?.stop();
    bot.stop(sig);
    await db.$disconnect();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.on("unhandledRejection", (e) => logger.error("unhandledRejection:", e));

  bot.launch().catch((e) => { logger.error("Falha no polling do Telegram:", e); process.exit(1); });
  if (env.RUN_ON_START) void scheduled("startup");
}

main().catch((e) => {
  logger.error("Falha ao iniciar:", e);
  process.exit(1);
});
