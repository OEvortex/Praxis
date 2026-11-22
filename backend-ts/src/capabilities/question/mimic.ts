// Port of deeptutor/agents/question/mimic_source.py +
// tools/question/question_extractor.py — exam-paper → QuizTemplate[] for
// mimic mode.
//
// paper_mode:
//   "parsed" — paper_path is a previously-parsed working dir; look for an
//     existing ``*_questions.json`` first, else find the parsed markdown
//     (``auto/`` / ``hybrid_auto/`` subdir or any dir containing *.md) and run
//     the LLM question extractor, writing the JSON next to the paper.
//   "upload" — paper_path is a freshly-uploaded PDF. Upstream parses it with
//     MinerU; the TS backend has no MinerU port, so this falls back to the
//     shared best-effort PDF text extractor and feeds the text straight into
//     the same LLM extraction prompt.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Settings } from "../../config.js";
import { get_settings } from "../../config.js";
import { resolve } from "node:path";
import { completeText } from "../../services/llm_text.js";
import { pdfExtractText, MAX_EXTRACTED_CHARS_PER_DOC } from "../../services/kb_connectors/files.js";
import type { QuizTemplate } from "./pipeline.js";

const VALID_QUESTION_TYPES = new Set([
  "choice",
  "concept",
  "fill_in_blank",
  "short_answer",
  "written",
  "coding",
]);
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const TOPIC_CLIP_CHARS = 240;
const DEFAULT_DIFFICULTY = "medium";
const DEFAULT_QUESTION_TYPE = "written";

function coerceQuestionType(raw: unknown): string {
  const v = String(raw ?? "").trim().toLowerCase();
  return VALID_QUESTION_TYPES.has(v) ? v : DEFAULT_QUESTION_TYPE;
}

function coerceDifficulty(raw: unknown): string {
  const v = String(raw ?? "").trim().toLowerCase();
  return VALID_DIFFICULTIES.has(v) ? v : DEFAULT_DIFFICULTY;
}

function clipChars(s: string, n: number): string {
  return [...s].slice(0, Math.max(0, n)).join("");
}

// -- filesystem helpers -------------------------------------------------------

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Locate the directory holding the parsed markdown (upstream
 *  ``_find_parsed_content_dir``): prefer ``auto`` / ``hybrid_auto``, then any
 *  immediate child dir, then dirs found by scanning for ``*.md``. */
function findParsedContentDir(paperDir: string): string {
  const candidates: string[] = [];
  for (const preferred of ["auto", "hybrid_auto"]) {
    const p = join(paperDir, preferred);
    if (isDir(p) && !candidates.includes(p)) candidates.push(p);
  }
  for (const child of listDir(paperDir).sort()) {
    const p = join(paperDir, child);
    if (isDir(p) && !candidates.includes(p)) candidates.push(p);
  }
  // Nested artifact dirs (rglob equivalent, depth-limited).
  const nested = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const name of listDir(dir)) {
      const p = join(dir, name);
      if (!isDir(p)) continue;
      try {
        if (readdirSync(p).some((f) => f.endsWith(".md") || f.endsWith("_content_list.json"))) {
          nested.add(p);
        }
      } catch { /* ignore */ }
      walk(p, depth + 1);
    }
  };
  walk(paperDir, 0);
  for (const p of [...nested].sort()) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  for (const c of candidates) {
    if (listDir(c).some((f) => f.endsWith(".md"))) return c;
  }
  return candidates[0] ?? paperDir;
}

function findQuestionsJson(dir: string): string | null {
  const direct = listDir(dir)
    .filter((f) => f.endsWith("_questions.json"))
    .sort();
  if (direct.length) return join(dir, direct[0]);
  return null;
}

interface ExtractedQuestion {
  question_number?: string;
  question_text?: string;
  question_type?: string;
  difficulty?: string;
  answer?: string;
  images?: string[];
}

