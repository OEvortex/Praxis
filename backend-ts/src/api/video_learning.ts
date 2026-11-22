// Port of deeptutor/api/routers/video_learning.py — authenticated video
// providers, invidious account endpoints and timed-media material routes.
import { Hono } from "hono";
import type { Context } from "hono";
import { get_settings } from "../config.js";
import {
  TimedMediaError,
  TimedMediaNotFound,
  getTimedMediaStore,
  loadVideoLearningSettings,
  materialWithPlayback,
  normalizeVideoLearningSettings,
  refreshInvidiousTranscript,
  resolveMaterial,
  saveVideoLearningSettings,
  testInvidiousConnection,
} from "../services/video_learning/service.js";
import {
  createMark,
  deleteMark,
  getMark,
  marksList,
  suggestMarks,
  updateMark,
} from "../services/video_learning/marks.js";
import {
  createNote,
  deleteNote,
  exportNotes,
  listNotes,
  updateNote,
} from "../services/video_learning/notes.js";
import {
  authorizationFailureCode,
  beginInvidiousAccountAuthorization,
  browseInvidious,
  completeInvidiousAccountAuthorization,
  disconnectInvidiousAccount,
  invidiousAccountStatus,
  invidiousRedirectUri,
} from "../services/video_learning/invidious_account.js";

export const videoLearningRouter = new Hono();
export const videoLearningSettingsRouter = new Hono();

const STREAM_TIMEOUT_MS = 30_000;
const MAX_STREAM_REDIRECTS = 3;
const RANGE_HEADER_RE = /^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/;
const OWNER_ID = "local";

function httpError(c: Context, exc: unknown) {
  if (exc instanceof TimedMediaNotFound) {
    return c.json({ detail: String(exc.message) }, 404);
  }
  if (exc instanceof TimedMediaError) {
    return c.json({ detail: String(exc.message) }, 400);
  }
  return c.json({ detail: "Video learning could not complete the request." }, 500);
}

function noteError(c: Context, exc: unknown) {
  // NotebookCorruptedError has no TS equivalent yet; map to the same 409 shape
  // when the message matches, otherwise fall through to httpError.
  const msg = exc instanceof Error ? exc.message : String(exc);
  if (msg.includes("notebook_unreadable") || msg.includes("NotebookCorrupted")) {
    return c.json(
      { detail: { code: "notebook_unreadable", notebook_id: "", message: msg } },
      409,
    );
  }
  return httpError(c, exc);
}

async function jsonBody(c: Context): Promise<Record<string, any>> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// -- settings router ------------------------------------------------------------

// GET /api/settings/video-learning
videoLearningSettingsRouter.get("/api/settings/video-learning", (c) => {
  return c.json(loadVideoLearningSettings(get_settings()));
});

// PUT /api/settings/video-learning
videoLearningSettingsRouter.put("/api/settings/video-learning", async (c) => {
  try {
    const body = await jsonBody(c);
    return c.json(saveVideoLearningSettings(body, get_settings()));
  } catch (exc) {
    return httpError(c, exc);
  }
});

// POST /api/settings/video-learning/test-invidious
videoLearningSettingsRouter.post("/api/settings/video-learning/test-invidious", async (c) => {
  try {
    const body = await jsonBody(c);
    return c.json(await testInvidiousConnection(body, get_settings()));
  } catch (exc) {
    return httpError(c, exc);
  }
});

// -- invidious account ------------------------------------------------------------

// POST /api/video-learning/invidious/account/authorize
videoLearningRouter.post("/api/video-learning/invidious/account/authorize", (c) => {
  try {
    const url = beginInvidiousAccountAuthorization(
      { owner_id: OWNER_ID, redirect_uri: invidiousRedirectUri(get_settings()) },
      get_settings(),
    );
    return c.json({ authorize_url: url });
  } catch (exc) {
    return httpError(c, exc);
  }
});

// GET /api/video-learning/invidious/account/callback
videoLearningRouter.get("/api/video-learning/invidious/account/callback", async (c) => {
  const token = c.req.query("token") ?? "";
  const state = c.req.query("state") ?? "";
  let result = "connected";
  try {
    await completeInvidiousAccountAuthorization(
      { owner_id: OWNER_ID, state, token },
      get_settings(),
    );
  } catch (exc) {
    result = authorizationFailureCode(exc, Boolean(token));
  }
  return c.redirect(`/reading?account=${result}`, 303);
});

