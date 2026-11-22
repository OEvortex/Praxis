// file-backed learning journal (mission + last-session handoff + ADR-style
// records) stored as atomic JSON under the data directory.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Settings } from "../../config.js";
import { get_settings } from "../../config.js";

export const JOURNAL_VERSION = 1;
export const MAX_RECORDS = 50;
const MAX_TOPIC_CHARS = 200;
const MAX_WHY_CHARS = 800;
const MAX_LEVEL_CHARS = 40;
const MAX_SUMMARY_CHARS = 800;
const MAX_NEXT_FOCUS_CHARS = 400;
const MAX_TITLE_CHARS = 120;
const MAX_INSIGHT_CHARS = 800;

export interface LearningMission {
  topic: string;
  why: string;
  level: string;
  updated_at: string;
}

export interface LearningSessionNote {
  summary: string;
  next_focus: string;
  updated_at: string;
}

export interface LearningRecord {
  id: string;
  title: string;
  insight: string;
  created_at: string;
}

export interface LearningJournal {
  version: number;
  updated_at: string;
  mission: LearningMission;
  last_session: LearningSessionNote;
  records: LearningRecord[];
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function emptyMission(): LearningMission {
  return { topic: "", why: "", level: "", updated_at: "" };
}

function emptySession(): LearningSessionNote {
  return { summary: "", next_focus: "", updated_at: "" };
}

function missionIsEmpty(m: LearningMission): boolean {
  return !(m.topic.trim() || m.why.trim() || m.level.trim());
}

function sessionIsEmpty(s: LearningSessionNote): boolean {
  return !(s.summary.trim() || s.next_focus.trim());
}

function journalIsEmpty(j: LearningJournal): boolean {
  return missionIsEmpty(j.mission) && sessionIsEmpty(j.last_session) && j.records.length === 0;
}

function missionFromDict(raw: unknown): LearningMission {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptyMission();
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => String(v ?? "").trim();
  return {
    topic: str(r.topic),
    why: str(r.why),
    level: str(r.level),
    updated_at: str(r.updated_at),
  };
}

function sessionFromDict(raw: unknown): LearningSessionNote {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptySession();
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => String(v ?? "").trim();
  return {
    summary: str(r.summary),
    next_focus: str(r.next_focus),
    updated_at: str(r.updated_at),
  };
}

function recordFromDict(raw: unknown): LearningRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  const title = String(r.title ?? "").trim();
  const insight = String(r.insight ?? "").trim();
  if (!id || !(title || insight)) return null;
  return { id, title, insight, created_at: String(r.created_at ?? "").trim() };
}

function journalFromDict(raw: unknown): LearningJournal {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: JOURNAL_VERSION, updated_at: "", mission: emptyMission(), last_session: emptySession(), records: [] };
  }
  const r = raw as Record<string, unknown>;
  const records: LearningRecord[] = [];
  for (const item of Array.isArray(r.records) ? r.records : []) {
    const parsed = recordFromDict(item);
    if (parsed) records.push(parsed);
  }
  return {
    version: Number(r.version ?? 1) || 1,
    updated_at: String(r.updated_at ?? "").trim(),
    mission: missionFromDict(r.mission),
    last_session: sessionFromDict(r.last_session),
    records,
  };
}

function journalToDict(j: LearningJournal): Record<string, unknown> {
  return {
    version: j.version,
    updated_at: j.updated_at,
    mission: { ...j.mission },
    last_session: { ...j.last_session },
    records: j.records.map((r) => ({ ...r })),
  };
}

function clip(text: unknown, limit: number): string {
  const cleaned = String(text ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (cleaned.length <= limit) return cleaned;
  return cleaned.slice(0, Math.max(0, limit - 1)).replace(/\s+$/, "") + "…";
}

function normalizeKey(...parts: string[]): string {
  return parts.join(" ").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

export interface JournalWriteResult {
  accepted: boolean;
  message: string;
  journal: LearningJournal;
  record_id?: string;
  deduplicated?: boolean;
}

/** Atomic JSON write (tmp + rename), mirroring file_io.atomic_write_json. */
function atomicWriteJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tmp, path);
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch { /* ignore */ }
  }
}

export class LearningJournalStore {
  private readonly settings: Settings;

