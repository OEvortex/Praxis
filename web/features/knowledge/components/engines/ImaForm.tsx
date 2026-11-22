"use client";

import { useEffect, useState } from "react";

import { ExternalLink, Loader2 } from "lucide-react";
import {
  getImaConfig,
  updateImaConfig,
  type ImaAccountConfig,
} from "@/features/knowledge/api/engines";

export function ImaForm({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  
  const [config, setConfig] = useState<ImaAccountConfig | null>(null);
  const [clientId, setClientId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getImaConfig({ force: true })
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setClientId(cfg.client_id || "");
      })
      .catch((err) =>
        onError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = async (payload: { client_id?: string; api_key?: string }) => {
    setSaving(true);
    try {
      const next = await updateImaConfig(payload);
      setConfig(next);
      setClientId(next.client_id || "");
      setApiKey("");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const keySet = config?.api_key_set ?? false;

  return (
    <div className="space-y-4 rounded-2xl border border-[var(--border)] p-4">
      <p className="text-[12px] leading-relaxed text-[var(--muted-foreground)]">
        {"One IMA account reaches every library in it, so this pair is shared by all your Tencent IMA knowledge bases. Connecting one then only asks which library to point at. A knowledge base can still carry its own credentials to reach a second account."}
      </p>

      <div>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {"Client ID"}
        </label>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={saving}
          autoComplete="off"
          placeholder={"Enter your IMA Client ID"}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[13px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25 disabled:opacity-50"
        />
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {"API key"}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={saving}
          autoComplete="off"
          placeholder={
            keySet
              ? "•••••••• (configured — leave blank to keep)"
              : "Enter your IMA API key"
          }
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25 disabled:opacity-50"
        />
        {keySet && (
          <button
            type="button"
            onClick={() => void persist({ api_key: "" })}
            disabled={saving}
            className="mt-1.5 text-[11px] font-medium text-red-600 transition-colors hover:text-red-700 disabled:opacity-40 dark:text-red-400"
          >
            {"Remove stored key"}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <a
          href="https://ima.qq.com/agent-interface"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11.5px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          {"Get an API key"}
          <ExternalLink className="h-3 w-3" />
        </a>
        <button
          type="button"
          onClick={() =>
            void persist({
              client_id: clientId.trim(),
              ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
            })
          }
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {"Save changes"}
        </button>
      </div>
    </div>
  );
}
