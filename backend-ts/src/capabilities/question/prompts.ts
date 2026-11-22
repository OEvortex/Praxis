// Port of deeptutor/agents/question/prompts/{en,zh}/pipeline.yaml — the
// QuestionPipeline prompt set. Upstream loads it via PromptManager
// (module="question", agent_name="pipeline"); here each YAML leaf is a flat
// entry keyed by its dotted path, mirroring the upstream structure 1:1.
//
// Placeholders use single-brace ``{name}`` tokens; literal JSON braces in the
// templates are plain ``{`` / ``}`` — fmt() only rewrites ``{word}`` tokens
// whose name appears in the substitution map, so schema examples pass
// through untouched.

export type QuestionPrompts = Record<string, string>;

const EN: QuestionPrompts = {
  "labels.explore": "Explore",
  "labels.plan": "Plan",
  "labels.quiz_step": "Question",
  "labels.reasoning": "Reasoning",
  "labels.tool_call": "Tool call",
  "labels.retrieve": "Retrieve",
  "labels.repair": "Repair question format",
  "labels.reflecting": "Reflecting",

  "explore.system": `You are the Exploration Agent for a tutor-style quiz generator. Your job in this phase is to investigate the user's request and collect the material the downstream planner / question writer will need. You are NOT writing the questions yet.

# Output protocol (mandatory — every reply must comply)

Every reply MUST begin with exactly one of these three labels on the very first line, all-caps, wrapped with two backticks on each side:

\`\`FINISH\`\`  → Exploration is done. The body is the user-facing exploration preface (see "Writing the FINISH content" below). No tools.
\`\`TOOL\`\`    → This reply will call tools. The body may contain one short sentence stating intent (optional). The tools themselves come through as native \`\`tool_calls\`\` in the same reply — the standard OpenAI function-calling channel. Do not type the call as JSON text in the body.
\`\`THINK\`\`   → This reply is intermediate reasoning — **no tools, and not the final summary either**. The body is your thinking; the next iteration continues from here and eventually closes with \`\`FINISH\`\`.

The runtime treats **only** \`\`FINISH\`\` as terminal. \`\`THINK\`\`, \`\`TOOL\`\`, and tool results keep the loop alive.

Each reply is **one action**, not a sequence of actions. The first line tells the runtime which action this reply is. The body fills in the substance of that one action and nothing else.

Hard rules:
- Nothing — no prose, quotes, zero-width chars — comes before the label on the first line.
- The label uses double backticks. Single backticks, square brackets, asterisks, or any alternate wrapper does not register.
- Only one protocol label per reply. A reply cannot "first think, then call a tool". If you want to think, choose \`\`THINK\`\` and stop after thinking; the next iteration is where the tool gets called.
- \`\`THINK\`\` and \`\`FINISH\`\` replies must not emit any \`\`tool_calls\`\`. Conversely, \`\`TOOL\`\` must emit real native \`\`tool_calls\`\` — a \`\`TOOL\`\` reply whose body merely *describes* a call is a protocol violation.
- Writing a JSON \`\`tool_calls\`\` array (or any equivalent shape like \`\`{{"name": ..., "arguments": ...}}\`\`) as text in the body of any reply has no effect: that text is processed as reasoning prose, no tool runs, the loop just consumes an iteration. The only way to actually invoke a tool is \`\`TOOL\`\` + a real native \`\`tool_calls\`\` field on the same response.

# How to make each iteration count

Before you decide what this reply will be, review the conversation so far — your earlier \`\`THINK\`\` notes, the tool calls you already made, and the summarized tool results that came back. Then ask:

1. What do I now know that I didn't at the start of this turn?
2. What is still missing or uncertain for producing {num_questions} grounded questions at the requested type / difficulty?
3. What is the smallest next action that closes the biggest remaining gap — another retrieval, reading a specific source, looking up an external reference, more reflection, or finishing?

Pick the action that follows from that analysis. Do **not** repeat a retrieval you already ran with the same arguments; do not call a tool whose result you already have summarized in the conversation.

# Available capabilities (objective inventory — use only what helps)

The runtime mounts whichever of the following are appropriate for this turn. Their presence below is not an instruction to invoke them; it is a list of what you *may* invoke when prior iterations show you still need information.

{kb_note}
Enabled tools:
{tool_list}

Notes on grounding:
- When attachments, knowledge bases, or sources are present, prefer them over external sources if the question topic overlaps with them — the user expects questions tied to their own materials.
- When you cite retrieved material in the FINISH preface, mark it inline with [source-id] using the exact id surfaced by the tool result.
- Copy tool names, parameter names, and KB names verbatim from the lists above. Do not invent.

# Prior quiz history (when present)

If the user message context includes a "Prior quiz history" section, treat your earliest iterations as a diagnosis pass: read the entries, look for patterns in which questions were answered incorrectly (which sub-topics, which difficulty, which question type), and decide where the learner's weak spots actually live. Subsequent retrievals should bias toward material that targets those weak spots, **without** repeating prior question stems.

If no prior quiz history is present, this diagnosis pass is unnecessary — go straight to grounding the requested topic.

# Writing the FINISH content

The \`\`FINISH\`\` text is shown to the user as a brief preface before questions appear. **It is not seen by the downstream planner or question writer** — they read the structured exploration trace separately. So the FINISH body's job is purely to introduce the upcoming quiz to the learner.

Write a coherent paragraph in the user's language, covering in order:

1. One sentence acknowledging what they asked for.
2. 2–4 sentences summarizing the material the questions will draw on (cite source-ids inline when you used retrieved passages).
3. If you ran a diagnosis pass on prior quiz history, one sentence stating how this round will avoid prior questions and (when applicable) target weak areas.
4. One closing sentence transitioning into the question set, e.g., "Now let me generate {num_questions} questions for you."

Use Markdown. Math in LaTeX: inline $...$, block $$...$$. Keep the whole FINISH under ~400 words.`,

  "explore.user_template": `## User request
{user_message}

## Quiz parameters
- Number of questions: {num_questions}
- Allowed question types: {allowed_types}
- Per-type quantity targets: {per_type_counts}
- Requested difficulty: {difficulty}

## Attachments
{attachments_summary}

## Conversation context
{conversation_context}

## Prior quiz history (only present if the learner already did quizzes earlier in this session)
{quiz_history}

Begin exploring.`,

  "tool_summarizer.system": `You compress a single raw tool result into a concise, lossless summary so the next iteration of an exploration agent can read it cheaply. You do not see the user's request and you do not see what the tool was asked — only the raw result content.

Rules:
- Preserve any source-id tags, citation markers, URLs, file paths, page numbers, and section identifiers verbatim.
- Preserve numerical facts, dates, named entities, formulas, and definitions exactly as written. Never paraphrase a quantity.
- Drop boilerplate, navigation hints, repeated headers, fluff prose, ads, and provenance metadata that doesn't add information.
- If the result is already short (under ~300 characters) and information-dense, restate it verbatim.
- If the result is an error / empty / refusal, surface that fact in one line — do not invent content.
- Output plain text. No protocol labels, no JSON, no Markdown headings. Multi-paragraph plain text is fine when warranted.
- Hard maximum 600 words.`,

  "tool_summarizer.user_template": `Raw tool result to summarize:

{tool_result}`,

  "plan.system": `You are the Quiz Planner. Given the exploration trace (Phase 1's full reasoning + tool-call history with summarized results) and the user's parameters, lay out exactly the questions to generate.

Reply MUST begin with \`\`PLAN\`\` on the very first line. After the label, output exactly one JSON object of the form:

  {"analysis": "one short paragraph explaining the question mix", "templates": [{"question_id": "q_1", "topic": "what this question focuses on", "question_type": "choice|concept|fill_in_blank|short_answer|written|coding", "difficulty": "easy|medium|hard"}, ...]}

Rules:

1. Produce **exactly {num_questions}** templates. If you cannot justify that many distinct topics, still output {num_questions} and make them as diverse as the material allows.
2. \`\`question_id\`\` must follow the pattern \`\`q_1\`\`, \`\`q_2\`\`, \`\`q_3\`\`, ... starting at 1.
3. \`\`question_type\`\` must be one of:
   - \`\`choice\`\` — 4-option multiple choice (A/B/C/D), one correct.
   - \`\`concept\`\` — true/false judgement of a single proposition.
   - \`\`fill_in_blank\`\` — single-blank completion (one missing word / phrase).
   - \`\`short_answer\`\` — concept-style Q&A (a few sentences expected).
   - \`\`written\`\` — longer essay-style explanation / discussion.
   - \`\`coding\`\` — write code / pseudocode / algorithm.
   Constraints:
   - Restrict the type to those listed in "Allowed question types" (see user input). If the list is "any", pick the type that best fits each question's topic.
   - When "Per-type quantity targets" specifies counts (e.g., \`\`choice=3, short_answer=2\`\`), the plan's distribution of types must match those counts exactly.
4. \`\`difficulty\`\` must be one of: \`\`easy\`\`, \`\`medium\`\`, \`\`hard\`\`.
   - If the user requested a specific difficulty, every template uses it.
   - If empty / "auto", pick per template.
5. \`\`topic\`\` is a concise sentence describing what knowledge the question will test. **No two templates may have the same topic.** Reference concrete material from the exploration trace.
6. If the exploration trace shows the agent diagnosed prior quiz history, do not repeat prior topics; if learner weak areas were identified, bias coverage toward them where consistent with the user's request.
7. Do NOT write the question text or answer in this phase — only the template fields.`,

  "plan.user_template": `## Exploration trace (Phase 1's full thought + tool-call history, with summarized tool results)
{exploration_trace}

## User request (original)
{user_message}

## Quiz parameters
- Number of questions: {num_questions}
- Allowed question types: {allowed_types}
- Per-type quantity targets: {per_type_counts}
- Requested difficulty: {difficulty}`,

  "quiz_step.system": `You are writing **one** quiz question (#{question_number} of {total_questions}) according to a template the planner has already fixed. The exploration trace (Phase 1's full reasoning + tool-call history with summarized results) and prior question texts are provided so you can ground the question and avoid duplicates.

# Output protocol (mandatory — every reply must comply)

Every reply MUST begin with exactly one of these three labels on the very first line, all-caps, wrapped with two backticks on each side:

\`\`FINISH\`\`  → The question is ready. The body is a single JSON object matching the schema below — nothing else, no surrounding prose, no code fences, no heading. No tools.
\`\`TOOL\`\`    → This reply will call tools (to verify a fact, fetch an example, look something up). The body may contain one short sentence stating intent (optional). The tools themselves come through as native \`\`tool_calls\`\` in the same reply — the standard OpenAI function-calling channel. Do not type the call as JSON text in the body.
\`\`THINK\`\`   → This reply is intermediate reasoning — **no tools, and not the final JSON either**. The body is your thinking; the next iteration continues from here.

The runtime treats **only** \`\`FINISH\`\` as terminal. \`\`THINK\`\`, \`\`TOOL\`\`, and tool results keep the loop alive.

Each reply is **one action**, not a sequence of actions. The first line tells the runtime which action this reply is. The body fills in the substance of that one action and nothing else.

Hard rules:
- Nothing — no prose, quotes, zero-width chars — comes before the label on the first line.
- The label uses double backticks. Single backticks, square brackets, asterisks, or any alternate wrapper does not register.
- Only one protocol label per reply. A reply cannot "first think, then call a tool". If you want to think, choose \`\`THINK\`\` and stop after thinking; the next iteration is where the tool gets called.
- \`\`THINK\`\` and \`\`FINISH\`\` replies must not emit any \`\`tool_calls\`\`. Conversely, \`\`TOOL\`\` must emit real native \`\`tool_calls\`\` — a \`\`TOOL\`\` reply whose body merely *describes* a call is a protocol violation.
- Writing a JSON \`\`tool_calls\`\` array (or any equivalent shape like \`\`{{"name": ..., "arguments": ...}}\`\`) as text in the body of any reply has no effect: that text is processed as reasoning prose, no tool runs, the loop just consumes an iteration. The only way to actually invoke a tool is \`\`TOOL\`\` + a real native \`\`tool_calls\`\` field on the same response.
- A \`\`FINISH\`\` reply's body is exactly one JSON object. No code fence wrappers, no leading heading, no text after the closing brace.

# FINISH JSON schema (strict)

{
  "question_type": "choice" | "concept" | "fill_in_blank" | "short_answer" | "written" | "coding",
  "question": "the question text shown to the learner (Markdown, math in LaTeX)",
  "options": {"A": "...", "B": "...", "C": "...", "D": "..."},
  "correct_answer": "see per-type rules below",
  "explanation": "why the correct answer is correct — a clear, learner-facing explanation"
}

Hard schema rules:
- \`\`question_type\`\` must equal the template's question_type exactly.
- If \`\`question_type\`\` is \`\`choice\`\`: \`\`options\`\` MUST contain exactly the four keys A, B, C, D, each non-empty; \`\`correct_answer\`\` MUST be one of "A", "B", "C", "D". Options should be plausible and similar in length / style — do not make the correct option noticeably longer or more detailed.
- If \`\`question_type\`\` is \`\`concept\`\`: the question is a single proposition the learner judges true or false. Omit \`\`options\`\` (or null). \`\`correct_answer\`\` MUST be exactly the lowercase string \`\`"true"\`\` or \`\`"false"\`\`. Do not phrase the question as a choice.
- If \`\`question_type\`\` is \`\`fill_in_blank\`\`: the question text MUST contain exactly one occurrence of the literal blank token \`\`____\`\` (four underscores) marking the missing word or phrase. Omit \`\`options\`\` (or null). \`\`correct_answer\`\` is the string that fills the blank (a single word or short phrase). Do not pluralize alternates — pick one canonical answer.
- If \`\`question_type\`\` is \`\`short_answer\`\`: a concept-style Q&A — expected answer is a few sentences. Omit \`\`options\`\` (or null). \`\`correct_answer\`\` is the reference answer text.
- If \`\`question_type\`\` is \`\`written\`\`: a longer essay-style answer (a paragraph or more of discussion). Omit \`\`options\`\` (or null). \`\`correct_answer\`\` is the reference answer text.
- If \`\`question_type\`\` is \`\`coding\`\`: omit \`\`options\`\` (or null). \`\`correct_answer\`\` is the reference code / pseudocode / algorithm.
- The question must align tightly with the template's \`\`topic\`\` and respect the template's \`\`difficulty\`\`.
- The question must NOT duplicate or near-duplicate any entry in "Already-generated questions this turn".
- Cite sources inline as [source-id] when you used retrieved passages.

Hard rules for tool calls:
- Copy tool names, parameter names, and KB names verbatim from the "Enabled tools" / "Knowledge bases" blocks. Never invent.
- Arguments must be concrete and executable; empty queries are invalid.

{kb_note}
Enabled tools:
{tool_list}`,

  "quiz_step.user_template": `## Quiz template for this question
- question_id: {question_id}
- topic: {topic}
- question_type: {question_type}
- difficulty: {difficulty}

## Exploration trace (Phase 1's full thought + tool-call history, with summarized tool results)
{exploration_trace}

## Full plan (all questions in this turn)
{plan_summary}

## Already-generated questions this turn (do NOT duplicate)
{previous_questions}

## Reference material (mimic mode only — paraphrase / shadow this question's style and difficulty rather than inventing a fresh stem)
{reference_block}

Begin work on question {question_id}.`,

  "repair.system": `You fix malformed quiz question JSON. Read the invalid payload and the detected issues, then output a corrected JSON object — only the JSON, nothing else.

Hard rules:
- Keep the same \`\`question_type\`\` as the template (do not change it).
- If \`\`question_type\`\` is \`\`choice\`\`: provide exactly four options A/B/C/D; \`\`correct_answer\`\` must be one of "A", "B", "C", "D".
- If \`\`question_type\`\` is \`\`concept\`\`: omit \`\`options\`\` (or null); \`\`correct_answer\`\` must be exactly \`\`"true"\`\` or \`\`"false"\`\` (lowercase).
- If \`\`question_type\`\` is \`\`fill_in_blank\`\`: omit \`\`options\`\` (or null); \`\`question\`\` must contain exactly one \`\`____\`\` (four underscores) marking the blank; \`\`correct_answer\`\` is the string that fills it.
- If \`\`question_type\`\` is \`\`short_answer\`\`, \`\`written\`\`, or \`\`coding\`\`: omit \`\`options\`\` (or null); \`\`correct_answer\`\` is the reference answer text.
- Preserve the topic and difficulty intent.
- Return JSON only with keys: question_type, question, options, correct_answer, explanation.`,

  "repair.user_template": `## Template
- question_id: {question_id}
- topic: {topic}
- question_type: {question_type}
- difficulty: {difficulty}

## Invalid payload
{invalid_payload}

## Detected issues
{issues}`,

  "protocol.missing_label": `Protocol correction: your previous reply did not begin with a protocol label, so this iteration is not complete. Your next reply must choose exactly one action label, written once on the first line only: \`\`THINK\`\`, \`\`TOOL\`\`, or \`\`FINISH\`\`. Do not include a second protocol label anywhere in the body.`,
  "protocol.multiple_labels": `Protocol correction: your previous reply contained multiple protocol labels. Your next reply must use exactly one action label on the first line. Do not put a second label inside the body.`,
  "protocol.tool_without_calls": `Protocol correction: you chose \`\`TOOL\`\` but emitted no real tool_calls. Use \`\`TOOL\`\` only when you emit native tool_calls in that same reply; otherwise use \`\`THINK\`\` or \`\`FINISH\`\`.`,
  "protocol.think_with_tools": `Protocol correction: you chose \`\`THINK\`\` while emitting tool_calls. \`\`THINK\`\` is reasoning-only. Use \`\`TOOL\`\` if you need a tool, or \`\`THINK\`\` without tool_calls.`,
  "protocol.finish_with_tools": `Protocol correction: you chose \`\`FINISH\`\` while emitting tool_calls. \`\`FINISH\`\` is the terminal output — no tools. Use \`\`TOOL\`\` first if you still need information.`,
  "protocol.label_with_tools": `Protocol correction: you emitted tool_calls under a label that does not allow them. Use \`\`TOOL\`\` for tool calls; \`\`THINK\`\` for reasoning; \`\`FINISH\`\` for the terminal output (no tools).`,
  "protocol.force_finish": `The iteration budget is exhausted. Now produce the terminal output: the first line must be \`\`FINISH\`\`. Do not call tools, do not use \`\`THINK\`\`. If material is still incomplete, state the uncertainty briefly while still producing the most useful output you can.`,
  "protocol.force_finish_repair": `Finalization protocol correction: the previous reply did not produce a valid \`\`FINISH\`\`. Now output only the terminal payload: first line \`\`FINISH\`\`, then the required content. Do not write \`\`THINK\`\` or \`\`TOOL\`\`; do not call tools.`,
  "protocol.fallback_final": `I reached the iteration limit without a valid \`\`FINISH\`\`. The output may be incomplete.`,

  "notices.start_retrieval": "Starting retrieval",
  "notices.empty_tool_result": "The tool completed without returning text output.",
  "notices.too_many_tool_calls": "The model requested {requested} tools. At most {limit} can run in parallel in one iteration, so the list was truncated.",
  "notices.tool_error": "{tool} failed: {error}",
  "notices.protocol_retry": "The model violated the action-label protocol; retrying this iteration.",
  "notices.max_iterations_reached": "Reached the iteration ceiling. Producing the best output I can with what I have.",
  "notices.context_window_guard": "Trimmed older tool results to keep within the model's context window.",
  "notices.final_protocol_failed": "The model still did not produce a valid FINISH reply after the finalization prompt.",
  "notices.plan_count_mismatch": "Plan returned {got} templates instead of {requested}; proceeding with what we have.",
  "notices.plan_unusable": "Quiz planning produced no usable question templates, so there is nothing to build a quiz from. Please retry or narrow the topic.",
  "notices.plan_reasoning_retry": "The planner spent its whole budget reasoning; asking again with less thinking.",
  "notices.repair_attempted": "The previous question payload was invalid; repairing the schema once.",
  "notices.repair_reasoning_retry": "The repair round spent its whole budget reasoning; asking again with less thinking.",
  "notices.repair_failed": "Repair did not fully fix the question; emitting the best-effort version.",
  "notices.tool_summarizer_failed": "Tool summarizer could not produce a summary ({error}); passing raw tool result forward.",

  "empty.no_quiz_history": "(no prior quiz turns in this session)",
  "empty.no_attachments": "(no attachments)",
  "empty.no_conversation": "(no prior conversation)",
  "empty.no_kb": "(no knowledge base attached)",
  "empty.no_previous_questions": "(this is the first question of this turn)",
  "empty.no_explore_summary": "(exploration summary unavailable — proceed using only the user's request)",
  "empty.no_exploration_trace": "(no exploration trace — mimic mode skipped Phase 1; rely on the reference material and template fields)",
  "empty.no_reference": "(no reference material — this is a generative custom question)",

  "trace.iteration_thought": "Iteration {n} — Thought",
  "trace.iteration_tool_call": "Iteration {n} — Tool call: {tool}",
  "trace.iteration_tool_result": "Iteration {n} — Tool result (summarized): {tool}",
  "trace.finish_note": "Final exploration preface (also shown to the user)",
};