  constructor(settings?: Settings) {
    this.settings = settings ?? get_settings();
  }

  journalPath(): string {
    // Upstream resolves via PathService.get_learning_journal_file(); the TS
    // backend keeps per-install state under data_dir.
    return join(this.settings.data_dir, "learning_journal.json");
  }

  load(): LearningJournal {
    const path = this.journalPath();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: JOURNAL_VERSION, updated_at: "", mission: emptyMission(), last_session: emptySession(), records: [] };
      }
      throw e;
    }
    // Never reinterpret corruption as an empty aggregate before a write.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid or unsupported learning journal; original file preserved");
    }
    const obj = raw as Record<string, unknown>;
    if (Number(obj.version ?? 1) !== JOURNAL_VERSION) {
      throw new Error("Invalid or unsupported learning journal; original file preserved");
    }
    if (!Array.isArray(obj.records ?? [])) {
      throw new Error("Invalid learning journal records; original file preserved");
    }
    for (const key of ["mission", "last_session"] as const) {
      const value = obj[key] ?? {};
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid learning journal ${key}; original file preserved`);
      }
      for (const v of Object.values(value as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new Error(`Invalid learning journal ${key}; original file preserved`);
        }
      }
    }
    for (const record of (obj.records ?? []) as unknown[]) {
      if (recordFromDict(record) === null) {
        throw new Error("Invalid learning record; original file preserved");
      }
    }
    const journal = journalFromDict(raw);
    journal.version = JOURNAL_VERSION;
    return journal;
  }

  statusMarkdown(recentRecords = 8): string {
    const journal = this.load();
    if (journalIsEmpty(journal)) {
      return (
        "(No learning journal yet. When the user wants to learn a topic " +
        "across sessions, call learning_update with op=set_mission, then " +
        "note_session / add_record as you teach. Prefer this soft journal " +
        "for free-form multi-session study; use Mastery Path tools for " +
        "hard curriculum gates.)\n"
      );
    }
    const lines: string[] = ["# Learning journal", ""];
    if (!missionIsEmpty(journal.mission)) {
      lines.push("## Mission");
      lines.push(...LearningJournalStore.missionLines(journal.mission));
      lines.push("");
    }
    if (!sessionIsEmpty(journal.last_session)) {
      lines.push("## Last session");
      lines.push(...LearningJournalStore.sessionLines(journal.last_session));
      lines.push("");
    }
    if (journal.records.length) {
      lines.push("## Recent learning records");
      for (const record of [...journal.records].slice(-Math.max(1, recentRecords)).reverse()) {
        const title = record.title || "(untitled)";
        lines.push(`- \`${record.id}\` **${title}**: ${record.insight}`);
      }
      lines.push("");
    }
    lines.push(
      "_Use Mastery Path (`mastery_status` / Guided Learning) for scored " +
        "curriculum progress; this journal is the soft mission + insight layer._",
    );
    return lines.join("\n").replace(/\s+$/, "") + "\n";
  }

  /** Read-only public snapshot, including the exact injected slice (#1407). */
  overview(): Record<string, unknown> {
    const journal = this.load();
    const snapshot = journalToDict(journal) as Record<string, unknown>;
    snapshot.records = [...journal.records].reverse().map((r) => ({ ...r }));
    snapshot.injected_context = this.injectionMarkdown(journal);
    return snapshot;
  }

  /** The resumable slice of the journal for the per-turn system prompt. */
  injectionMarkdown(journal?: LearningJournal): string {
    const j = journal ?? this.load();
    const parts: string[][] = [];
    const missionLines = LearningJournalStore.missionLines(j.mission);
    if (missionLines.length) parts.push(["## Mission", ...missionLines]);
    const sessionLines = LearningJournalStore.sessionLines(j.last_session);
    if (sessionLines.length) parts.push(["## Last session", ...sessionLines]);
    if (!parts.length) return "";
    const body = parts.map((p) => p.join("\n")).join("\n\n");
    return (
      "# Learning journal (carried over from earlier sessions)\n\n" +
      `${body}\n\n` +
      "_Pick up from where this leaves off, and record what this session " +
      "changes with `learning_update`._\n"
    );
  }

  private static missionLines(mission: LearningMission): string[] {
    const lines: string[] = [];
    if (mission.topic) lines.push(`- Topic: ${mission.topic}`);
    if (mission.why) lines.push(`- Why: ${mission.why}`);
    if (mission.level) lines.push(`- Level: ${mission.level}`);
    if (mission.updated_at) lines.push(`- Updated: ${mission.updated_at}`);
    return lines;
  }

  private static sessionLines(session: LearningSessionNote): string[] {
    const lines: string[] = [];
    if (session.summary) lines.push(`- Summary: ${session.summary}`);
    if (session.next_focus) lines.push(`- Next focus: ${session.next_focus}`);
    if (session.updated_at) lines.push(`- Updated: ${session.updated_at}`);
    return lines;
  }

  setMission(args: { topic: string; why?: string; level?: string }): JournalWriteResult {
    const topic = clip(args.topic, MAX_TOPIC_CHARS);
    const why = clip(args.why ?? "", MAX_WHY_CHARS);
    const level = clip(args.level ?? "", MAX_LEVEL_CHARS);
    if (!topic) {
      return { accepted: false, message: "set_mission requires a non-empty topic.", journal: this.load() };
    }
    return this.mutate((journal) => {
      journal.mission = { topic, why, level, updated_at: journal.updated_at };
      return {
        accepted: true,
        message: `mission set for topic=${JSON.stringify(topic)}.`,
        journal,
      };
    });
  }

  noteSession(args: { summary: string; next_focus?: string }): JournalWriteResult {
    const summary = clip(args.summary, MAX_SUMMARY_CHARS);
    const nextFocus = clip(args.next_focus ?? "", MAX_NEXT_FOCUS_CHARS);
    if (!summary && !nextFocus) {
      return {
        accepted: false,
        message: "note_session requires summary and/or next_focus.",
        journal: this.load(),
      };
    }
    return this.mutate((journal) => {
      journal.last_session = { summary, next_focus: nextFocus, updated_at: journal.updated_at };
      return { accepted: true, message: "session note saved.", journal };
    });
  }

  addRecord(args: { title: string; insight: string }): JournalWriteResult {
    let title = clip(args.title, MAX_TITLE_CHARS);
    const insight = clip(args.insight, MAX_INSIGHT_CHARS);
    if (!insight) {
      return { accepted: false, message: "add_record requires a non-empty insight.", journal: this.load() };
    }
    if (!title) title = clip(insight, 60);
    return this.mutate((journal) => {
      const key = normalizeKey(title, insight);
      for (const existing of journal.records) {
        if (normalizeKey(existing.title, existing.insight) === key) {
          return {
            accepted: true,
            message: `record already saved (id=${existing.id}); skipped duplicate.`,
            journal,
            record_id: existing.id,
            deduplicated: true,
          };
        }
      }
      const nextN = this.nextRecordNumber(journal);
      const recordId = `lr_${String(nextN).padStart(4, "0")}`;
      journal.records.push({ id: recordId, title, insight, created_at: journal.updated_at });
      if (journal.records.length > MAX_RECORDS) {
        journal.records = journal.records.slice(-MAX_RECORDS);
      }
      return {
        accepted: true,
        message: `record added (id=${recordId}).`,
        journal,
        record_id: recordId,
      };
    });
  }

  private nextRecordNumber(journal: LearningJournal): number {
    let highest = 0;
    for (const record of journal.records) {
      const suffix = record.id.replace(/^lr_/, "");
      if (/^\d+$/.test(suffix)) highest = Math.max(highest, Number.parseInt(suffix, 10));
    }
    return highest + 1;
  }

  private mutate(mutator: (journal: LearningJournal) => JournalWriteResult): JournalWriteResult {
    const path = this.journalPath();
    // Node is single-threaded and every step is synchronous, so the Python
    // threading.Lock + fcntl.flock pair collapses to a plain read-modify-write.
    const journal = this.load();
    journal.updated_at = utcNow();
    const result = mutator(journal);
    if (!result.accepted) return result;
    if (!result.deduplicated) {
      atomicWriteJson(path, journalToDict(result.journal));
    }
    return result;
  }
}

let _store: LearningJournalStore | null = null;

export function get_learning_journal_store(): LearningJournalStore {
  if (_store === null) _store = new LearningJournalStore();
  return _store;
}

export const getLearningJournalStore = get_learning_journal_store;
