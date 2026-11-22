// browser layout
// check for a built video lesson.
//
// The compile/render check proves the lesson runs; it cannot see that a drawing
// crosses a title or that a label lands on a card. This opens the finished page
// in headless Chrome at sample frames, measures every visible text box and
// samples points along every visible SVG stroke, and reports collisions in the
// 1920x1080 composition's own coordinates so the writer can move things.

import { execFile } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CAPTION_TOP = 880; // the kit's captions own everything below this line
const MAX_ISSUES = 14;

const PROBE = `
<script>
(function () {
  function opacityOf(el) {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      o *= parseFloat(cs.opacity || "1");
    }
    return o;
  }
  function probe() {
    const root = [...document.querySelectorAll("div")].find(
      (d) => d.style.width === "1920px" && d.style.height === "1080px");
    if (!root) return {error: "composition root not found"};
    const r = root.getBoundingClientRect(), k = r.width / 1920;
    const toC = (x, y) => [(x - r.left) / k, (y - r.top) / k];
    const texts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.textContent.trim();
      if (!s || !n.parentElement || opacityOf(n.parentElement) < 0.15) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const b of range.getClientRects()) {
        if (b.width < 2 || b.height < 2) continue;
        const [x0, y0] = toC(b.left, b.top), [x1, y1] = toC(b.right, b.bottom);
        const cap = !!n.parentElement.closest('div[style*="bottom: 64px"]');
        texts.push({el: n.parentElement, s: s.slice(0, 48), cap, x0, y0, x1, y1});
      }
    }
    const issues = [];
    // text on text
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.cap || b.cap || a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (w > 4 && h > 4) issues.push(\`text "\${a.s}" overlaps text "\${b.s}" near x=\${Math.round(Math.max(a.x0, b.x0))}, y=\${Math.round(Math.max(a.y0, b.y0))}\`);
    }
    // text leaving the safe area
    for (const t of texts) {
      if (t.cap) {
        if (t.y0 < ${CAPTION_TOP} - 60) issues.push(\`the caption "\${t.s}" wraps to three lines and climbs to y=\${Math.round(t.y0)}; split that narration sentence (keep each under 18 words)\`);
        continue;
      }
      if (t.y1 > ${CAPTION_TOP} + 2) issues.push(\`text "\${t.s}" reaches y=\${Math.round(t.y1)}, inside the caption band (keep everything above y=${CAPTION_TOP})\`);
      if (t.x0 < 40 || t.x1 > 1880 || t.y0 < 20) issues.push(\`text "\${t.s}" runs off the frame edge\`);
    }
    // strokes through text / into the caption band
    // opaque boxes (cards, panels) covering text that is not inside them
    const opaque = (cs) => {
      const m = (cs.backgroundColor || "").match(/rgba?\\(([^)]+)\\)/);
      if (!m) return false;
      const parts = m[1].split(",").map(Number);
      return parts.length < 4 || parts[3] > 0.6;
    };
    for (const box of root.querySelectorAll("div,section,aside")) {
      if (box === root || opacityOf(box) < 0.15 || !opaque(getComputedStyle(box))) continue;
      const b = box.getBoundingClientRect();
      const [bx0, by0] = toC(b.left, b.top), [bx1, by1] = toC(b.right, b.bottom);
      if (bx1 - bx0 < 40 || by1 - by0 < 20 || (bx1 - bx0 > 1800 && by1 - by0 > 1000)) continue;
      const label = (box.textContent || "").trim().slice(0, 32);
      for (const t of texts) {
        if (t.cap || box.contains(t.el) || t.el.contains(box)) continue;
        const w = Math.min(t.x1, bx1) - Math.max(t.x0, bx0), h = Math.min(t.y1, by1) - Math.max(t.y0, by0);
        if (w > 4 && h > 4) issues.push(\`the box "\${label}" (x \${Math.round(bx0)}-\${Math.round(bx1)}, y \${Math.round(by0)}-\${Math.round(by1)}) covers the text "\${t.s}"; move one of them\`);
      }
    }
    const crossed = new Map(); const bandHits = [];
    const shapes = root.querySelectorAll("path,line,polyline,polygon,circle,ellipse,rect");
    for (const g of shapes) {
      if (!g.getTotalLength || opacityOf(g) < 0.15) continue;
      const cs = getComputedStyle(g);
      if (cs.stroke === "none" || parseFloat(cs.strokeWidth || "0") <= 0) continue;
      let L; try { L = g.getTotalLength(); } catch (e) { continue; }
      if (!L || L < 4) continue;
      let visible = L;
      const dash = (cs.strokeDasharray || "none").split(/[ ,]+/).map(parseFloat).filter((v) => !isNaN(v));
      if (dash.length && dash[0] >= L * 0.95) visible = Math.max(0, L - Math.abs(parseFloat(cs.strokeDashoffset || "0")));
      const m = g.getScreenCTM(); if (!m) continue;
      const svg = g.ownerSVGElement;
      const hitText = new Map(); let inBand = null;
      const n = Math.min(400, Math.max(8, Math.ceil(visible / 6)));
      for (let i = 0; i <= n; i++) {
        const p = g.getPointAtLength((visible * i) / n);
        const sp = svg.createSVGPoint(); sp.x = p.x; sp.y = p.y;
        const q = sp.matrixTransform(m); const [x, y] = toC(q.x, q.y);
        if (y > ${CAPTION_TOP} + 3 && y < 1080 && x > 0 && x < 1920) inBand = inBand || [x, y];
        for (const t of texts) {
          if (x > t.x0 + 2 && x < t.x1 - 2 && y > t.y0 + 2 && y < t.y1 - 2) {
            const e = hitText.get(t.s) || {count: 0, x, y}; e.count++; hitText.set(t.s, e);
          }
        }
      }
      for (const [s, e] of hitText) if (e.count >= 2) {
        const c = crossed.get(s) || {n: 0, x: e.x, y: e.y}; c.n++; crossed.set(s, c);
      }
      if (inBand) bandHits.push(inBand);
    }
    for (const [s, c] of crossed) issues.push(\`\${c.n} drawn line\${c.n > 1 ? "s" : ""} cross the text "\${s}" near x=\${Math.round(c.x)}, y=\${Math.round(c.y)}; move the text or shrink/move the drawing so they no longer meet\`);
    if (bandHits.length) {
      const ys = bandHits.map((p) => p[1]), xs = bandHits.map((p) => p[0]);
      issues.push(\`\${bandHits.length} drawn shape\${bandHits.length > 1 ? "s" : ""} enter the caption band (x \${Math.round(Math.min(...xs))}-\${Math.round(Math.max(...xs))}, down to y=\${Math.round(Math.max(...ys))}); keep every drawing above y=${CAPTION_TOP}\`);
    }
    return {issues: [...new Set(issues)]};
  }
  window.addEventListener("load", () => setTimeout(() => {
    let out; try { out = probe(); } catch (e) { out = {error: String(e)}; }
    parent.postMessage({frame: new URLSearchParams(location.search).get("frame"), ...out}, "*");
  }, 1500));
})();
</script>
`;

