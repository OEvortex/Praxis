// slash-command palette and
// dispatch for partner chat surfaces.
import type { PartnerSessionStore, PartnerConfig } from "./manager.js";
import type { CurrentUser } from "./multiuser.js";
import type { AnyRecord } from "./store.js";

export interface PartnerCommandSpec {
  command: string;
  description: string;
  arg_hint?: string;
}

export const BUILTIN_PARTNER_COMMANDS: PartnerCommandSpec[] = [
  { command: "/help", description: "Show available partner commands." },
  { command: "/new", description: "Archive this conversation and start a fresh one." },
  { command: "/branch", description: "Archive this conversation and continue in a copy." },
  { command: "/stop", description: "Stop the reply that's currently being generated." },
  { command: "/sessions", description: "List this partner's conversations and their IDs." },
  { command: "/resume", description: "Reopen an archived conversation.", arg_hint: "<session ID>" },
  { command: "/delete", description: "Delete a conversation permanently.", arg_hint: "<session ID>" },
  { command: "/status", description: "Show partner, session, model, and tool status." },
  { command: "/model", description: "List or switch this partner's model.", arg_hint: "[number|model name]" },
  { command: "/history", description: "Show recent messages in this conversation.", arg_hint: "[n]" },
  { command: "/tool", description: "Show or change enabled tools.", arg_hint: "[on|off <name>|reset]" },
  {
    command: "/link",
    description: "Connect this chat account to your DeepTutor account.",
    arg_hint: "<code from the web app>",
  },
];

export function partnerCommandPalette(): AnyRecord[] {
  return BUILTIN_PARTNER_COMMANDS.map((s) => ({
    command: s.command,
    description: s.description,
    arg_hint: s.arg_hint ?? "",
  }));
}

export function buildPartnerHelpText(): string {
  const lines = ["Partner commands:"];
  for (const s of BUILTIN_PARTNER_COMMANDS) {
    lines.push(`${s.command}${s.arg_hint ? " " + s.arg_hint : ""} - ${s.description}`);
  }
  lines.push("/clear - Alias for /new.");
  return lines.join("\n");
}

export function looksLikePartnerCommand(text: string): boolean {
  const stripped = text.trim();
  return stripped.length > 1 && stripped.startsWith("/") && /[a-zA-Z]/.test(stripped[1]);
}

export interface PartnerCommandResult {
  content: string;
  metadata?: AnyRecord;
}

export interface CommandCtx {
  partner_id: string;
  config: PartnerConfig;
  store: PartnerSessionStore;
  save_config: (config: PartnerConfig) => void;
  actor: CurrentUser | null;
  session_key: string;
  channel?: string;
}

// Optional-tool pool mirrors the chat composer defaults (upstream
// default_optional_tools). Kept small and explicit.
export const DEFAULT_OPTIONAL_TOOLS = [
  "web",
  "web_search",
  "paper_search",
  "question_bank",
  "memory",
  "knowledge_base_search",
  "learning",
  "workspace",
  "mastery",
  "video",
  "notebook",
  "cron",
  "review",
];