const EXTRACTOR_SYSTEM = `You are a professional exam paper analysis assistant. Your task is to extract all question information from the provided exam paper content.

Please carefully analyze the exam paper content and extract the following information for each question:
1. Question number (e.g., "1.", "Question 1", etc.)
2. Complete question text content (if multiple choice, include all options)
3. Question type — classify into EXACTLY ONE of the canonical types below
4. Difficulty — your best estimate: "easy", "medium", or "hard"
5. Reference answer — if the paper includes an answer key / solution for this
   question, copy it; otherwise use an empty string ""
6. Related image file names (if the question references images)

Canonical question types (the "question_type" field MUST be one of these exact strings):
- "choice": multiple-choice with discrete options (A/B/C/D). Merge stem + all options into question_text.
- "concept": a true/false proposition the learner judges (statement, not "which of the following...").
- "fill_in_blank": the stem has a blank to fill in with a word or short phrase.
- "short_answer": a conceptual question whose expected answer is a few sentences.
- "written": a longer essay, proof, or multi-step derivation.
- "coding": a programming / algorithm question expecting code or pseudocode.

Please return results in JSON format as follows:
\`\`\`json
{
    "questions": [
        {
            "question_number": "1",
            "question_text": "Complete question content (including options)...",
            "question_type": "choice",
            "difficulty": "medium",
            "answer": "B",
            "images": ["image_001.jpg", "image_002.jpg"]
        }
    ]
}
\`\`\`

Important Notes:
1. Ensure all questions are extracted, do not miss any
2. Keep the original question text, do not modify or summarize
3. For multiple choice questions, must merge stem and options in question_text
4. "question_type" MUST be exactly one of: choice, concept, fill_in_blank, short_answer, written, coding
5. "difficulty" MUST be exactly one of: easy, medium, hard
6. If no answer key is present in the paper, set "answer" to ""
7. If a question has no associated images, set images field to empty array []
8. Image file names should be actual existing file names
9. Ensure the returned format is valid JSON`;