const HOST = `<!doctype html><html><body><pre id="out"></pre><script>
const frames = __FRAMES__, got = {};
for (const f of frames) {
  const i = document.createElement("iframe");
  i.width = 1280; i.height = 760; i.src = "probe.html?frame=" + f;
  document.body.appendChild(i);
}
addEventListener("message", (e) => {
  got[e.data.frame] = e.data;
  if (Object.keys(got).length === frames.length) document.getElementById("out").textContent = JSON.stringify(got);
});
</script></body></html>`;

function which(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function chromePath(): string | null {
  /** Use an explicit browser first, then standard cross-platform installs. */
  const configured = (process.env.PRAXIS_CHROME_EXECUTABLE ?? "").trim();
  if (configured) {
    const path = configured.replace(/^~(?=$|\/)/, homedir());
    try {
      readFileSync(path);
      return path;
    } catch {
      return null;
    }
  }
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
    "msedge",
  ]) {
    const found = which(name);
    if (found) return found;
  }
  const candidates: string[] = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const name of ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] as const) {
    const root = process.env[name];
    if (root) {
      candidates.push(
        join(root, "Google/Chrome/Application/chrome.exe"),
        join(root, "Microsoft/Edge/Application/msedge.exe"),
      );
    }
  }
  for (const path of candidates) {
    try {
      readFileSync(path);
      return path;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function sampleFrames(total: number, fps = 30, everyS = 4.0): number[] {
  const step = Math.max(1, Math.floor(everyS * fps));
  const out: number[] = [];
  for (let f = Math.floor(step / 2); f < Math.max(total - 1, 1); f += step) {
    out.push(f);
  }
  return out.length ? out : [0];
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function checkLayout(
  page: string,
  frames: number[],
  timeoutS = 180,
): Promise<string[] | null> {
  /** Collision report for `page` at `frames`; `null` when no browser is available. */
  const chrome = chromePath();
  if (!chrome || frames.length === 0) return null;
  const tmp = mkdtempSync(join(tmpdir(), "vl-layout-"));
  try {
    const html = readFileSync(page, "utf-8");
    writeFileSync(
      join(tmp, "probe.html"),
      html.replace("</body>", PROBE + "</body>"),
      "utf-8",
    );
    writeFileSync(
      join(tmp, "host.html"),
      HOST.replace("__FRAMES__", JSON.stringify(frames)),
      "utf-8",
    );
    const argv = [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--allow-file-access-from-files",
      `--user-data-dir=${join(tmp, "profile")}`,
      `--virtual-time-budget=${8000 + 400 * frames.length}`,
      "--dump-dom",
      `file://${join(tmp, "host.html")}`,
    ];
    let stdout: string;
    try {
      // --dump-dom is UTF-8 and quotes the lesson's own text; forcing UTF-8
      // avoids the server's ANSI code page (cp936, cp932, ...) mangling it.
      const { stdout: out } = await execFileAsync(argv[0], argv.slice(1), {
        encoding: "utf-8",
        timeout: timeoutS * 1000,
        maxBuffer: 64 * 1024 * 1024,
      });
      stdout = out;
    } catch {
      return null; // timeout or non-zero exit
    }
    const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout);
    if (!m || !m[1].trim()) return null;
    let data: Record<string, Record<string, unknown>>;
    try {
      data = JSON.parse(unescapeHtml(m[1])) as Record<
        string,
        Record<string, unknown>
      >;
    } catch {
      return null;
    }
    if (
      typeof data !== "object" ||
      data === null ||
      frames.some((frame) => {
        const entry = data[String(frame)];
        return typeof entry !== "object" || entry === null || entry.error;
      })
    ) {
      return null;
    }
    const seen = new Map<string, number[]>();
    for (const frame of Object.keys(data).sort((a, b) => Number(a) - Number(b))) {
      const issues = (data[frame].issues as string[] | undefined) ?? [];
      for (const issue of issues) {
        const list = seen.get(issue) ?? [];
        list.push(Number(frame));
        seen.set(issue, list);
      }
    }
    return [...seen.entries()]
      .slice(0, MAX_ISSUES)
      .map(
        ([issue, fs]) =>
          `at ${fs
            .slice(0, 4)
            .map((f) => `${(f / 30).toFixed(0)}s`)
            .join(", ")}: ${issue}`,
      );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
