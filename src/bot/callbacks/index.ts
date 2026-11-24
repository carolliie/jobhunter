import type { Telegraf } from "telegraf";
import type { JobStore } from "../../database/store";
import type { Reviewer } from "../../services/job-review.service";
import type { Profile } from "../../config/profile";
import { formatJobMessage, jobKeyboard } from "../message";
import { logger } from "../../utils/logger";

const ID_RE = /^[a-z0-9]{20,32}$/;

export function registerCallbacks(bot: Telegraf, deps: { store: JobStore; reviewer: Reviewer; profile: Profile }) {
  const reanalyzing = new Set<string>();

  bot.action(/^([sdr]):([a-z0-9]+)$/, async (c) => {
    const action = c.match[1]!;
    const jobId = c.match[2]!;
    if (!ID_RE.test(jobId)) return void (await c.answerCbQuery("Identificador inválido"));
    const rec = await deps.store.getJob(jobId);
    if (!rec) return void (await c.answerCbQuery("Vaga não encontrada"));

    try {
      if (action === "s" || action === "d") {
        const status = action === "s" ? "SAVED" : "DISCARDED";
        await deps.store.setSavedStatus(jobId, status);
        await c.answerCbQuery(status === "SAVED" ? "Vaga salva ✅" : "Vaga descartada 🗑");
        await c.editMessageReplyMarkup(jobKeyboard(jobId, rec.job.url, status)).catch(() => {});
        return;
      }
      // Reanalisar: ignora o cache e consome IA novamente (uma por vez por vaga)
      if (reanalyzing.has(jobId)) return void (await c.answerCbQuery("Reanálise já em andamento…"));
      reanalyzing.add(jobId);
      await c.answerCbQuery("Reanalisando…");
      try {
        const analysis = await deps.reviewer.review(jobId, rec.job, { force: true });
        const status = await deps.store.getSavedStatus(jobId);
        const text = formatJobMessage(rec.job, analysis, rec.unverified, deps.profile.filters.interestTechnologies);
        await c.editMessageText(text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: jobKeyboard(jobId, rec.job.url, status),
        }).catch((e: Error) => {
          // "message is not modified" quando o resultado é idêntico
          if (!/not modified/i.test(e.message)) throw e;
        });
      } finally {
        reanalyzing.delete(jobId);
      }
    } catch (e) {
      logger.error("Erro em callback:", e);
      await c.reply("Não foi possível concluir a ação. Tente novamente.").catch(() => {});
    }
  });
}
