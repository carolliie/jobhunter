import type { Telegram } from "telegraf";
import type { Job } from "../types";
import type { StoredAnalysis } from "../database/store";
import { formatJobMessage, jobKeyboard } from "../bot/message";

export interface Notifier {
  send(jobId: string, job: Job, analysis: StoredAnalysis | null, unverified: string[]): Promise<number>;
}

export class TelegramNotifier implements Notifier {
  constructor(private telegram: Telegram, private chatId: string, private interest: string[]) {}

  private last = 0;

  async send(jobId: string, job: Job, analysis: StoredAnalysis | null, unverified: string[]): Promise<number> {
    // O Telegram limita ~1 mensagem/s por chat: espaça os envios.
    const wait = 1100 - (Date.now() - this.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const msg = await this.telegram.sendMessage(this.chatId, formatJobMessage(job, analysis, unverified, this.interest), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: jobKeyboard(jobId, job.url),
    });
    return msg.message_id;
  }
}
