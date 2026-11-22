import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Settings } from "../../config.js";
import { get_settings as getSettings } from "../../config.js";
import { loadCatalog, saveCatalog, readState, writeState, deleteState, type Json } from "./store.js";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = "codex_cli_rs";
const CALLBACK_PORTS = [1455, 1457];
const CALLBACK_PATH = "/auth/callback";
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const PROFILE_ID = "llm-profile-openai-codex-managed";
const MANAGED_BY = "openai_codex_oauth";
const b64url = (buf: Buffer) => buf.toString("base64url");
const jwtClaims = (token: string): Json => {
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")); } catch { return {}; }
};
export class AuthError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message); }
}
interface Credentials { access_token: string; refresh_token: string; id_token: string; account_id: string; expires_at: number; generation: number; rejected?: boolean }
interface Pending { operation_id: string; state: string; verifier: string; redirect_uri: string; authorize_url: string; deadline: number; server: Server; port: number; resolve?: (v: { code?: string; state?: string; error?: string }) => void }

export class CodexOAuthService {
  private settings: Settings;
  private pending: Pending | null = null;
  private lastError: string | null = null;
  constructor(settings: Settings = getSettings()) { this.settings = settings; }
  private key(suffix: string) { return `codex_${suffix}`; }
  private read<T>(suffix: string, fallback: T): T { return readState<T>(this.settings, this.key(suffix), fallback); }
  private write(suffix: string, value: unknown) { writeState(this.settings, this.key(suffix), value); }
  private clearState(suffix: string) { deleteState(this.settings, this.key(suffix)); }
  private credentials(): Credentials | null { return this.read<Credentials | null>("credentials", null); }
  private saveCredentials(c: Credentials) { this.write("credentials", { ...c, generation: (this.credentials()?.generation ?? 0) + 1 }); }
  private clearCredentials() { this.clearState("credentials"); this.clearState("catalog_snapshot"); this.clearState("catalog_models"); }
  private async tokenRequest(data: Record<string, string>, json = false): Promise<Json> {
    const res = await fetch(`${ISSUER}/oauth/token`, { method: "POST", headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded" }, body: json ? JSON.stringify(data) : new URLSearchParams(data).toString(), signal: AbortSignal.timeout(30000) });
    const payload = await res.json().catch(() => ({})) as Json;
    if (!res.ok) {
      const code = String(payload.error ?? "token_request_failed");
      if (code === "invalid_grant" || code === "invalid_token") { const c = this.credentials(); if (c) this.write("credentials", { ...c, rejected: true }); throw new AuthError("token_refresh_rejected", "Codex sign-in could not be renewed. Sign in to Codex again.", 401); }
      throw new AuthError("token_exchange_failed", "Codex authentication request failed.", 502);
    }
    return payload;
  }
  private credentialsFrom(payload: Json, generation: number, fallback?: Credentials | null): Credentials {
    const access = String(payload.access_token ?? fallback?.access_token ?? "");
    const refresh = String(payload.refresh_token ?? fallback?.refresh_token ?? "");
    const idToken = String(payload.id_token ?? fallback?.id_token ?? "");
    if (!access || !refresh || !idToken) throw new AuthError("token_response_invalid", "Codex returned incomplete authentication data.", 502);
    const claims = jwtClaims(idToken);
    const auth = isObj(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] as Json : {};
    const account = String(payload.account_id ?? payload.chatgpt_account_id ?? auth.chatgpt_account_id ?? auth.account_id ?? claims.account_id ?? fallback?.account_id ?? "");
    const exp = Number(payload.expires_at ?? claims.exp ?? 0);
    const expires = Number.isFinite(exp) && exp > 1_000_000_000_000 ? exp : Math.floor(Date.now() / 1000) + Number(payload.expires_in ?? 3600);
    if (!account) throw new AuthError("token_response_invalid", "Codex returned incomplete authentication data.", 502);
    return { access_token: access, refresh_token: refresh, id_token: idToken, account_id: account, expires_at: expires, generation };
  }
  private async startServer(expectedState: string): Promise<{ server: Server; port: number; wait: Promise<{ code?: string; state?: string; error?: string }> }> {
    let resolveWait!: (v: { code?: string; state?: string; error?: string }) => void;
    const wait = new Promise<{ code?: string; state?: string; error?: string }>((resolve) => { resolveWait = resolve; });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end("Not found"); return; }
      const state = url.searchParams.get("state") ?? undefined;
      const ok = state && state.length <= 128 && timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html" });
      res.end(ok ? "<p>Authentication received. You can return to DeepTutor.</p>" : "<p>The authentication callback was invalid.</p>");
      if (ok) resolveWait({ code: url.searchParams.get("code") ?? undefined, state, error: url.searchParams.get("error") ?? undefined });
    });
    for (const port of CALLBACK_PORTS) {
      try {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
        return { server, port, wait };
      } catch { /* next port */ }
    }
    throw new AuthError("callback_unavailable", "DeepTutor could not start the local Codex sign-in callback.", 503);
  }
  async startLogin(): Promise<Json> {
    if (this.pending) return this.startPayload(this.pending);
    const verifier = b64url(randomBytes(64));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(32));
    const { server, port, wait } = await this.startServer(state);
    const redirect = `http://localhost:${port}${CALLBACK_PATH}`;
    const params = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirect, scope: SCOPE, code_challenge: challenge, code_challenge_method: "S256", state, originator: ORIGINATOR, id_token_add_organizations: "true", codex_cli_simplified_flow: "true" });
    const pending: Pending = { operation_id: b64url(randomBytes(24)), state, verifier, redirect_uri: redirect, authorize_url: `${ISSUER}/oauth/authorize?${params}`, deadline: Date.now() + 300000, server, port, resolve: undefined };
    this.pending = pending;
    void wait.then((cb) => this.finishLogin(pending, cb)).catch(() => this.failPending("login_failed"));
    return this.startPayload(pending);
  }
  private startPayload(p: Pending): Json {
    return { operation_id: p.operation_id, authorize_url: p.authorize_url, expires_in: Math.max(0, Math.floor((p.deadline - Date.now()) / 1000)), callback_port: p.port, callback_forward_port: 3782, redirect_uri: p.redirect_uri, ssh_forward_command: `ssh -N -L ${p.port}:127.0.0.1:3782 <ssh-user>@<server-host>` };
  }
  private async finishLogin(p: Pending, cb: { code?: string; state?: string; error?: string }) {
    try {
      if (cb.error) throw new AuthError(cb.error === "access_denied" ? "authorization_denied" : "oauth_callback_failed", "Codex sign-in was not authorized.", 401);
      if (!cb.state || !timingSafeEqual(Buffer.from(cb.state), Buffer.from(p.state))) throw new AuthError("state_mismatch", "Codex sign-in returned an invalid state.", 400);
      if (!cb.code) throw new AuthError("authorization_code_missing", "Codex sign-in did not return an authorization code.", 400);
      const payload = await this.tokenRequest({ client_id: CLIENT_ID, grant_type: "authorization_code", code: cb.code, redirect_uri: p.redirect_uri, code_verifier: p.verifier });
      const creds = this.credentialsFrom(payload, (this.credentials()?.generation ?? 0));
      this.saveCredentials(creds);
      await this.syncModels(creds);
      this.lastError = null;
    } catch (exc) {
      this.lastError = exc instanceof AuthError ? exc.code : "login_failed";
    } finally {
      p.server.close();
      if (this.pending === p) this.pending = null;
    }
  }
  private failPending(code: string) { this.lastError = code; if (this.pending) { this.pending.server.close(); this.pending = null; } }
  async completeLoginWithCallbackUrl(raw: string): Promise<Json> {
    const p = this.pending;
    if (!p) throw new AuthError("login_not_active", "Codex sign-in is not waiting for a callback.", 409);
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new AuthError("callback_url_invalid", "That does not look like a callback address.", 400); }
    const expected = new URL(p.redirect_uri);
    if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port || url.pathname !== expected.pathname) throw new AuthError("callback_url_invalid", "That address is not the callback this sign-in is waiting for.", 400);
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) throw new AuthError("callback_url_invalid", "That address repeats an OAuth parameter.", 400);
    const code = url.searchParams.get("code") ?? undefined;
    const state = url.searchParams.get("state") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    if (!code && !error) throw new AuthError("callback_url_invalid", "That address carries no authorization result.", 400);
    void this.finishLogin(p, { code, state, error });
    return this.publicStatus();
  }
  async cancelLogin(): Promise<Json> { if (this.pending) { this.pending.server.close(); this.pending = null; this.lastError = "login_cancelled"; } return this.publicStatus(); }
  private async accessToken(): Promise<Credentials> {
    const c = this.credentials();
    if (!c) throw new AuthError("authentication_required", "Sign in to Codex before using this model.", 401);
    if (c.rejected) throw new AuthError("authentication_required", "Codex sign-in could not be renewed. Sign in to Codex again.", 401);
    if (c.expires_at - Math.floor(Date.now() / 1000) > 300) return c;
    const payload = await this.tokenRequest({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: c.refresh_token }, true);
    const next = this.credentialsFrom(payload, c.generation, c);
    if (next.account_id !== c.account_id) throw new AuthError("account_changed", "Codex authentication returned a different account.", 409);
    this.saveCredentials(next);
    return next;
  }
  private async fetchModels(creds: Credentials): Promise<Json[]> {
    const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${creds.access_token}`, "Content-Type": "application/json", "OpenAI-Beta": "responses=experimental", originator: ORIGINATOR, version: "0.153.4", "chatgpt-account-id": creds.account_id }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new AuthError(res.status === 401 || res.status === 403 ? "catalog_unauthorized" : "catalog_fetch_failed", "Codex model catalog could not be fetched.", res.status === 401 || res.status === 403 ? 401 : 502);
    const payload = await res.json().catch(() => ({})) as Json;
    const rows = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : [];
    return rows.slice(0, 512).map((m) => isObj(m) ? m : { slug: String(m) }).map((m) => {
      const slug = String(m.slug ?? m.id ?? m.model ?? "");
      const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map(String) : [];
      return { slug, display_name: String(m.display_name ?? m.name ?? slug), priority: Number(m.priority ?? 0), default_reasoning_level: m.default_reasoning_level ? String(m.default_reasoning_level) : null, supported_reasoning_levels: levels, supports_reasoning_summary: Boolean(m.supports_reasoning_summary), supports_parallel_tool_calls: Boolean(m.supports_parallel_tool_calls), use_responses_lite: Boolean(m.use_responses_lite), context_window: Number(m.context_window ?? m.max_context_window ?? 0) || null, max_context_window: Number(m.max_context_window ?? m.context_window ?? 0) || null };
    }).filter((m) => m.slug);
  }
  private managedModels(models: Json[]): Json[] {
    return models.map((m) => ({ id: `llm-model-openai-codex-${createHash("sha256").update(m.slug).digest("hex").slice(0, 16)}`, name: m.display_name, model: m.slug, managed_by: MANAGED_BY, codex_priority: m.priority, codex_default_reasoning_level: m.default_reasoning_level, codex_supported_reasoning_levels: m.supported_reasoning_levels, codex_supports_reasoning_summary: m.supports_reasoning_summary, codex_supports_parallel_tool_calls: m.supports_parallel_tool_calls, codex_use_responses_lite: m.use_responses_lite, ...(m.context_window ? { context_window: String(m.context_window), context_window_source: "metadata" } : {}) }));
  }
  private syncCatalog(models: Json[], accountId: string): void {
    const catalog = loadCatalog(this.settings);
    const services = isObj(catalog.services) ? catalog.services : {};
    const llm = isObj(services.llm) ? services.llm : { active_profile_id: null, active_model_id: null, profiles: [] };
    const profiles = Array.isArray(llm.profiles) ? llm.profiles.filter(isObj) : [];
    const binding = createHash("sha256").update(accountId).digest("hex");
    const profile: Json = { id: PROFILE_ID, name: "OpenAI Codex", binding: "openai_codex", base_url: "https://chatgpt.com/backend-api", api_key: "", api_version: "", extra_headers: {}, managed_by: MANAGED_BY, read_only: true, owner_bound: true, codex_account_binding: binding, models: this.managedModels(models) };
    const idx = profiles.findIndex((p) => p.managed_by === MANAGED_BY);
    if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
    services.llm = { ...llm, profiles };
    catalog.services = services;
    saveCatalog(this.settings, catalog);
    this.write("catalog_snapshot", { account_id: accountId, models, fetched_at: Math.floor(Date.now() / 1000) });
    this.write("catalog_models", models);
  }
  private async syncModels(creds: Credentials) { const models = await this.fetchModels(creds); this.syncCatalog(models, creds.account_id); }
  async refreshModels(): Promise<Json> { const creds = await this.accessToken(); await this.syncModels(creds); return this.publicStatus(); }
  async logout(): Promise<Json> {
    await this.cancelLogin();
    const creds = this.credentials();
    if (creds) {
      try { await fetch("https://auth.openai.com/oauth/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, token: creds.refresh_token || creds.access_token, token_type_hint: creds.refresh_token ? "refresh_token" : "access_token" }), signal: AbortSignal.timeout(10000) }); } catch { /* remote revocation is best effort */ }
    }
    this.clearCredentials();
    const catalog = loadCatalog(this.settings);
    const services = isObj(catalog.services) ? catalog.services : {};
    const llm = isObj(services.llm) ? services.llm : {};
    if (Array.isArray(llm.profiles)) llm.profiles = llm.profiles.filter((p) => !isObj(p) || p.managed_by !== MANAGED_BY);
    services.llm = llm; catalog.services = services; saveCatalog(this.settings, catalog);
    return this.publicStatus();
  }
  async setReasoningEffort(model: string, effort: string | null): Promise<Json> {
    const creds = this.credentials();
    if (!creds) throw new AuthError("codex_catalog_unavailable", "Sign in to Codex before changing reasoning effort.", 409);
    const catalog = loadCatalog(this.settings);
    const profiles = Array.isArray(isObj(catalog.services) && isObj(catalog.services.llm) ? catalog.services.llm.profiles : []) ? (catalog.services.llm.profiles as Json[]) : [];
    const profile = profiles.find((p) => p.managed_by === MANAGED_BY);
    if (!profile) throw new AuthError("codex_catalog_unavailable", "Refresh Codex models before changing reasoning effort.", 409);
    const binding = createHash("sha256").update(creds.account_id).digest("hex");
    if (profile.codex_account_binding !== binding) throw new AuthError("codex_catalog_unavailable", "Refresh Codex models before changing reasoning effort.", 409);
    const modelRow = (profile.models as Json[]).find((m) => m.model === model);
    if (!modelRow) throw new AuthError("codex_model_not_found", "The selected model is not part of this Codex account.", 404);
    const supported = Array.isArray(modelRow.codex_supported_reasoning_levels) ? modelRow.codex_supported_reasoning_levels.map(String) : [];
    if (effort && !supported.includes(effort)) throw new AuthError("reasoning_effort_unsupported", "The selected Codex model does not support that reasoning effort.", 422);
    if (effort) modelRow.reasoning_effort = effort; else delete modelRow.reasoning_effort;
    saveCatalog(this.settings, catalog);
    return this.publicStatus();
  }
  publicStatus(): Json {
    const creds = this.credentials();
    const snapshot = this.read<Json | null>("catalog_snapshot", null);
    const models = this.read<Json[]>("catalog_models", []);
    const connected = Boolean(creds && !creds.rejected);
    return { connection: this.pending ? "authorizing" : creds?.rejected ? "error" : connected ? "connected" : this.lastError ? "error" : "disconnected", operation_id: this.pending?.operation_id ?? null, operation_state: this.pending ? "waiting" : this.lastError, authorize_url: this.pending?.authorize_url ?? null, expires_in: this.pending ? Math.max(0, Math.floor((this.pending.deadline - Date.now()) / 1000)) : null, callback_port: this.pending?.port ?? null, callback_forward_port: this.pending ? 3782 : null, redirect_uri: this.pending?.redirect_uri ?? null, model_count: Array.isArray(snapshot?.models) ? snapshot.models.length : models.length, catalog_source: connected ? "oauth" : null, catalog_fetched_at: snapshot?.fetched_at ?? null, active_model: null, models: [], activated: connected, error_code: creds?.rejected ? "authentication_required" : this.lastError };
  }
}
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
let codex: CodexOAuthService | null = null;
export function getCodexOAuthService(settings: Settings = getSettings()) { codex ??= new CodexOAuthService(settings); return codex; }

// CodeBuddy's upstream flow is owned by codebuddy-agent-sdk / the local CLI.
// There is no portable HTTP OAuth contract to call from this service; expose
// the same status shape and a stable error instead of fabricating a login.
export class CodeBuddyAuthService {
  private state: Json = { connection: "disconnected", operation_state: null, authorize_url: null, user_label: null, error_code: null };
  publicStatus() { return { ...this.state }; }
  async status() { return this.publicStatus(); }
  async startLogin() { this.state = { connection: "error", operation_state: "failed", authorize_url: null, user_label: null, error_code: "sdk_missing" }; return this.publicStatus(); }
  async cancelLogin() { this.state = { connection: "disconnected", operation_state: "cancelled", authorize_url: null, user_label: null, error_code: null }; return this.publicStatus(); }
  async logout() { this.state = { connection: "disconnected", operation_state: null, authorize_url: null, user_label: null, error_code: null }; return this.publicStatus(); }
}
let codebuddy: CodeBuddyAuthService | null = null;
export function getCodeBuddyAuthService() { codebuddy ??= new CodeBuddyAuthService(); return codebuddy; }
