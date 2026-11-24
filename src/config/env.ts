import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN ausente"),
  TELEGRAM_USER_ID: z.string().regex(/^\d+$/, "TELEGRAM_USER_ID deve ser numérico"),
  OPENROUTER_API_KEY: z.string().optional().default(""),
  OPENROUTER_MODEL: z.string().default("openrouter/free"),
  // Opcionais: habilitam as fontes que agregam LinkedIn/Indeed/Glassdoor e vagas brasileiras
  ADZUNA_APP_ID: z.string().optional().default(""),
  ADZUNA_APP_KEY: z.string().optional().default(""),
  JOOBLE_API_KEY: z.string().optional().default(""),
  JSEARCH_RAPIDAPI_KEY: z.string().optional().default(""),
  ZENROWS_API_KEY: z.string().optional().default(""),
  DATABASE_URL: z.string().min(1, "DATABASE_URL ausente"),
  SEARCH_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(30),
  RUN_ON_START: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  MAX_NOTIFICATIONS_PER_RUN: z.coerce.number().int().min(1).max(50).default(10),
  PROFILE_PATH: z.string().default("config/profile.json"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração inválida no .env: ${msg}`);
  }
  return parsed.data;
}