// GET /api/video-learning/invidious/browse/{kind}
videoLearningRouter.get("/api/video-learning/invidious/browse/:kind", async (c) => {
  try {
    const payload = await browseInvidious(
      {
        owner_id: OWNER_ID,
        kind: c.req.param("kind"),
        query: (c.req.query("q") ?? "").slice(0, 500),
        page: Math.min(Math.max(num(c.req.query("page"), 1), 1), 1000),
        playlist_id: (c.req.query("playlist_id") ?? "").slice(0, 100),
      },
      get_settings(),
    );
    return c.json(payload, 200, { "Cache-Control": "no-store" });
  } catch (exc) {
    return httpError(c, exc);
  }
});

// GET /api/video-learning/invidious/account/status
videoLearningRouter.get("/api/video-learning/invidious/account/status", (c) => {
  return c.json(invidiousAccountStatus(OWNER_ID, get_settings()));
});

// POST /api/video-learning/invidious/account/disconnect
videoLearningRouter.post("/api/video-learning/invidious/account/disconnect", async (c) => {
  try {
    return c.json(await disconnectInvidiousAccount({ owner_id: OWNER_ID }, get_settings()));
  } catch (exc) {
    return httpError(c, exc);
  }
});

// -- materials ---------------------------------------------------------------------

// POST /api/video-learning/materials/resolve
videoLearningRouter.post("/api/video-learning/materials/resolve", async (c) => {
  try {
    const body = await jsonBody(c);
    const url = String(body.url ?? "").slice(0, 2048);
    const language = String(body.language ?? "").slice(0, 32);
    const override = body.provider_override;
    if (override !== undefined && override !== null && override !== "youtube" && override !== "invidious") {
      throw new TimedMediaError("Unsupported provider override.");
    }
    return c.json(
      await resolveMaterial(
        url, language,
        (override as "youtube" | "invidious" | null | undefined) ?? null,
        get_settings(),
      ),
    );
  } catch (exc) {
    return httpError(c, exc);
  }
});

// GET /api/video-learning/materials/{material_id}
videoLearningRouter.get("/api/video-learning/materials/:material_id", async (c) => {
  try {
    return c.json(await materialWithPlayback(c.req.param("material_id"), get_settings()));
  } catch (exc) {
    return httpError(c, exc);
  }
});

// POST /api/video-learning/materials/{material_id}/transcript/refresh
videoLearningRouter.post(
  "/api/video-learning/materials/:material_id/transcript/refresh",
  async (c) => {
    try {
      return c.json(await refreshInvidiousTranscript(c.req.param("material_id"), get_settings()));
    } catch (exc) {
      return httpError(c, exc);
    }
  },
);

// PUT /api/video-learning/materials/{material_id}/progress
videoLearningRouter.put("/api/video-learning/materials/:material_id/progress", async (c) => {
  try {
    const body = await jsonBody(c);
    const timeSeconds = num(body.time_seconds);
    const durationSeconds = num(body.duration_seconds);
    if (timeSeconds < 0 || timeSeconds > 24 * 60 * 60 || durationSeconds < 0 || durationSeconds > 24 * 60 * 60) {
      return c.json({ detail: "Progress values are outside the allowed range." }, 400);
    }
    const store = getTimedMediaStore(get_settings());
    const materialId = c.req.param("material_id");
    return await store.withLock(materialId, () => {
      const material = store.get(materialId);
      const knownDuration = num(material.metadata?.duration_seconds);
      const duration = knownDuration || durationSeconds;
      const position = duration > 0 ? Math.min(timeSeconds, duration) : timeSeconds;
      if (material.learning === null || typeof material.learning !== "object") material.learning = {};
      material.learning.last_position = position;
      if (duration > 0) {
        if (material.metadata === null || typeof material.metadata !== "object") material.metadata = {};
        material.metadata.duration_seconds = duration;
      }
      store.save(material);
      return c.json({ time_seconds: position, duration_seconds: duration });
    });
  } catch (exc) {
    return httpError(c, exc);
  }
});

// -- notes ---------------------------------------------------------------------------

