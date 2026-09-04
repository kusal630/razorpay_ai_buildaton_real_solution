import { z } from "zod";

const envSchema = z
  .object({
    PORT: z.coerce.number().default(3000),
    PROCESS_ROLE: z.enum(["api", "worker", "all"]).default("all"),
    DATABASE_URL: z.string(),
    REDIS_URL: z.string(),
    RAZORPAY_KEY_ID: z.string(),
    RAZORPAY_KEY_SECRET: z.string(),
    RAZORPAY_WEBHOOK_SECRET: z.string(),
    RAZORPAY_MODE: z.enum(["test", "live"]).default("test"),
    LIVE_MODE_ACK: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    ENABLE_DEV_TOOLS: z
      .string()
      .default("true")
      .transform((v) => v === "true"),
    APP_ENCRYPTION_KEY: z.string(),
    APP_SECRET: z.string().default("sellable-app-secret-key-2024"),
    SESSION_SECRET: z.string(),
    LLM_BASE_URL: z.string().default("https://api.openai.com/v1"),
    LLM_API_KEY: z.string().default(""),
    LLM_MODEL: z.string().default("gpt-4o-mini"),
    BASE_URL: z.string().default("http://localhost:3000"),
    ABANDON_MINUTES: z.coerce.number().default(1440),
    RETRY_TTL_MIN: z.coerce.number().default(10),
    HOLD_TTL_MIN: z.coerce.number().default(15),
    POLL_INTERVAL_SEC: z.coerce.number().default(60),
    DAILY_INCENTIVE_BUDGET_PAISE: z.coerce.number().default(500000),
    ALERT_WEBHOOK_URL: z.string().default(""),
  })
  .refine(
    (data) => {
      if (data.RAZORPAY_MODE === "live") {
        return data.LIVE_MODE_ACK === true && data.ENABLE_DEV_TOOLS === false && data.ABANDON_MINUTES >= 60;
      }
      return true;
    },
    {
      message:
        "LIVE mode requires LIVE_MODE_ACK=true AND ENABLE_DEV_TOOLS=false AND ABANDON_MINUTES>=60",
    }
  );

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  _config = envSchema.parse(process.env);
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}