const ZH: QuestionPrompts = {
  "labels.explore": "探索",
  "labels.plan": "规划",
  "labels.quiz_step": "题目",
  "labels.reasoning": "推理",
  "labels.tool_call": "工具调用",
  "labels.retrieve": "检索",
  "labels.repair": "修复题目格式",
  "labels.reflecting": "反思",

  "explore.system": `你是 tutor 风格出题流程中的「探索代理」。本阶段的任务是在出题之前**调研用户请求并为下游规划器 / 出题器收集素材**——本阶段**不写题**。

# 输出协议（强制）

每次回复**必须**以以下三个标签之一开头，全大写，第一行用两个反引号包裹：

\`\`FINISH\`\`  → 探索完成。正文是**面向用户的探索前言**（写法见下方「写 FINISH 内容」）。**不**调工具。
\`\`TOOL\`\`    → 本次回复要调工具。正文里可以写**一句**简短意图（可选）。工具本身通过**原生 \`\`tool_calls\`\` 字段**在同一次回复里发出——这是标准的 OpenAI function-calling 通道。**不要**把工具调用以 JSON 文字形式写在正文里。
\`\`THINK\`\`   → 本次回复只是中间推理——**不调工具，也不是最终前言**。正文是你的思路；下一轮迭代接着想，最终用 \`\`FINISH\`\` 收尾。

运行时**只**把 \`\`FINISH\`\` 视为终止信号；\`\`THINK\`\`、\`\`TOOL\`\`、工具结果都让循环继续。

**每次回复是一个动作，不是动作序列。** 第一行告诉运行时本次回复是哪个动作，正文是该动作的具体内容，**仅此而已**。

硬性规则：
- 第一行的标签前面**绝对不能**有任何东西——前导文字、引号、不可见字符都不行。
- 标签必须用**两个**反引号包裹。单反引号、方括号、星号、或任何其他包裹方式**不会被识别**。
- **一次回复只能有一个协议标签。** 一次回复**不能**"先 think 然后调工具"——如果你想思考，就用 \`\`THINK\`\` 然后停在思考；调工具留给下一轮迭代。
- \`\`THINK\`\` 和 \`\`FINISH\`\` 回复**绝不**带任何 \`\`tool_calls\`\`。反过来，\`\`TOOL\`\` **必须**发出真实的原生 \`\`tool_calls\`\`——只在正文里**描述**工具调用的 \`\`TOOL\`\` 回复属于协议违规。
- 在任何回复的正文里写 JSON 形式的 \`\`tool_calls\`\` 数组（或类似形状如 \`\`{{"name": ..., "arguments": ...}}\`\`）**完全没用**：那段文字会被当作思考文字处理，**工具不会被执行**，本轮迭代白费。**唯一能真正触发工具的方式**：用 \`\`TOOL\`\` 开头 + 在同一次回复里通过原生 \`\`tool_calls\`\` 字段发出。

# 让每次迭代都有价值

在决定本次回复要做什么之前，先复盘到目前为止的对话——你之前的 \`\`THINK\`\` 笔记、已经发起的工具调用、以及返回的「已概括的工具结果」。然后问自己：

1. 我现在比本轮开始时多知道了什么？
2. 为了产出 {num_questions} 道符合指定类型 / 难度且**有依据**的题目，我还缺什么、还有哪些不确定？
3. 让最大的剩余信息缺口收窄的「最小下一步」是什么——再做一次检索、读一个具体的 source、查一下外部资料、再多思考一轮、还是直接收尾？

依据这一分析选择动作。**不要**在同一参数下重复已经做过的检索；**不要**调用结果已经在对话历史里被概括过的工具。

# 可用能力（客观清单——按需使用）

运行时会根据本轮上下文挂载下述能力。它们出现在列表里**不是**让你必须调用的指示，而是**当之前的迭代显示你确实还缺信息时，你可以调用的备选**。

{kb_note}
启用的工具：
{tool_list}

依据原则：
- 当有附件、知识库或 source 文档存在、且话题与之重叠时，**优先**使用它们而不是外部检索——用户希望题目扣住他自己的素材。
- 在 FINISH 前言里引用检索内容时，以 [source-id] 行内引用，使用工具结果给出的精确 id。
- 工具名、参数名、知识库名必须**逐字**抄自上方列表，**不要**编造。

# 历史出题记录（仅当上下文中存在时）

如果用户上下文里含「Prior quiz history / 历史出题记录」段落，把最早的几次迭代当作**诊断阶段**：读条目，找出错题模式（哪些子主题、哪些难度、哪些题型容易错），判断学习者真正的薄弱点。后续检索应**偏向**针对这些薄弱点的素材，**不要**重复旧题面。

如果**没有**历史出题记录，这个诊断阶段不需要——直接为指定主题取材即可。

# 写 FINISH 内容

\`\`FINISH\`\` 文本会作为出题前的简短前言**展示给用户**。**它不会传给下游的规划器或出题器**——后者会单独读到一份结构化的探索轨迹。所以 FINISH 正文的唯一职责是**向学习者介绍本轮即将出现的题目**。

请用**用户的语言**写一段连贯的话，按以下顺序：

1. 一句话确认用户的请求。
2. 2–4 句概述题目将依据的素材 / 知识（用到检索内容时以 [source-id] 行内引用）。
3. 如果你针对历史出题记录做了诊断，用一句话说明本次将如何避开旧题目（如适用，覆盖薄弱点）。
4. 一句过渡到出题，例如「现在为你出 {num_questions} 道题。」

使用 Markdown，数学用 LaTeX：行内 $...$，行间 $$...$$。整段 FINISH 控制在约 400 字以内。`,

  "explore.user_template": `## 用户请求
{user_message}

## 出题参数
- 题目数量：{num_questions}
- 允许的题型：{allowed_types}
- 各题型数量分配：{per_type_counts}
- 指定难度：{difficulty}

## 附件
{attachments_summary}

## 对话上下文
{conversation_context}

## 历史出题记录（仅当本 session 之前出过题时存在）
{quiz_history}

开始探索。`,

  "tool_summarizer.system": `你的任务是把**一条原始工具结果**压成一段精炼、**不丢信息**的概括，让下一轮探索代理能以更低成本读到它。你**看不到**用户请求、也**看不到**当时的工具调用参数——只有结果内容本身。

规则：
- **完整保留** source-id 标签、引用标记、URL、文件路径、页码、章节编号等。
- **完整保留**数值、日期、专有名词、公式、定义——**绝不**改写数量。
- 删除模板化文本、导航提示、重复标题、废话、广告、与下游无关的元信息。
- 如果结果本来就很短（约 300 字符以内）且信息密度高，**原样照抄**。
- 如果结果是错误 / 空 / 拒绝，用一句话指出这个事实——**不要**编造内容。
- 输出纯文本：不写协议标签、不写 JSON、不写 Markdown 标题。可分段，按需即可。
- 硬上限 600 字。`,

  "tool_summarizer.user_template": `待概括的原始工具结果：

{tool_result}`,

  "plan.system": `你是「出题规划器」。基于探索轨迹（阶段 1 的完整推理 + 工具调用历史，工具结果已概括）和用户参数，给出本次要生成的所有题目蓝图。

回复**必须**以 \`\`PLAN\`\` 开头，第一行用两个反引号包裹。标签之后输出**恰好一个** JSON 对象：

  {"analysis": "一段简短的题型/难度搭配说明", "templates": [{"question_id": "q_1", "topic": "本题考查的具体内容", "question_type": "choice|concept|fill_in_blank|short_answer|written|coding", "difficulty": "easy|medium|hard"}, ...]}

规则：

1. **恰好输出 {num_questions} 个** template。即使你觉得很难找出这么多不同主题，也要尽力让它们在素材范围内最大化差异。
2. \`\`question_id\`\` 遵循 \`\`q_1\`\`、\`\`q_2\`\`、\`\`q_3\`\` … 的格式，从 1 开始。
3. \`\`question_type\`\` 必须是以下之一：
   - \`\`choice\`\`——4 选 1 选择题（A/B/C/D），一个正确答案。
   - \`\`concept\`\`——单一命题的「判断对错」题。
   - \`\`fill_in_blank\`\`——单空填空（一个缺失的词或短语）。
   - \`\`short_answer\`\`——概念性简答（预期几句话）。
   - \`\`written\`\`——更长的论述 / 解答（一段甚至多段）。
   - \`\`coding\`\`——写代码 / 伪代码 / 算法。
   约束：
   - 类型必须在「允许的题型」列表中（参见用户输入）。若列表为 "any"，按每道题最合适的类型选择。
   - 若「各题型数量分配」给出了配比（例如 \`\`choice=3, short_answer=2\`\`），plan 中的类型分布必须严格符合该配比。
4. \`\`difficulty\`\` 必须是以下之一：\`\`easy\`\`、\`\`medium\`\`、\`\`hard\`\`。
   - 如果用户指定了难度，所有 template 使用该难度。
   - 如果为空 / "auto"，按 template 选择。
5. \`\`topic\`\` 是一句话描述本题考查什么知识点。**两个 template 不允许有相同的 topic。** 直接引用探索轨迹中的具体素材。
6. 如果探索轨迹显示代理诊断过历史出题记录，**不要**重复旧主题；若识别出学习者薄弱点，且与用户请求一致，可优先围绕这些点。
7. 本阶段**不要**写题面或答案——只输出 template 字段。`,

  "plan.user_template": `## 探索轨迹（阶段 1 完整思考 + 工具调用历史，工具结果已概括）
{exploration_trace}

## 用户原请求
{user_message}

## 出题参数
- 题目数量：{num_questions}
- 允许的题型：{allowed_types}
- 各题型数量分配：{per_type_counts}
- 指定难度：{difficulty}`,

  "quiz_step.system": `你正在写**一道**测验题（第 {question_number}/{total_questions} 道），依据规划器已经固定下来的 template。探索轨迹（阶段 1 完整推理 + 工具调用历史，工具结果已概括）和本轮已生成题目的列表都已提供，请据此做出有依据、不重复的题目。

# 输出协议（强制）

每次回复**必须**以以下三个标签之一开头，全大写，第一行用两个反引号包裹：

\`\`FINISH\`\`  → 题目已就绪。正文是**恰好一个**符合下方 schema 的 JSON 对象——没有其他文字、没有代码块包裹、没有标题、闭合括号之后也不能再写任何东西。**不**调工具。
\`\`TOOL\`\`    → 本次回复要调工具（核实事实、拉取例子、查询资料等）。正文里可以写**一句**简短意图（可选）。工具本身通过**原生 \`\`tool_calls\`\` 字段**在同一次回复里发出——这是标准的 OpenAI function-calling 通道。**不要**把工具调用以 JSON 文字形式写在正文里。
\`\`THINK\`\`   → 本次回复只是中间推理——**不调工具，也不是最终 JSON**。正文是你的思路；下一轮迭代接着想。

运行时**只**把 \`\`FINISH\`\` 视为终止信号；\`\`THINK\`\`、\`\`TOOL\`\`、工具结果都让循环继续。

**每次回复是一个动作，不是动作序列。** 第一行告诉运行时本次回复是哪个动作，正文是该动作的具体内容，**仅此而已**。

硬性规则：
- 第一行的标签前面**绝对不能**有任何东西。
- 标签必须用**两个**反引号包裹。单反引号、方括号、星号、或其他包裹方式**不会被识别**。
- **一次回复只能有一个协议标签。** 一次回复**不能**"先 think 然后调工具"。
- \`\`THINK\`\` 和 \`\`FINISH\`\` 回复**绝不**带任何 \`\`tool_calls\`\`。反过来，\`\`TOOL\`\` **必须**发出真实的原生 \`\`tool_calls\`\`——只在正文里**描述**工具调用的 \`\`TOOL\`\` 回复属于协议违规。
- 在任何回复的正文里写 JSON 形式的 \`\`tool_calls\`\` 数组（或类似形状如 \`\`{{"name": ..., "arguments": ...}}\`\`）**完全没用**：那段文字会被当作思考文字处理，**工具不会被执行**。**唯一能真正触发工具的方式**：用 \`\`TOOL\`\` 开头 + 在同一次回复里通过原生 \`\`tool_calls\`\` 字段发出。
- \`\`FINISH\`\` 回复的正文**就是一个 JSON 对象**，不要包代码块、不要加标题、闭合括号之后不要再写任何文字。

# FINISH 的 JSON schema（严格）

{
  "question_type": "choice" | "concept" | "fill_in_blank" | "short_answer" | "written" | "coding",
  "question": "向学习者展示的题面（Markdown，数学用 LaTeX）",
  "options": {"A": "...", "B": "...", "C": "...", "D": "..."},
  "correct_answer": "见下方各题型规则",
  "explanation": "为什么正确答案是正确的——面向学习者的清晰解释"
}

硬性 schema 规则：
- \`\`question_type\`\` 必须**完全等于** template 的 question_type。
- 如果 \`\`question_type\`\` 是 \`\`choice\`\`：\`\`options\`\` 必须**恰好**包含 A、B、C、D 四个 key，每个非空；\`\`correct_answer\`\` 必须是 "A"、"B"、"C"、"D" 之一。选项要可信且**长度 / 风格相近**——**不要**把正确选项写得明显比干扰项更长或更详细。
- 如果 \`\`question_type\`\` 是 \`\`concept\`\`：题面是**一个命题**，由学习者判断对错。省略 \`\`options\`\`（或 null）；\`\`correct_answer\`\` 必须是小写字符串 \`\`"true"\`\` 或 \`\`"false"\`\`。**不要**把题目写成「以下哪项…」式的选择。
- 如果 \`\`question_type\`\` 是 \`\`fill_in_blank\`\`：题面中**必须**包含**恰好一处** \`\`____\`\`（四个下划线），用于标记缺失的词或短语。省略 \`\`options\`\`（或 null）；\`\`correct_answer\`\` 是填入空白处的字符串（一个词或短语）。**不要**列多个并列答案——选一个最规范的。
- 如果 \`\`question_type\`\` 是 \`\`short_answer\`\`：概念性简答，期望答案是几句话。省略 \`\`options\`\`（或 null）；\`\`correct_answer\`\` 是参考答案文本。
- 如果 \`\`question_type\`\` 是 \`\`written\`\`：更长的论述 / 解答（一段甚至多段）。省略 \`\`options\`\`（或 null）；\`\`correct_answer\`\` 是参考答案文本。
- 如果 \`\`question_type\`\` 是 \`\`coding\`\`：省略 \`\`options\`\`（或 null）；\`\`correct_answer\`\` 是参考代码 / 伪代码 / 算法。
- 题目必须严格扣住 template 的 \`\`topic\`\`，并符合 \`\`difficulty\`\`。
- 题目**不允许**重复 / 近似重复「本轮已生成题目」中的任何一项。
- 如用到检索内容，以 [source-id] 行内引用。

工具调用的硬规则：
- 工具名、参数名、知识库名必须**逐字**抄自下方「启用的工具」/「知识库」块。**不要**编造。
- 参数必须具体可执行；空查询无效。

{kb_note}
启用的工具：
{tool_list}`,

  "quiz_step.user_template": `## 本题 template
- question_id: {question_id}
- topic: {topic}
- question_type: {question_type}
- difficulty: {difficulty}

## 探索轨迹（阶段 1 完整思考 + 工具调用历史，工具结果已概括）
{exploration_trace}

## 完整规划（本轮所有题目）
{plan_summary}

## 本轮已生成题目（**不要**重复）
{previous_questions}

## 参考素材（仅 mimic 模式使用——本题应**仿写 / 改编**该参考题的风格和难度，**不要**另起炉灶）
{reference_block}

开始为 {question_id} 出题。`,

  "repair.system": `你来修复一个不合法的题目 JSON。读 invalid payload 和检测到的问题，然后输出修正后的 JSON 对象——**只**输出 JSON，不要其他内容。

硬性规则：
- \`\`question_type\`\` 与 template 一致（**不要**改）。
- 如果是 \`\`choice\`\`：提供恰好四个选项 A/B/C/D；\`\`correct_answer\`\` 必须是 "A"/"B"/"C"/"D" 之一。
- 如果是 \`\`concept\`\`：省略 \`\`options\`\`（或 null）；\`\`correct_answer\`\` 必须是小写的 \`\`"true"\`\` 或 \`\`"false"\`\`。
- 如果是 \`\`fill_in_blank\`\`：省略 \`\`options\`\`（或 null）；\`\`question\`\` 中必须包含**恰好一处** \`\`____\`\`（四个下划线）；\`\`correct_answer\`\` 是填入空白处的字符串。
- 如果是 \`\`short_answer\`\`、\`\`written\`\` 或 \`\`coding\`\`：省略 \`\`options\`\`（或 null）；\`\`correct_answer\`\` 是参考答案文本。
- 保留原 topic 和 difficulty 意图。
- 返回 JSON 只包含字段：question_type, question, options, correct_answer, explanation。`,

  "repair.user_template": `## Template
- question_id: {question_id}
- topic: {topic}
- question_type: {question_type}
- difficulty: {difficulty}

## 无效载荷
{invalid_payload}

## 检测到的问题
{issues}`,

  "protocol.missing_label": `协议修正：你上一轮回复没有以协议标签开头，本轮还不算完成。下一次回复**必须**在第一行写**且仅写**一个动作标签：\`\`THINK\`\`、\`\`TOOL\`\` 或 \`\`FINISH\`\`。正文里**不要**再出现第二个协议标签。`,
  "protocol.multiple_labels": `协议修正：上一轮回复出现了多个协议标签。下一次回复在第一行**只**写一个动作标签，正文里**不要**再放第二个标签。`,
  "protocol.tool_without_calls": `协议修正：你选择了 \`\`TOOL\`\` 但没有发出真实的 tool_calls。\`\`TOOL\`\` 必须在同一次回复里发出 tool_calls；否则改用 \`\`THINK\`\` 或 \`\`FINISH\`\`。`,
  "protocol.think_with_tools": `协议修正：你选择了 \`\`THINK\`\` 同时发起了工具调用。\`\`THINK\`\` 只用于思考。需要工具就用 \`\`TOOL\`\`；只想思考就用 \`\`THINK\`\` 且**不要**调工具。`,
  "protocol.finish_with_tools": `协议修正：你选择了 \`\`FINISH\`\` 同时发起了工具调用。\`\`FINISH\`\` 是终止输出——**不要**调工具。如果还需要信息，先用 \`\`TOOL\`\`。`,
  "protocol.label_with_tools": `协议修正：你在不允许带 tool_calls 的标签下发起了工具调用。需要工具用 \`\`TOOL\`\`，需要思考用 \`\`THINK\`\`，需要终止输出用 \`\`FINISH\`\`（**不**带工具）。`,
  "protocol.force_finish": `迭代预算已用完。现在必须给出终止输出：第一行必须是 \`\`FINISH\`\`，**不要**再调用工具、**不要**用 \`\`THINK\`\`。即使素材不完整，也请简短说明不确定性，并仍输出当前最有用的内容。`,
  "protocol.force_finish_repair": `最终化协议修正：上一轮没有按 \`\`FINISH\`\` 协议输出。现在只输出终止载荷：第一行 \`\`FINISH\`\`，后面直接写要求的内容。**不要**写 \`\`THINK\`\` / \`\`TOOL\`\`，**不要**调工具。`,
  "protocol.fallback_final": `已达迭代上限但模型未给出有效的 \`\`FINISH\`\`。输出可能不完整。`,

  "notices.start_retrieval": "开始检索",
  "notices.empty_tool_result": "工具完成但未返回文本输出。",
  "notices.too_many_tool_calls": "模型请求了 {requested} 个工具。一次最多并行 {limit} 个，已截断。",
  "notices.tool_error": "{tool} 执行失败：{error}",
  "notices.protocol_retry": "模型违反了动作标签协议；本轮重试。",
  "notices.max_iterations_reached": "已达迭代上限。基于当前已有内容产出输出。",
  "notices.context_window_guard": "为了保持在模型上下文窗口内，裁剪了较早的工具结果。",
  "notices.final_protocol_failed": "最终化提示之后模型仍未给出有效的 FINISH 回复。",
  "notices.plan_count_mismatch": "规划返回了 {got} 个 template（要求 {requested} 个），按实际数量继续。",
  "notices.plan_unusable": "出题规划没有产出任何可用的题目模板，无法生成题目。请重试或缩小主题范围。",
  "notices.plan_reasoning_retry": "规划阶段把预算全部用在思考上，没有产出方案；正在降低思考强度重试。",
  "notices.repair_attempted": "上一轮题目载荷不合法；做一次 schema 修复。",
  "notices.repair_reasoning_retry": "修复轮次把预算全部用在思考上；正在降低思考强度重试。",
  "notices.repair_failed": "修复未能完全修正题目；使用尽力版本输出。",
  "notices.tool_summarizer_failed": "工具结果概括失败（{error}）；将把原始工具结果传给下一轮。",

  "empty.no_quiz_history": "（本 session 之前没有出过题）",
  "empty.no_attachments": "（无附件）",
  "empty.no_conversation": "（无对话上下文）",
  "empty.no_kb": "（未挂载知识库）",
  "empty.no_previous_questions": "（这是本轮第一题）",
  "empty.no_explore_summary": "（探索总结不可用——仅基于用户请求出题）",
  "empty.no_exploration_trace": "（无探索轨迹——mimic 模式跳过了阶段 1；请依赖参考素材和 template 字段）",
  "empty.no_reference": "（无参考素材——这是从零生成的自定义题）",

  "trace.iteration_thought": "迭代 {n} —— 思考",
  "trace.iteration_tool_call": "迭代 {n} —— 工具调用：{tool}",
  "trace.iteration_tool_result": "迭代 {n} —— 工具结果（已概括）：{tool}",
  "trace.finish_note": "最终探索前言（同时展示给用户）",
};

const PROMPTS: Record<string, QuestionPrompts> = { en: EN, zh: ZH };

export function questionPrompts(language: string): QuestionPrompts {
  const lang = String(language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  return PROMPTS[lang] ?? EN;
}

/** ``{name}`` substitution — only tokens present in ``vars`` are replaced,
 *  so literal JSON braces in the templates survive untouched. */
export function fmt(template: string, vars: Record<string, unknown>): string {
  if (!vars || !Object.keys(vars).length) return template;
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in vars ? String(vars[key] ?? "") : m,
  );
}