/** extract_questions_with_llm — single LLM call over the paper text. */
async function extractQuestionsWithLlm(
  markdownContent: string,
  settings: Settings,
): Promise<ExtractedQuestion[]> {
  const imageList: string[] = [];
  const userPrompt = `Exam paper content (Markdown format):

${clipChars(markdownContent, 15000)}

Available image files:
${JSON.stringify(imageList, null, 2)}

Please analyze the above exam paper content, extract all question information, and return in JSON format.`;

  const text = await completeText(settings, {
    system: EXTRACTOR_SYSTEM,
    prompt: userPrompt,
  });
  const data = parseJsonObject(text);
  const questions = (data as Record<string, unknown> | null)?.["questions"];
  return Array.isArray(questions) ? (questions as ExtractedQuestion[]) : [];
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  try {
    const parsed = JSON.parse(t);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch { /* fall through */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const candidate = fence ? fence[1].trim() : t;
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, findJsonEnd(candidate, start) + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function saveQuestionsJson(
  questions: ExtractedQuestion[],
  outputDir: string,
  paperName: string,
): string {
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const file = join(outputDir, `${paperName}_${stamp}_questions.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        paper_name: paperName,
        extraction_time: new Date().toISOString(),
        total_questions: questions.length,
        questions,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

function questionsFromPayload(payload: Record<string, unknown>): ExtractedQuestion[] {
  const list = payload["questions"];
  return Array.isArray(list) ? (list as ExtractedQuestion[]) : [];
}

/** Run the LLM extractor over markdown text and persist the questions JSON
 *  into ``outputDir`` (mirrors extract_questions_from_paper). */
async function extractFromMarkdown(
  markdown: string,
  paperDir: string,
  outputDir: string,
  settings: Settings,
): Promise<ExtractedQuestion[]> {
  const questions = await extractQuestionsWithLlm(markdown, settings);
  if (!questions.length) return [];
  saveQuestionsJson(questions, outputDir, basename(paperDir));
  return questions;
}

export interface MimicParseResult {
  templates: QuizTemplate[];
  trace: Record<string, string>;
}

/**
 * Resolve an exam paper into mimic QuizTemplates.
 * ``paperPath`` is a PDF path (upload mode) or a parsed working dir.
 */
export async function parseExamPaperToTemplates(
  paperPath: string,
  opts: {
    maxQuestions: number;
    paperMode: "upload" | "parsed";
    outputDir: string;
    settings?: Settings;
    onProgress?: (line: string) => void;
  },
): Promise<MimicParseResult> {
  const settings = opts.settings ?? get_settings();
  const maxQuestions = Math.max(1, Math.trunc(opts.maxQuestions || 1));
  const outputDir = resolve(opts.outputDir);
  mkdirSync(outputDir, { recursive: true });

  let workingDir = paperPath;
  let questionsDir = paperPath;
  let markdownSource = "";

  if (opts.paperMode === "parsed") {
    workingDir = paperPath;
    questionsDir = paperPath;
  } else {
    // upload: best-effort text extraction stands in for the MinerU parse.
    opts.onProgress?.("Extracting text from uploaded PDF...");
    const data = readFileSync(paperPath);
    markdownSource = pdfExtractText(new Uint8Array(data), MAX_EXTRACTED_CHARS_PER_DOC);
    if (!markdownSource.trim()) {
      throw new Error(
        "Could not extract text from the uploaded PDF. Scanned/image-only PDFs " +
          "need the document-parsing pipeline (MinerU), which is not ported yet.",
      );
    }
    // The batch dir doubles as the parsed working dir for upload mode.
    workingDir = outputDir;
    questionsDir = outputDir;
  }

  // Existing extraction output wins (parsed mode re-runs, or a previous
  // upload already produced questions JSON in the batch dir).
  let questionsJson = findQuestionsJson(questionsDir);
  let questions: ExtractedQuestion[] = [];
  let questionFile = "";

  if (questionsJson) {
    try {
      questions = questionsFromPayload(JSON.parse(readFileSync(questionsJson, "utf-8")) as Record<string, unknown>);
      questionFile = questionsJson;
    } catch {
      questions = [];
    }
  }

  if (!questions.length && !markdownSource) {
    // parsed mode: find markdown under the working dir and extract.
    const contentDir = findParsedContentDir(workingDir);
    const mdFile = listDir(contentDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join(contentDir, f))[0];
    if (!mdFile) {
      throw new Error("No parsed markdown found in the exam paper directory.");
    }
    markdownSource = readFileSync(mdFile, "utf-8");
    opts.onProgress?.(`Extracting questions from ${basename(mdFile)}...`);
    questions = await extractFromMarkdown(markdownSource, workingDir, questionsDir, settings);
    questionFile = findQuestionsJson(questionsDir) ?? "";
  } else if (!questions.length && markdownSource) {
    opts.onProgress?.("Extracting questions from exam paper...");
    questions = await extractFromMarkdown(markdownSource, workingDir, questionsDir, settings);
    questionFile = findQuestionsJson(questionsDir) ?? "";
  }

  if (!questions.length) {
    throw new Error("No questions could be extracted from the exam paper.");
  }
  if (questions.length > maxQuestions) questions = questions.slice(0, maxQuestions);

  const templates: QuizTemplate[] = [];
  for (const [idx, item] of questions.entries()) {
    const qText = String(item?.question_text ?? "").trim();
    if (!qText) continue;
    templates.push({
      question_id: `q_${idx + 1}`,
      topic: clipChars(qText, TOPIC_CLIP_CHARS),
      question_type: coerceQuestionType(item?.question_type),
      difficulty: coerceDifficulty(item?.difficulty),
      source: "mimic",
      reference_question: qText,
      reference_answer: String(item?.answer ?? "").trim() || null,
    });
  }

  return {
    templates,
    trace: {
      paper_dir: workingDir,
      question_file: questionFile,
      template_count: String(templates.length),
    },
  };
}
