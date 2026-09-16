// ────────────────────────────────────────
// Cron job types
// ────────────────────────────────────────

export interface CronJobConfig {
  name: string;
  schedule: string;
  enabled: boolean;
}

export interface CronJobResult {
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}
