/**
 * OpenUI server-side proxy endpoints (image search, street routing, Wikipedia).
 * httpx replaced with fetch.
 */

import { Hono } from "hono";
import type { Context } from "hono";

export const openuiRouter = new Hono();

const HEADERS: Record<string, string> = {
  "User-Agent": "open-intelligent-ui (https://github.com/thesysdev/open-intelligent-ui)",
};
const CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
};

const SKIP_IMAGE_RE = /\.svg|icon|logo|map|flag|seal|coat_of_arms|signature|diagram/i;
const SKIP_WIKI_RE = /\.svg|icon|logo|map|flag|seal/i;
const IMAGE_WIDTH = 960;
const MAX_STOPS = 25;

type Json = Record<string, unknown>;

// -- bounded FIFO cache ------------------------------------------------------

/** In-memory FIFO-bounded cache preserving insertion order (Map is ordered). */
export class BoundedCache<V = unknown> {
  private readonly maxSize: number;
  private readonly data = new Map<string, V>();

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    return this.data.get(key);
  }

  set(key: string, value: V): void {
    if (!this.data.has(key) && this.data.size >= this.maxSize) {
      const oldest = this.data.keys().next().value;
      if (oldest !== undefined) this.data.delete(oldest);
    }
    this.data.set(key, value);
  }
}

const imageCache = new BoundedCache<unknown>(500);
const routeCache = new BoundedCache<unknown>(200);
const wikiCache = new BoundedCache<unknown>(500);

// -- helpers -----------------------------------------------------------------

function words(text: string): string[] {
  // Python re.split(r"[^\w]+", text.lower()) — \w is unicode-aware there.
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 3);
}

/** Python f"{n:g}" — 6 significant digits, trailing zeros stripped. */
function fmtG(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(n)));
  let s: string;
  if (exp < -4 || exp >= 6) {
    // %e style; Python pads exponent to two digits ("1e-05"), JS does not.
    s = n
      .toExponential(5)
      .replace(/(\.\d*?)0+e/, "$1e")
      .replace(/\.e/, "e");
  } else {
    const decimals = Math.max(0, 5 - exp);
    s = n
      .toFixed(decimals)
      .replace(/0+$/, "")
      .replace(/\.$/, "");
  }
  return s;
}

async function wikiQuery(
  host: string,
  params: Record<string, string>,
): Promise<Json[]> {
  const url =
    `https://${host}/w/api.php?` +
    new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      ...params,
    }).toString();
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`${host} HTTP ${resp.status}`);
  const data = (await resp.json()) as Json;
  if (data.error) throw new Error(`${host} error`);
  const pages = ((data.query as Json | undefined)?.pages as Json[] | undefined) ?? [];
  return [...pages].sort(
    (a, b) => Number(a.index ?? 0) - Number(b.index ?? 0),
  );
}

async function searchImagesImpl(q: string): Promise<string[]> {
  const images: string[] = [];

  const add = (url: unknown): void => {
    if (
      typeof url === "string" &&
      url.startsWith("https://") &&
      !SKIP_IMAGE_RE.test(url) &&
      !images.includes(url)
    ) {
      images.push(url);
    }
  };

  const wanted = new Set(words(q));

  const articles = await wikiQuery("en.wikipedia.org", {
    generator: "search",
    gsrsearch: q,
    gsrlimit: "6",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: String(IMAGE_WIDTH),
  });
  for (const page of articles) {
    const title = (page.title as string | undefined) ?? "";
    if (words(title).some((w) => wanted.has(w))) {
      add(((page.thumbnail as Json | undefined)?.source) as string | undefined);
    }
  }

  const terms = q.split(/\s+/).filter(Boolean);
  const tries = [...new Set([terms.join(" "), terms.slice(0, 3).join(" "), terms.slice(0, 2).join(" ")])].filter(Boolean);
  for (const term of tries) {
    if (images.length >= 3) break;
    const files = await wikiQuery("commons.wikimedia.org", {
      generator: "search",
      gsrsearch: `${term} filetype:bitmap`,
      gsrnamespace: "6",
      gsrlimit: "6",
      prop: "imageinfo",
      iiprop: "url|mime",
      iiurlwidth: String(IMAGE_WIDTH),
    });
    for (const page of files) {
      const infoList = (page.imageinfo as Json[] | undefined) ?? [];
      const info = infoList[0];
      if (info && String(info.mime ?? "").startsWith("image/")) {
        add((info.thumburl as string | undefined) ?? (info.url as string | undefined));
      }
    }
  }

  return images.slice(0, 4);
}

function errorJson(c: Context, status: number, message: string) {
  return c.json({ error: { message } }, status as 400 | 502);
}

// -- routes ------------------------------------------------------------------

openuiRouter.get("/api/openui/image-search", async (c) => {
  const q = c.req.query("q") ?? "";
  const cleaned = q.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 200) {
    return errorJson(c, 400, "q must be 2 to 200 characters");
  }
  let images = imageCache.get(cleaned) as string[] | undefined;
  if (images === undefined) {
    try {
      images = await searchImagesImpl(cleaned);
    } catch {
      return errorJson(c, 502, "Image search unavailable");
    }
    imageCache.set(cleaned, images);
  }
  for (const [k, v] of Object.entries(CACHE_HEADERS)) c.header(k, v);
  return c.json({ images });
});