// GET /api/video-learning/materials/{material_id}/notes
videoLearningRouter.get("/api/video-learning/materials/:material_id/notes", (c) => {
  try {
    return c.json(listNotes(c.req.param("material_id"), get_settings()));
  } catch (exc) {
    return noteError(c, exc);
  }
});

// GET /api/video-learning/materials/{material_id}/notes.md
videoLearningRouter.get("/api/video-learning/materials/:material_id/notes.md", (c) => {
  try {
    const markdown = exportNotes(c.req.param("material_id"), get_settings());
    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown",
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="video-notes.md"',
      },
    });
  } catch (exc) {
    return noteError(c, exc);
  }
});

// POST /api/video-learning/materials/{material_id}/notes
videoLearningRouter.post("/api/video-learning/materials/:material_id/notes", async (c) => {
  try {
    const body = await jsonBody(c);
    const noteBody = String(body.body ?? "");
    if (!noteBody.trim() || noteBody.length > 20_000) {
      return c.json({ detail: "A timed-media note needs text." }, 400);
    }
    const timeSeconds = num(body.time_seconds);
    if (timeSeconds < 0 || timeSeconds > 24 * 60 * 60) {
      return c.json({ detail: "Timed-media note timestamp is outside the allowed range." }, 400);
    }
    return c.json(createNote(c.req.param("material_id"), noteBody, timeSeconds, get_settings()));
  } catch (exc) {
    return noteError(c, exc);
  }
});

// PUT /api/video-learning/materials/{material_id}/notes/{note_id}
videoLearningRouter.put(
  "/api/video-learning/materials/:material_id/notes/:note_id",
  async (c) => {
    try {
      const body = await jsonBody(c);
      const noteBody = String(body.body ?? "");
      if (!noteBody.trim() || noteBody.length > 20_000) {
        return c.json({ detail: "A timed-media note needs text." }, 400);
      }
      return c.json(
        updateNote(c.req.param("material_id"), c.req.param("note_id"), noteBody, get_settings()),
      );
    } catch (exc) {
      return noteError(c, exc);
    }
  },
);

// DELETE /api/video-learning/materials/{material_id}/notes/{note_id}
videoLearningRouter.delete(
  "/api/video-learning/materials/:material_id/notes/:note_id",
  (c) => {
    try {
      const deleted = deleteNote(
        c.req.param("material_id"), c.req.param("note_id"), get_settings(),
      );
      return c.json({ status: deleted ? "deleted" : "missing" });
    } catch (exc) {
      return noteError(c, exc);
    }
  },
);

// -- marks ---------------------------------------------------------------------------

// GET /api/video-learning/materials/{material_id}/marks
videoLearningRouter.get("/api/video-learning/materials/:material_id/marks", (c) => {
  try {
    const material = getTimedMediaStore(get_settings()).get(c.req.param("material_id"));
    return c.json(marksList(material));
  } catch (exc) {
    return httpError(c, exc);
  }
});

// GET /api/video-learning/materials/{material_id}/marks/{mark_id}
videoLearningRouter.get("/api/video-learning/materials/:material_id/marks/:mark_id", (c) => {
  try {
    const material = getTimedMediaStore(get_settings()).get(c.req.param("material_id"));
    return c.json(getMark(material, c.req.param("mark_id")));
  } catch (exc) {
    return httpError(c, exc);
  }
});

// POST /api/video-learning/materials/{material_id}/marks
videoLearningRouter.post("/api/video-learning/materials/:material_id/marks", async (c) => {
  try {
    const body = await jsonBody(c);
    const store = getTimedMediaStore(get_settings());
    const materialId = c.req.param("material_id");
    return await store.withLock(materialId, () => {
      const material = store.get(materialId);
      const mark = createMark(material, body);
      store.save(material);
      return c.json(mark, 201);
    });
  } catch (exc) {
    return httpError(c, exc);
  }
});

// PATCH /api/video-learning/materials/{material_id}/marks/{mark_id}
videoLearningRouter.patch(
  "/api/video-learning/materials/:material_id/marks/:mark_id",
  async (c) => {
    try {
      const body = await jsonBody(c);
      const store = getTimedMediaStore(get_settings());
      const materialId = c.req.param("material_id");
      return await store.withLock(materialId, () => {
        const material = store.get(materialId);
        const mark = updateMark(material, c.req.param("mark_id"), body);
        store.save(material);
        return c.json(mark);
      });
    } catch (exc) {
      return httpError(c, exc);
    }
  },
);