function shlexSplit(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function dispatchPartnerCommand(raw: string, ctx: CommandCtx): PartnerCommandResult | null {
  const text = raw.trim();
  if (!looksLikePartnerCommand(text)) return null;
  const parts = shlexSplit(text);
  if (!parts.length) return null;
  const command = parts[0].toLowerCase().split("@")[0];
  const args = parts.slice(1);

  switch (command) {
    case "/help":
      return { content: buildPartnerHelpText() };
    case "/new":
    case "/clear": {
      const archived = ctx.store.archiveSession?.(ctx.session_key);
      return {
        content: archived
          ? `Started a new conversation.\nArchived ${archived["message_count"]} message(s) as \`${archived["session_key"]}\`.`
          : "Started a new conversation. No prior messages to archive.",
      };
    }
    case "/branch": {
      const archived = ctx.store.archiveSession?.(ctx.session_key);
      return {
        content: archived
          ? `Archived this conversation as \`${archived["session_key"]}\` and started fresh. To keep the full history in a new branch, use the web app.`
          : "Nothing to branch yet.",
      };
    }
    case "/stop":
      return { content: "There's nothing being generated to stop." };
    case "/sessions": {
      const sessions = ctx.store.listSessions();
      if (!sessions.length) return { content: "No conversations yet." };
      const lines = ["Conversations:"];
      for (const s of sessions.slice(0, 30)) {
        const flag = s["archived"] ? " (archived)" : "";
        const title = String(s["title"] || "").trim() || "(untitled)";
        lines.push(`- \`${s["session_key"]}\`${flag} — ${title} · ${s["message_count"]} msg`);
      }
      lines.push("\nUse /resume <session ID> or /delete <session ID>.");
      return { content: lines.join("\n") };
    }
    case "/resume": {
      if (!args.length) return { content: "Usage: /resume <session ID>" };
      ctx.store.setArchived(args[0], false);
      return {
        content: `Conversation \`${args[0]}\` is active again. In the web app it reopens automatically.`,
      };
    }
    case "/delete": {
      if (!args.length) return { content: "Usage: /delete <session ID>" };
      const removed = ctx.store.deleteSession(args[0]);
      return {
        content: removed
          ? `Deleted conversation \`${args[0]}\`.`
          : `No conversation \`${args[0]}\` found.`,
      };
    }
    case "/status": {
      const selection = (ctx.config.llm_selection as AnyRecord) ?? {};
      const model =
        String(selection["model_id"] ?? "") || ctx.config.model || "default";
      const tools = currentTools(ctx.config);
      const messages = ctx.store.messages(ctx.session_key, { limit: 10_000 });
      return {
        content: [
          "Partner status:",
          `- Partner: ${ctx.config.name} (\`${ctx.partner_id}\`)`,
          `- Channel: ${ctx.channel ?? "web"}`,
          `- Session: \`${ctx.session_key}\``,
          `- Model: \`${model}\``,
          `- Messages in current conversation: ${messages.length}`,
          `- Tools: ${tools.length ? tools.map((t) => `\`${t}\``).join(", ") : "(none)"}`,
        ].join("\n"),
      };
    }
    case "/model": {
      // Upstream resolves the shared model catalog; this backend's catalog is
      // provider-config.ts. Keep the command honest: report the current
      // selection and persist a validated {profile_id, model_id} pick.
      const sel = (ctx.config.llm_selection as AnyRecord) ?? null;
      const current = sel
        ? `${sel["profile_id"] ?? ""}/${sel["model_id"] ?? ""}`
        : ctx.config.model || "default";
      if (!args.length) {
        return {
          content: `Current model: \`${current}\`.\nUse /model <profile_id> <model_id> to switch.`,
        };
      }
      if (args.length === 2) {
        const next = { profile_id: args[0], model_id: args[1] };
        ctx.config.llm_selection = next;
        ctx.config.model = null;
        ctx.save_config(ctx.config);
        return { content: `✅ Switched model: \`${current}\` → \`${next.profile_id}/${next.model_id}\`.` };
      }
      return { content: "Usage: /model <profile_id> <model_id>" };
    }
    case "/history": {
      let count = 10;
      if (args.length) {
        const n = parseInt(args[0], 10);
        if (!Number.isFinite(n)) return { content: "Usage: /history [count]" };
        count = Math.max(1, Math.min(n, 50));
      }
      const records = ctx.store.messages(ctx.session_key, { limit: count });
      const visible = records
        .map((r) => {
          const role = r["role"] === "user" ? "User" : r["role"] === "assistant" ? "Partner" : String(r["role"]);
          return `${role}: ${String(r["content"] ?? "")}`;
        })
        .filter(Boolean);
      if (!visible.length) return { content: "No conversation history yet." };
      return { content: `Last ${visible.length} message(s):\n${visible.join("\n")}` };
    }
    case "/tool": {
      const available = DEFAULT_OPTIONAL_TOOLS;
      if (!args.length) return { content: formatTools(currentTools(ctx.config), available) };
      const action = args[0].toLowerCase();
      if (action === "reset") {
        ctx.config.enabled_tools = null;
        ctx.save_config(ctx.config);
        return { content: formatTools(currentTools(ctx.config), available) };
      }
      if ((action !== "on" && action !== "off") || args.length < 2) {
        return { content: "Usage: /tool [on|off <name>|reset]" };
      }
      const name = args[1];
      if (!available.includes(name)) {
        return {
          content: `Unknown tool \`${name}\`.\nAvailable: ${available.map((t) => `\`${t}\``).join(", ")}`,
        };
      }
      const next = [...currentTools(ctx.config)];
      if (action === "on" && !next.includes(name)) next.push(name);
      if (action === "off") {
        const i = next.indexOf(name);
        if (i >= 0) next.splice(i, 1);
      }
      ctx.config.enabled_tools = next;
      ctx.save_config(ctx.config);
      return { content: formatTools(next, available) };
    }
    case "/link": {
      if ((ctx.channel ?? "web") === "web") {
        return { content: "You're already signed in here — nothing to link." };
      }
      if (!args.length) {
        return {
          content:
            "Usage: /link <code>. Open this partner in DeepTutor and choose “Link this chat account” to get a code.",
        };
      }
      // Redemption happens in the channel layer; the web surface only mints.
      return { content: "Link codes are redeemed by the channel listener." };
    }
    default:
      return { content: `Unknown command: ${parts[0]}\n\n${buildPartnerHelpText()}` };
  }
}

function currentTools(config: PartnerConfig): string[] {
  return config.enabled_tools ?? DEFAULT_OPTIONAL_TOOLS;
}

function formatTools(current: string[], available: string[]): string {
  const lines = ["Tools:"];
  for (const name of available) {
    lines.push(`- ${current.includes(name) ? "✅" : "⬜"} \`${name}\``);
  }
  return lines.join("\n");
}
