export interface Session {
  id: number;
  account: string;
  session_id: string;
  started_at: string;
  expires_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface Schedule {
  id: number;
  account: string;
  target_datetime: string;
  hours_remaining: number;
  warmup_at: string;
  created_at: string;
  fired: number;
}

export interface DailySchedule {
  id: number;
  account: string;
  /** Comma-separated times of day, e.g. `"7:29 AM, 1:00 PM"`. */
  times_of_day: string;
  hours_remaining: number;
  target_datetime: string;
  warmup_at: string;
  created_at: string;
  last_fired_at: string | null;
}

export interface WarmupResult {
  success: boolean;
  session_id?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  cost_usd?: number;
  error?: string;
}