/**
 * Parse ``lng,lat;lng,lat;...`` into 2–25 valid finite coordinate pairs.
 * Returns null on any malformed pair (mirrors Python's None).
 */
export function parseCoords(coords: string): [number, number][] | null {
  const rawPairs = coords ? coords.split(";") : [];
  if (rawPairs.length < 2 || rawPairs.length > MAX_STOPS) return null;
  const points: [number, number][] = [];
  for (const pair of rawPairs) {
    const parts = pair.split(",");
    if (parts.length !== 2) return null;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    // Number("") is 0 — guard like Python float() which rejects empty strings.
    if (parts[0].trim() === "" || parts[1].trim() === "") return null;
    if (
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      Math.abs(lng) > 180 ||
      Math.abs(lat) > 90
    ) {
      return null;
    }
    points.push([lng, lat]);
  }
  return points;
}

openuiRouter.get("/api/openui/street-route", async (c) => {
  const coords = c.req.query("coords") ?? "";
  const points = parseCoords(coords);
  if (points === null) {
    return errorJson(c, 400, `coords must be 2–${MAX_STOPS} lng,lat pairs`);
  }

  const key = points.map(([lng, lat]) => `${fmtG(lng)},${fmtG(lat)}`).join(";");
  let route = routeCache.get(key) as unknown[] | undefined;
  if (route === undefined) {
    try {
      const url =
        `https://router.project-osrm.org/route/v1/driving/${key}?` +
        new URLSearchParams({ overview: "full", geometries: "geojson", steps: "false" }).toString();
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
      const data = (await resp.json()) as Json;
      const routes = (data.routes as Json[] | undefined) ?? [{}];
      const coordinates =
        (((routes[0]?.geometry as Json | undefined)?.coordinates as unknown[]) ?? []);
      if (data.code !== "Ok" || coordinates.length < 2) {
        throw new Error("No street route");
      }
      // GeoJSON coordinates are [lng, lat]; the wire format is [lat, lng].
      route = (coordinates as [number, number][]).map(([lng, lat]) => [lat, lng]);
      routeCache.set(key, route);
    } catch {
      return errorJson(c, 502, "Street routing unavailable");
    }
  }
  for (const [k, v] of Object.entries(CACHE_HEADERS)) c.header(k, v);
  return c.json({ points: route });
});

async function wikiGet(url: string): Promise<Json> {
  const resp = await fetch(url, { headers: HEADERS });
  if (resp.status === 404) return {};
  if (!resp.ok) throw new Error(`Wikipedia HTTP ${resp.status}`);
  return (await resp.json()) as Json;
}

function photoKey(url: string): string {
  const noQuery = url.split("?")[0];
  const filename = decodeURIComponent(noQuery.slice(noQuery.lastIndexOf("/") + 1));
  return filename.replace(/^\d+px-/, "");
}

/** Lead + media-list photos and coordinates for an exact article title. */
export async function wikiPhotos(title: string): Promise<Json> {
  const encoded = encodeURIComponent(title.replace(/ /g, "_"));
  const [summary, media] = await Promise.all([
    wikiGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`),
    wikiGet(`https://en.wikipedia.org/api/rest_v1/page/media-list/${encoded}`),
  ]);

  const photos: string[] = [];
  const seenKeys = new Set<string>();
  const lead = ((summary.thumbnail as Json | undefined)?.source) as string | undefined;
  if (lead) {
    photos.push(lead);
    seenKeys.add(photoKey(lead));
  }
  for (const item of (media.items as Json[] | undefined) ?? []) {
    const srcset = (item.srcset as Json[] | undefined) ?? [];
    if (item.type !== "image" || srcset.length === 0) continue;
    const srcRaw = String(srcset[0]?.src ?? "");
    if (!srcRaw || SKIP_WIKI_RE.test(srcRaw)) continue;
    const url = srcRaw.startsWith("//") ? `https:${srcRaw}` : srcRaw;
    const k = photoKey(url);
    if (!seenKeys.has(k)) {
      photos.push(url);
      seenKeys.add(k);
    }
    if (photos.length >= 3) break;
  }
  const coords = (summary.coordinates as Json | undefined) ?? {};
  const info: Json = { photos };
  if (coords.lat !== null && coords.lat !== undefined) info.lat = coords.lat;
  if (coords.lon !== null && coords.lon !== undefined) info.lng = coords.lon;
  return info;
}

/** Fuzzy image URLs for a free-text query (Wikipedia + Commons). */
export async function searchImages(query: string): Promise<string[]> {
  return searchImagesImpl(query);
}

openuiRouter.get("/api/openui/wiki", async (c) => {
  const title = (c.req.query("title") ?? "").trim();
  if (!title || title.length > 200) {
    return errorJson(c, 400, "title is required");
  }
  let info = wikiCache.get(title) as Json | undefined;
  if (info === undefined) {
    try {
      info = await wikiPhotos(title);
      wikiCache.set(title, info);
    } catch {
      return errorJson(c, 502, "Wikipedia unavailable");
    }
  }
  for (const [k, v] of Object.entries(CACHE_HEADERS)) c.header(k, v);
  return c.json(info);
});