// DELETE /api/video-learning/materials/{material_id}/marks/{mark_id}
videoLearningRouter.delete(
  "/api/video-learning/materials/:material_id/marks/:mark_id",
  async (c) => {
    try {
      const store = getTimedMediaStore(get_settings());
      const materialId = c.req.param("material_id");
      return await store.withLock(materialId, () => {
        const material = store.get(materialId);
        deleteMark(material, c.req.param("mark_id"));
        store.save(material);
        return c.json({ ok: true });
      });
    } catch (exc) {
      return httpError(c, exc);
    }
  },
);

// POST /api/video-learning/materials/{material_id}/mark-suggestions
videoLearningRouter.post(
  "/api/video-learning/materials/:material_id/mark-suggestions",
  async (c) => {
    try {
      const body = await jsonBody(c);
      const material = getTimedMediaStore(get_settings()).get(c.req.param("material_id"));
      const suggestions = await suggestMarks(material, num(body.time_seconds), get_settings());
      return c.json({ suggestions });
    } catch (exc) {
      return httpError(c, exc);
    }
  },
);

// -- subtitles.vtt ---------------------------------------------------------------------

function vttTimestamp(value: unknown): string {
  const ms = Math.round(Math.max(0, Number(value) || 0) * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

// GET /api/video-learning/materials/{material_id}/subtitles.vtt
videoLearningRouter.get("/api/video-learning/materials/:material_id/subtitles.vtt", (c) => {
  try {
    const material = getTimedMediaStore(get_settings()).get(c.req.param("material_id"));
    const cues = Array.isArray(material.transcript?.cues) ? material.transcript.cues : [];
    const lines = ["WEBVTT", ""];
    let index = 0;
    for (const cue of cues) {
      if (cue === null || typeof cue !== "object") continue;
      const text = String((cue as Record<string, unknown>).text ?? "").trim();
      if (!text) continue;
      index += 1;
      const flat = text.split(/\s+/).join(" ")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      lines.push(
        String(index),
        `${vttTimestamp((cue as Record<string, unknown>).start)} --> ${vttTimestamp((cue as Record<string, unknown>).end)}`,
        flat,
        "",
      );
    }
    return new Response(lines.join("\n"), {
      headers: { "Content-Type": "text/vtt", "Cache-Control": "no-store" },
    });
  } catch (exc) {
    return httpError(c, exc);
  }
});

// -- stream proxy ---------------------------------------------------------------------

function allowedStreamUrl(value: string, invidiousBase: string, publicBase = ""): string {
  const absolute = new URL(value, `${invidiousBase}/`).toString();
  const parsed = new URL(absolute);
  const trusted: URL[] = [new URL(invidiousBase)];
  if (publicBase) trusted.push(new URL(publicBase));
  const host = (parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !host || parsed.username || parsed.password
  ) {
    throw new TimedMediaError("Invidious returned an invalid stream URL.");
  }
  let parsedPort: number | null;
  try {
    parsedPort = parsed.port ? Number(parsed.port) : null;
  } catch {
    throw new TimedMediaError("Invidious returned a stream URL with an invalid port.");
  }
  const trustedPorts = trusted.map((o) => (o.port ? Number(o.port) : null));
  const sameOrigin = trusted.some(
    (origin, i) =>
      host === (origin.hostname || "").toLowerCase().replace(/\.$/, "") &&
      parsed.protocol === origin.protocol &&
      parsedPort === trustedPorts[i],
  );
  const googleMedia =
    (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) &&
    parsed.protocol === "https:" &&
    (parsedPort === null || parsedPort === 443);
  if (!sameOrigin && !googleMedia) {
    throw new TimedMediaError("Invidious returned a stream outside its allowed media hosts.");
  }
  return absolute;
}

async function liveStreamUrl(materialId: string, formatId: string): Promise<[string, string]> {
  if (!/^[0-9]{1,6}$/.test(formatId)) {
    throw new TimedMediaNotFound("Video format was not found.");
  }
  const settings = get_settings();
  const material = getTimedMediaStore(settings).get(materialId);
  const source = material.source !== null && typeof material.source === "object"
    ? (material.source as Record<string, unknown>) : {};
  const videoId = String(source.video_id ?? "");
  const vSettings = loadVideoLearningSettings(settings);
  const inv = vSettings.invidious as Record<string, unknown>;
  const base = String(inv.api_base_url ?? "");
  const publicBase = String(inv.public_base_url ?? "");
  const configuredFormats = material.provider_cache?.invidious_formats ?? [];
  if (!base || !configuredFormats.some((row: Record<string, unknown>) => String(row.format_id ?? "") === formatId)) {
    throw new TimedMediaError("Stream proxy is available only for an Invidious descriptor.");
  }
  const res = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (res.status >= 400) {
    throw new TimedMediaError(`Invidious request failed with HTTP ${res.status}.`);
  }
  let metadata: unknown;
  try {
    metadata = await res.json();
  } catch {
    throw new TimedMediaError("Invidious returned invalid video metadata.");
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TimedMediaError("Invidious returned invalid video metadata.");
  }
  const streams = (metadata as Record<string, unknown>).formatStreams;
  for (const row of Array.isArray(streams) ? streams : []) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (String(r.itag ?? "") !== formatId) continue;
    const mime = String(r.type ?? "video/mp4").split(";", 1)[0];
    if (mime !== "video/mp4") {
      throw new TimedMediaError("Invidious changed the selected stream format.");
    }
    return [allowedStreamUrl(String(r.url ?? ""), base, publicBase), mime];
  }
  throw new TimedMediaNotFound("Video format was not found.");
}

async function openUpstream(
  url: string, mime: string, rangeHeader: string | null,
): Promise<{ response: Response; url: string }> {
  const settings = get_settings();
  const vSettings = loadVideoLearningSettings(settings);
  const inv = vSettings.invidious as Record<string, unknown>;
  const base = String(inv.api_base_url ?? "");
  const publicBase = String(inv.public_base_url ?? "");
  const headers: Record<string, string> = {
    "User-Agent": "DeepTutor/1.0",
    Accept: mime,
  };
  if (rangeHeader) headers.Range = rangeHeader;
  let current = url;
  for (let i = 0; i <= MAX_STREAM_REDIRECTS; i += 1) {
    const res = await fetch(current, {
      headers,
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      redirect: "manual",
    });
    if (res.status < 300 || res.status >= 400) {
      return { response: res, url: current };
    }
    const location = res.headers.get("location");
    if (!location) break;
    current = allowedStreamUrl(new URL(location, current).toString(), base, publicBase);
  }
  throw new TimedMediaError("Video stream returned too many redirects.");
}

// GET|HEAD /api/video-learning/materials/{material_id}/stream/{format_id}
const streamHandler = async (c: Context) => {
  try {
    const rangeHeader = c.req.header("range") ?? null;
    if (rangeHeader && !RANGE_HEADER_RE.test(rangeHeader.trim())) {
      return c.json({ detail: "Only a single byte range is supported." }, 416);
    }
    const [url, mime] = await liveStreamUrl(c.req.param("material_id") ?? "", c.req.param("format_id") ?? "");
    if (c.req.method === "HEAD") {
      return c.body(null, 200, {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
      });
    }
    const { response } = await openUpstream(url, mime, rangeHeader);
    if (![200, 206].includes(response.status)) {
      const status = response.status;
      await response.body?.cancel();
      if (status >= 400) {
        return c.json({ detail: "Upstream video stream failed." }, status as never);
      }
      return c.json({ detail: "Upstream video stream returned an invalid status." }, 502);
    }
    const headers: Record<string, string> = {
      "Content-Type": response.headers.get("content-type") ?? mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    for (const key of ["content-length", "content-range", "etag", "last-modified"]) {
      const v = response.headers.get(key);
      if (v) headers[key.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("-")] = v;
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (exc) {
    if (exc instanceof Response) return exc;
    return httpError(c, exc);
  }
};

videoLearningRouter.get("/api/video-learning/materials/:material_id/stream/:format_id", streamHandler);
videoLearningRouter.on("HEAD", "/api/video-learning/materials/:material_id/stream/:format_id", streamHandler);
