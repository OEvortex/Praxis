// Port of deeptutor/services/memory/consolidator/prompts/{en,zh}/*.yaml.
// The upstream files are YAML with `system: |` / `user: |` literal blocks;
// they are embedded verbatim here and parsed with a tiny literal-block reader
// (no yaml dependency in this package).

interface PromptFile {
  system: string;
  user: string;
}

const RAW: Record<string, Record<string, string>> = {
  en: {
    update_l2: `system: |
  You are the memory curator for DeepTutor user {user_label}.

  ROLE: You are reading a chunk of the user's recent {surface} activity
  (raw, untruncated). Extract durable facts about the user.

  OUTPUT: A single JSON object — nothing else, no prose, no fences.

      {{"facts": [
        {{"text":   "<≤240 chars; one fact per item>",
          "section": "<one of: {sections}>",
          "refs":   ["<surface>:<entity_id>", ...]}}
      ]}}

  HARD RULES
  - Every fact must have ≥1 ref. Each ref must come from the
    "Chunk-local citeable refs" list or the "@entity <surface>:<id>"
    markers you see in the chunk below — do NOT invent ids, do NOT cite
    entities outside this chunk.
  - text ≤ 240 chars. Be terse, verb-led ("uses X", "stuck on Y").
  - Banned absolutist phrasing (unless wrapping in "..." or 「...」):
    deeply, truly, mastered, expert, passionate, loves, hates, always,
    never, fully understands.
  - Surface focus: {focus}.
  - If nothing material is in this chunk, emit \`{{"facts": []}}\` —
    that is a correct, expected answer.

  Today is {today}.

user: |
  # Existing {surface} memory (do not duplicate items already captured here):
  {existing}

  # Source chunk {chunk_index}/{chunk_total} (chars {chunk_start}..{chunk_end}):
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  Return JSON. Cite only refs listed or visible in the chunk above.
`,
    update_l3: `system: |
  You are the cross-surface memory curator for DeepTutor user {user_label}.

  ROLE: You are reading a chunk of L2 summaries from one or more
  surfaces (chat / notebook / quiz / kb / book / partner / cowriter).
  Synthesize durable, hedged claims about the user.

  OUTPUT: A single JSON object — nothing else.

      {{"facts": [
        {{"text":   "<≤240 chars, hedged with surface/count>",
          "section": "<one of: {sections}>",
          "refs":   ["<surface>", ...]}}
      ]}}

  HARD RULES
  - \`refs\` are **bare surface names** taken from the chunk's
    "Chunk-local citeable refs" list (e.g. \`chat\`, \`notebook\`).
    Never emit \`m_xxx\`, \`surface:id\`, or any entry id. One fact
    may cite multiple surfaces if it genuinely synthesizes across them.
  - text ≤ 240 chars. Forced hedge template: claims must be of the
    form "Across N <surface> interactions, the user X" or
    "<surface> entries show the user X" — bind to a surface or count.
  - Banned absolutist phrasing (unless quoting with "..." or 「...」):
    deeply, truly, mastered, expert, passionate, loves, hates, always,
    never, fully understands.
  - Slot focus: {focus}.
  - Empty \`{{"facts": []}}\` is a correct answer if nothing in this
    chunk warrants a new L3 claim.

  Today is {today}.

user: |
  # Existing {slot} memory (do not duplicate):
  {existing}

  # L2 chunk {chunk_index}/{chunk_total}:
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  Return JSON. Cite only surface names from the "Chunk-local citeable
  refs" list at the top of the chunk.
`,
    audit_l2: `system: |
  You are the memory auditor for DeepTutor user {user_label}.

  ROLE: You are reading a chunk of {surface} L2 memory with each
  entry annotated by its **full original source** (no truncation).
  Your job is to find factual errors and edit the memory so it
  matches the evidence.

  OUTPUT: A single JSON object — nothing else.

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240>",
          "refs": ["<surface>:<id>", ...], "reason": "<short>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<short>"}},
        {{"op": "insert",  "after_line": <int>, "text": "<≤240>",
          "refs": ["<surface>:<id>", ...], "section": "<optional>",
          "reason": "<short>"}}
      ]}}

  HARD RULES
  - Line numbers refer to the numbered view of the chunk below.
  - Every replace/insert MUST cite refs from the sources shown for
    that line (or for nearby lines in the same chunk).
  - text/new_text ≤ 240 chars.
  - Don't edit lines that are not bullet entries (titles, blanks,
    section headers). Section creation happens implicitly via insert.
  - Banned absolutist phrasing same as update mode.
  - When nothing needs fixing, emit \`{{"edits": []}}\`. Don't churn.
  - \`reason\` is short prose describing what evidence drives the edit.

  Today is {today}.

user: |
  # Annotated chunk of {surface} memory (each bullet shows its sources):
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  Return JSON. Edit only lines visible above.
`,
    audit_l3: `system: |
  You are the cross-surface memory auditor for DeepTutor user {user_label}.

  ROLE: You are reading a chunk of {slot} L3 memory annotated with
  the **full L2 entries** it cites. Find claims that are
  overgeneralized, contradicted by L2, or no longer supported.

  OUTPUT: A single JSON object — nothing else.

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240, hedged>",
          "refs": ["m_xxx", ...], "reason": "<short>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<short>"}},
        {{"op": "insert",  "after_line": <int>, "text": "<≤240, hedged>",
          "refs": ["m_xxx", ...], "section": "<optional>",
          "reason": "<short>"}}
      ]}}

  HARD RULES (same as update_l3 plus audit-specific):
  - replace/insert must cite L2 m_xxx ids visible in the annotated
    sources of this chunk.
  - Hedge: claims of the form "Across N <surface> interactions" or
    "<surface> entries show…".
  - Banned absolutist phrasing.
  - Empty edits is correct when the chunk holds up.

  Today is {today}.

user: |
  # Annotated chunk of {slot} memory (each L3 bullet shows its L2 sources):
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  Return JSON.
`,
    dedup: `system: |
  You are the memory dedup pass for DeepTutor user {user_label}.

  ROLE: Read the entire memory document below as a line-numbered view.
  Merge duplicates, collapse near-duplicates by replacing one and
  deleting the others, and rewrite muddled entries.

  OUTPUT: A single JSON object — nothing else.

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240>",
          "refs": ["<source ref from refs=[...]>", ...], "reason": "<short>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<merged into Lx | duplicate of Ly | low signal>"}}
      ]}}

  HARD RULES
  - You may use ONLY replace and delete — no insert. Dedup never adds.
  - When merging A and B: keep the higher-quality one (replace its
    line with the merged text, union of refs) and delete the other.
  - When two entries restate the same fact verbatim, delete the later
    duplicate (lower-line wins).
  - text ≤ 240. Preserve refs (union when merging).
  - Each entry's refs=[...] suffix contains its source references. Copy
    those values exactly; [^m_...] is an entry anchor, not a source ref.
    Do not include the refs metadata suffix in new_text.
  - Banned absolutist phrasing (same list as update mode).
  - If nothing needs deduping, emit \`{{"edits": []}}\`. Don't churn.

  Today is {today}.

user: |
  # Memory document (line-numbered):
  ----------------------------------------------------------------
  {doc}
  ----------------------------------------------------------------

  Iteration {iteration}/{iterations_total}. Return JSON.
`,
  },
  zh: {
    update_l2: `system: |
  你是 DeepTutor 用户 {user_label} 的记忆管理员。

  任务：阅读用户最近 {surface} 活动的一段原始内容（未截断），抽取关于用户
  的稳定事实。

  输出：唯一一个 JSON 对象 — 不要散文，不要代码块。

      {{"facts": [
        {{"text":   "<≤240 字符；每条一个事实>",
          "section": "<必须取值于：{sections}>",
          "refs":   ["<surface>:<entity_id>", ...]}}
      ]}}

  硬性规则
  - 每条事实必须有至少 1 个 ref。ref 必须来自下面 chunk 内的
    "Chunk-local citeable refs" 列表或 "@entity <surface>:<id>" 标记。
    绝对不要编造 id，绝对不要引用 chunk 范围之外的 entity。
  - text ≤ 240 字符。简洁，动词为主（「使用 X」「卡在 Y」）。
  - 禁止绝对化用语（除非用 "..." 或 「...」 引用用户原话）：
    深刻、彻底、完美掌握、完全理解、专家、热爱、总是、从来不、
    deeply、truly、mastered、expert、passionate、loves、hates、always、
    never、fully understands。
  - Surface 焦点：{focus}。
  - 如果这个 chunk 里没有值得记录的事实，回 \`{{"facts": []}}\` 是正常的。

  今天是 {today}。

user: |
  # 已有的 {surface} 记忆（不要重复已经记录过的事实）：
  {existing}

  # 源 chunk {chunk_index}/{chunk_total}（字符 {chunk_start}..{chunk_end}）：
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  返回 JSON。只能引用上面列出或出现过的 ref。
`,
    update_l3: `system: |
  你是 DeepTutor 用户 {user_label} 的跨 surface 记忆管理员。

  任务：阅读若干 surface 的 L2 摘要片段（chat / notebook / quiz / kb / book /
  partner / cowriter），给出关于用户的稳定、对冲过的判断。

  输出：唯一一个 JSON 对象。

      {{"facts": [
        {{"text":   "<≤240 字符，带 surface/计数对冲>",
          "section": "<必须取值于：{sections}>",
          "refs":   ["<surface 名>", ...]}}
      ]}}

  硬性规则
  - \`refs\` 只能是 chunk 顶部 "Chunk-local citeable refs" 列表里的**裸 surface 名**
    （如 \`chat\`、\`notebook\`）。**禁止**写 \`m_xxx\` 或 \`surface:id\`
    这类 entry id。一条 fact 如果是跨 surface 综合的，可以同时引用多个 surface。
  - text ≤ 240。强制对冲：判断必须形如
    「在 N 次 <surface> 互动中，用户 X」或「<surface> 记忆显示用户 X」。
  - 禁止绝对化用语（除非 "..." 或 「...」 原话）：同 update_l2。
  - Slot 焦点：{focus}。
  - 没有合适的事实就回 \`{{"facts": []}}\`。

  今天是 {today}。

user: |
  # 已有的 {slot} 记忆（不要重复）：
  {existing}

  # L2 片段 {chunk_index}/{chunk_total}：
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  返回 JSON。refs 只能从 chunk 顶部 "Chunk-local citeable refs" 里挑 surface 名。
`,
    audit_l2: `system: |
  你是 DeepTutor 用户 {user_label} 的记忆审计员。

  任务：阅读一段 {surface} 的 L2 记忆，每个条目下都附上了它引用的
  **完整原始内容**（不截断）。找出与原始内容不一致或事实错误的条目，
  通过编辑修正。

  输出：唯一一个 JSON 对象。

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240>",
          "refs": ["<surface>:<id>", ...], "reason": "<简短>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<简短>"}},
        {{"op": "insert",  "after_line": <int>, "text": "<≤240>",
          "refs": ["<surface>:<id>", ...], "section": "<可选>",
          "reason": "<简短>"}}
      ]}}

  硬性规则
  - line 必须对应下面带行号的视图。
  - replace/insert 的 refs 必须来自当前条目（或同一 chunk 邻近条目）
    展示的 sources。
  - text/new_text ≤ 240。
  - 不要编辑非 bullet 行（标题、空行、section 标题）。
  - 同 update 的禁词清单。
  - 如果不需要任何修改，返回 \`{{"edits": []}}\`，不要为改而改。
  - \`reason\` 用一句话说明依据。

  今天是 {today}。

user: |
  # 带源 trace 注解的 {surface} 记忆 chunk：
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  返回 JSON。只编辑上面可见的行号。
`,
    audit_l3: `system: |
  你是 DeepTutor 用户 {user_label} 的跨 surface 记忆审计员。

  任务：阅读一段 {slot} 的 L3 记忆，每个条目都附上了它引用的
  **完整 L2 entry**。找出过度概括、被 L2 反驳、或证据不足的判断，
  通过编辑修正。

  输出：唯一一个 JSON 对象。

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240，已对冲>",
          "refs": ["m_xxx", ...], "reason": "<简短>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<简短>"}},
        {{"op": "insert",  "after_line": <int>, "text": "<≤240，已对冲>",
          "refs": ["m_xxx", ...], "section": "<可选>",
          "reason": "<简短>"}}
      ]}}

  硬性规则
  - 同 update_l3 的 ref 规则 + L3 对冲模板。
  - 不要为改而改，没问题就回 \`{{"edits": []}}\`。

  今天是 {today}。

user: |
  # 带 L2 source 注解的 {slot} 记忆 chunk：
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  返回 JSON。
`,
    dedup: `system: |
  你是 DeepTutor 用户 {user_label} 的记忆去重员。

  任务：完整读取下面带行号的记忆文档，合并重复、删除冗余、改写不清晰的条目。

  输出：唯一一个 JSON 对象。

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240>",
          "refs": ["<refs=[...] 中的来源引用>", ...], "reason": "<简短>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<合并到 Lx | Ly 的重复 | 低信号>"}}
      ]}}

  硬性规则
  - 只允许 replace 和 delete，不允许 insert。
  - 合并 A 和 B 时：保留质量更高的（replace 它的行，refs 取并集），
    删掉另一条。
  - 字面重复时，删掉行号更靠后的（保留靠前的）。
  - text ≤ 240。合并时 refs 取并集。
  - 每条末尾的 refs=[...] 包含原始来源引用，必须原样复制其中的值。
    [^m_...] 是条目定位标记，不是来源引用。
    new_text 不要包含 refs 元数据后缀。
  - 同 update 的禁词清单。
  - 没什么可去重的就回 \`{{"edits": []}}\`。

  今天是 {today}。

user: |
  # 记忆文档（带行号）：
  ----------------------------------------------------------------
  {doc}
  ----------------------------------------------------------------

  第 {iteration} / {iterations_total} 轮。返回 JSON。
`,
  },
};

