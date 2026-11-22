// spaced repetition for flashcards
// (the question bank), feeding the calendar's Reviews layer.
//
// Every question-bank entry with no schedule yet gets a first review one day
// after it was created. Correct answers advance a Leitner box with growing
// intervals (1, 3, 7, 14, 30, 60 days); "again" resets to box 1. Both the bank
// and the review state live in the shared SQLite kv store (keys
// `question_bank` and `reviews`), keyed by a hash of the question text.
import { createHash } from "node:crypto";
import { get_settings } from "../config.js";
import { get_state, put_state } from "../store/database.js";

// Days between reviews per box, 1-indexed.
export const INTERVALS_DAYS = [1, 3, 7, 14, 30, 60] as const;
export const MAX_BOX = INTERVALS_DAYS.length;

export interface ReviewCard {
  created: number;
  due_at: number;
  box: number;
  last_at: number | null;
  [k: string]: unknown;
}

export interface DueReview {
  key: string;
  question: string;
  answer: string;
  topic: string;
  box: number;
  due_at: number;
}

export interface ReviewSummary {
  cards: number;
  boxes: Record<string, number>;
  due_now: number;
}

type BankEntry = Record<string, unknown>;
type ReviewState = Record<string, ReviewCard>;

function loadBank(): BankEntry[] {
  const bank = get_state<unknown>(get_settings(), "question_bank", []);
  return Array.isArray(bank) ? (bank as BankEntry[]) : [];
}

function loadState(): ReviewState {
  const state = get_state<unknown>(get_settings(), "reviews", {});
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return state as ReviewState;
  }
  return {};
}

function saveState(state: ReviewState): void {
  put_state(get_settings(), "reviews", state);
}

export function keyFor(question: string): string {
  return createHash("sha1").update((question ?? "").trim(), "utf-8").digest("hex").slice(0, 16);
}

function makeCard(created: number, dueAt: number, box = 1, lastAt: number | null = null): ReviewCard {
  return { created, due_at: dueAt, box, last_at: lastAt };
}

/** Register question-bank entries that are not scheduled yet. */
export function sync(): ReviewState {
  const bank = loadBank();
  const state = loadState();
  const now = Date.now() / 1000;
  let changed = false;
  for (const entry of bank) {
    const question = String(entry.q ?? "").trim();
    if (!question) continue;
    const key = keyFor(question);
    if (key in state) continue;
    const created = Number(entry.created ?? 0) || now;
    state[key] = makeCard(created, created + 86400, 1);
    changed = true;
  }
  // Cards whose question disappeared are dropped (the bank is the source of
  // truth for content; state only tracks scheduling).
  const live = new Set(
    bank
      .map((e) => String(e.q ?? "").trim())
      .filter(Boolean)
      .map((q) => keyFor(q)),
  );
  for (const key of Object.keys(state)) {
    if (!live.has(key)) {
      delete state[key];
      changed = true;
    }
  }
  if (changed) saveState(state);
  return state;
}

/** Cards due in `[startTs, endTs)`, with their question text. */
export function dueBetween(startTs: number, endTs: number): DueReview[] {
  const state = sync();
  const bank = loadBank();
  const questionByKey = new Map<string, BankEntry>();
  for (const e of bank) {
    const q = String(e.q ?? "");
    if (q) questionByKey.set(keyFor(q), e);
  }
  const out: DueReview[] = [];
  for (const [key, card] of Object.entries(state)) {
    const due = Number(card.due_at ?? 0) || 0;
    if (startTs <= due && due < endTs) {
      const entry = questionByKey.get(key);
      out.push({
        key,
        question: entry ? String(entry.q ?? "") : "",
        answer: entry ? String(entry.a ?? "") : "",
        topic: entry ? String(entry.topic ?? "") : "",
        box: Math.trunc(Number(card.box ?? 1)) || 1,
        due_at: due,
      });
    }
  }
  return out.sort((a, b) => a.due_at - b.due_at);
}

/** Record one review; returns the card's new state. Throws if key unknown. */
export function grade(key: string, correct: boolean): ReviewCard {
  const state = sync();
  const card = state[key];
  if (card == null) throw new Error(`unknown review key: ${key}`);
  const now = Date.now() / 1000;
  if (correct) {
    card.box = Math.min(Math.trunc(Number(card.box ?? 1)) + 1 || 1, MAX_BOX);
    card.due_at = now + INTERVALS_DAYS[card.box - 1] * 86400;
  } else {
    card.box = 1;
    card.due_at = now + INTERVALS_DAYS[0] * 86400;
  }
  card.last_at = now;
  const fresh = loadState();
  fresh[key] = card;
  saveState(fresh);
  return card;
}

/** Counts by box and how many are due now, for tool/REST consumers. */
export function summary(): ReviewSummary {
  const state = sync();
  const now = Date.now() / 1000;
  const boxes: Record<string, number> = {};
  for (let i = 1; i <= MAX_BOX; i++) boxes[String(i)] = 0;
  let dueNow = 0;
  for (const card of Object.values(state)) {
    const rawBox = Math.trunc(Number(card.box ?? 1)) || 1;
    const box = Math.min(Math.max(rawBox, 1), MAX_BOX);
    boxes[String(box)] = (boxes[String(box)] ?? 0) + 1;
    if ((Number(card.due_at ?? 0) || 0) <= now) dueNow += 1;
  }
  return { cards: Object.keys(state).length, boxes, due_now: dueNow };
}
