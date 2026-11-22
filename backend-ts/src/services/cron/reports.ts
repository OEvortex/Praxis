// Port of backend/app/services/cron/reports.py — recent reminders that
// actually fired, kept in the shared SQLite kv store for live in-app delivery.
import { get_settings } from "../../config.js";
import { get_state, put_state } from "../../store/database.js";

const MAX_REPORTS = 200;
const KEY = "cron/reports";

export interface CronReport {
  id: string;
  job_id: string;
  name: string;
  text: string;
  status: string;
  at: number;
  [k: string]: unknown;
}

function read(): CronReport[] {
  const raw = get_state<unknown>(get_settings(), KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is CronReport => typeof item === "object" && item !== null);
}

/** Append one delivered reminder and return its entry. */
export function record(args: {
  job_id: string;
  name: string;
  text: string;
  status: string;
}): CronReport {
  const entry: CronReport = {
    id: `${args.job_id}:${Date.now()}`,
    job_id: args.job_id,
    name: args.name,
    text: (args.text ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 1000),
    status: args.status,
    at: Date.now() / 1000,
  };
  const items = [...read(), entry].slice(-MAX_REPORTS);
  put_state(get_settings(), KEY, items);
  return entry;
}

/** Reports at or after `epochSeconds`, oldest first. */
export function since(epochSeconds: number): CronReport[] {
  return read().filter((item) => Number(item.at ?? 0) >= epochSeconds);
}