// _meta.yaml content (per-surface / per-slot focus + suggested sections).
interface MetaEntry {
  focus: string;
  sections: string[];
}
interface MetaFile {
  surfaces: Record<string, MetaEntry>;
  slots: Record<string, MetaEntry>;
}

const META: Record<string, MetaFile> = {
  en: {
    surfaces: {
      chat: {
        focus:
          "Stable misconceptions the user has surfaced, concepts they've demonstrated mastery of, and durable topics they keep returning to. Drop per-turn chatter.",
        sections: ["Misconceptions", "Mastery", "Topics"],
      },
      notebook: {
        focus:
          "Recurring note themes, formats the user prefers, and questions they keep coming back to in their notes.",
        sections: ["Themes", "Formats", "Open questions"],
      },
      quiz: {
        focus:
          "Error patterns across quiz attempts, topics with low/high success rate, and item types the user struggles with.",
        sections: ["Error patterns", "Strong topics", "Struggling topics"],
      },
      kb: {
        focus:
          "Document interests, query patterns into the knowledge base, and gaps in user's library.",
        sections: ["Interests", "Frequent queries", "Library gaps"],
      },
      book: {
        focus:
          "Reading pacing, sticking points (pages reopened or paused), and topics the user annotates heavily.",
        sections: ["Pacing", "Sticking points", "Annotation themes"],
      },
      partner: {
        focus:
          "Persistent themes across partner conversations and channel-specific behaviours.",
        sections: ["Themes", "Channels"],
      },
      cowriter: {
        focus:
          "Writing style preferences, recurring revisions, and topics the user drafts about.",
        sections: ["Style", "Recurring revisions", "Topics"],
      },
    },
    slots: {
      recent: {
        focus:
          "A rolling timeline of what the user has been doing across all surfaces over the last 1–4 weeks. Time-anchored, surface-attributed.",
        sections: ["This week", "Earlier"],
      },
      profile: {
        focus:
          "Durable identity, learning style, and knowledge level. ONLY claims supported by multiple L2 entries across surfaces. No speculation about traits not directly evidenced.",
        sections: ["Identity", "Learning style", "Knowledge level"],
      },
      scope: {
        focus:
          "Concepts and topics the user has demonstrably engaged with, with confidence labels (familiar / practicing / unsure) tied to L2 evidence.",
        sections: ["Familiar", "Practicing", "Unsure"],
      },
    },
  },
  zh: {
    surfaces: {
      chat: {
        focus: "用户呈现出的稳定误解、已经显示出掌握的概念、以及反复回到的持久话题。剔除单轮闲聊。",
        sections: ["误解", "掌握", "话题"],
      },
      notebook: {
        focus: "笔记中反复出现的主题、用户偏好的格式、以及反复出现的问题。",
        sections: ["主题", "格式", "悬而未决的问题"],
      },
      quiz: {
        focus: "答题中的错误模式、正确率高/低的话题、用户在哪类题型上挣扎。",
        sections: ["错误模式", "强项", "弱项"],
      },
      kb: {
        focus: "用户的文档兴趣、对知识库的查询模式、文献库中的空白。",
        sections: ["兴趣", "高频查询", "文献库空白"],
      },
      book: {
        focus: "阅读节奏、卡点（页面重复打开或停留）、用户重点标注的主题。",
        sections: ["节奏", "卡点", "标注主题"],
      },
      partner: {
        focus: "伙伴对话中反复出现的主题、不同频道的行为差异。",
        sections: ["主题", "频道"],
      },
      cowriter: {
        focus: "写作风格偏好、反复修改的模式、用户起草的话题。",
        sections: ["风格", "反复修改", "话题"],
      },
    },
    slots: {
      recent: {
        focus: "最近 1-4 周用户跨 surface 的活动滚动时间线。时间锚定、surface 归属。",
        sections: ["本周", "更早"],
      },
      profile: {
        focus: "持久的身份、学习风格、知识水平。只接受多个 surface 多个 L2 条目支撑的判断，禁止臆测。",
        sections: ["身份", "学习风格", "知识水平"],
      },
      scope: {
        focus: "用户有过实际接触的概念，含信心标签（熟悉 / 练习中 / 不确定），均绑定 L2 证据。",
        sections: ["熟悉", "练习中", "不确定"],
      },
    },
  },
};

// ── Minimal `key: |` literal-block YAML reader ────────────────────────

function parseLiteralBlocks(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = /^([A-Za-z_]+):\s*\|\s*$/.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const body: string[] = [];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        body.push("");
        i++;
        continue;
      }
      const indent = line.match(/^ */)![0].length;
      if (indent < 2) break;
      body.push(line.slice(2));
      i++;
    }
    // YAML literal blocks end with a single trailing newline.
    while (body.length && body[body.length - 1] === "") body.pop();
    out[key] = body.join("\n") + "\n";
  }
  return out;
}

const PROMPT_CACHE = new Map<string, PromptFile>();
const META_CACHE = new Map<string, MetaFile>();

export function lang_code(language: string): string {
  return (language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function load_prompt(name: string, language: string): PromptFile {
  const lang = lang_code(language);
  const key = `${lang}:${name}`;
  const cached = PROMPT_CACHE.get(key);
  if (cached) return cached;
  const raw = RAW[lang]?.[name];
  if (raw === undefined) throw new Error(`unknown memory prompt ${lang}/${name}`);
  const blocks = parseLiteralBlocks(raw);
  if (!blocks["system"] || !blocks["user"]) {
    throw new Error(`prompt ${name} missing 'system'/'user' keys`);
  }
  const file = { system: blocks["system"], user: blocks["user"] };
  PROMPT_CACHE.set(key, file);
  return file;
}

export function load_focus_meta(language: string): MetaFile {
  const lang = lang_code(language);
  const cached = META_CACHE.get(lang);
  if (cached) return cached;
  const meta = META[lang] ?? META["en"];
  META_CACHE.set(lang, meta);
  return meta;
}

export function surface_focus(language: string, surface: string): [string, string[]] {
  const meta = load_focus_meta(language).surfaces[surface] ?? {};
  return [meta.focus ?? "", [...(meta.sections ?? [])]];
}

export function slot_focus(language: string, slot: string): [string, string[]] {
  const meta = load_focus_meta(language).slots[slot] ?? {};
  return [meta.focus ?? "", [...(meta.sections ?? [])]];
}
