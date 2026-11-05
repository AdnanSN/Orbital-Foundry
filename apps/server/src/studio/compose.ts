import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { FORMATS, type Scene, type Timeline, timelineProblems } from "./timeline";

/**
 * Turns a timeline into a HyperFrames project (D-052): one `index.html` whose timed elements and
 * paused GSAP timeline the renderer seeks frame by frame, with every asset copied beside it. GSAP
 * is vendored from npm, so a render never needs the network except to fetch the two Google Fonts.
 */

const require = createRequire(import.meta.url);

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const n = (x: number): string => (Math.round(x * 1000) / 1000).toString();

/** How long each scene fades in over the one before it. */
const FADE = 0.35;

interface Built {
  html: string;
  assets: { from: string; to: string }[];
}

/** Builds the HTML and the list of files to copy (pure; `writeProject` does the copying). */
export function composeTimeline(t: Timeline): Built {
  const problems = timelineProblems(t);
  if (problems.length > 0) throw new Error(`The timeline doesn't add up: ${problems.join("; ")}`);
  const { width: W, height: H } = FORMATS[t.format];
  const short = t.format === "short";
  const base = Math.min(W, H);
  const th = t.theme;
  const assets: { from: string; to: string }[] = [];
  const asset = (src: string): string => {
    const existing = assets.find((a) => a.from === src);
    if (existing) return existing.to;
    const to = `assets/${String(assets.length).padStart(3, "0")}-${path.basename(src).replace(/[^\w.-]/g, "_")}`;
    assets.push({ from: src, to });
    return to;
  };

  const body: string[] = [];
  const js: string[] = [];
  const scenes = [...t.scenes].sort((a, b) => a.start - b.start);

  scenes.forEach((scene, i) => {
    const id = `s${i}`;
    const next = scenes[i + 1];
    // Extend under the next scene's fade so there's never a gap.
    const tail = next && next.transition === "fade" ? FADE : 0;
    const start = scene.start;
    const dur = scene.duration + tail;
    const inner = sceneHtml(scene, id, asset, { short, base, start, dur });
    body.push(
      `<div id="${id}" class="clip scene" style="z-index:${i + 1}" data-start="${n(start)}" data-duration="${n(dur)}">${inner}</div>`,
    );
    if (i > 0 && scene.transition === "fade") {
      js.push(
        `tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${FADE}, ease: "power1.out" }, ${n(start)});`,
      );
    }
    js.push(...sceneJs(scene, id, { start, dur, short }));
    if (scene.lowerThird) {
      const lt = `${id}-lt`;
      body.push(
        `<div id="${lt}" class="clip lt" style="z-index:${200 + i}" data-start="${n(start)}" data-duration="${n(scene.duration)}"><div class="lt-box"><div class="lt-t">${esc(scene.lowerThird.text)}</div>${scene.lowerThird.sub ? `<div class="lt-s">${esc(scene.lowerThird.sub)}</div>` : ""}</div></div>`,
      );
      js.push(
        `tl.fromTo("#${lt} .lt-box", { x: -60, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: "power3.out" }, ${n(start + 0.25)});`,
      );
      if (scene.duration > 1.6) {
        js.push(
          `tl.to("#${lt} .lt-box", { opacity: 0, duration: 0.3 }, ${n(start + scene.duration - 0.45)});`,
        );
      }
    }
  });

  if (t.captions && t.captions.chunks.length > 0) {
    t.captions.chunks.forEach((chunk, ci) => {
      const id = `c${ci}`;
      // Spacing comes from the words' margins, so a highlighted word can't swallow it.
      const words = chunk.words
        .map((w, wi) => `<span id="${id}w${wi}" class="w">${esc(w.text)}</span>`)
        .join("");
      const dur = Math.max(0.05, chunk.end - chunk.start);
      body.push(
        `<div id="${id}" class="clip cap" data-start="${n(chunk.start)}" data-duration="${n(dur)}"><div class="cap-line">${words}</div></div>`,
      );
      js.push(
        `tl.fromTo("#${id} .cap-line", { scale: 0.9, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.12, ease: "back.out(2)" }, ${n(chunk.start)});`,
      );
      if (t.captions?.style === "karaoke") {
        chunk.words.forEach((w, wi) => {
          js.push(`tl.set("#${id}w${wi}", { color: "${th.accent}", scale: 1.06 }, ${n(w.start)});`);
          js.push(
            `tl.set("#${id}w${wi}", { color: "${th.ink}", scale: 1 }, ${n(Math.max(w.start + 0.05, w.end))});`,
          );
        });
      }
    });
  }

  if (t.progressBar) {
    body.push(
      `<div id="progress" class="clip prog" data-start="0" data-duration="${n(t.duration)}"><div class="prog-bar"></div></div>`,
    );
    js.push(
      `tl.fromTo("#progress .prog-bar", { scaleX: 0 }, { scaleX: 1, duration: ${n(t.duration)}, ease: "none" }, 0);`,
    );
  }
  if (t.watermark) {
    body.push(
      `<div id="wm" class="clip wm" data-start="0" data-duration="${n(t.duration)}">${esc(t.watermark)}</div>`,
    );
  }

  const audio: string[] = [];
  if (t.voice) {
    audio.push(
      `<audio id="vo" src="${asset(t.voice.src)}" data-start="0" data-duration="${n(t.duration)}" data-volume="${n(t.voice.volume)}"></audio>`,
    );
  }
  if (t.music) {
    audio.push(
      `<audio id="music" src="${asset(t.music.src)}" data-start="0" data-duration="${n(t.duration)}" data-volume="${n(t.music.volume)}" data-fade-in="${n(t.music.fadeIn)}" data-fade-out="${n(t.music.fadeOut)}"></audio>`,
    );
  }
  t.sfx.forEach((fx, i) => {
    audio.push(
      `<audio id="fx${i}" src="${asset(fx.src)}" data-start="${n(fx.start)}" data-duration="${n(fx.duration)}" data-volume="${n(fx.volume)}"></audio>`,
    );
  });

  const capSize = short ? Math.round(base * 0.072) : Math.round(base * 0.044);
  const css = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${th.bg}; }
#root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; font-family: "${th.body}", sans-serif; color: ${th.ink}; }
.clip { position: absolute; inset: 0; }
.scene { overflow: hidden; background: radial-gradient(ellipse at 30% 20%, ${th.bg2} 0%, ${th.bg} 70%); }
.media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; will-change: transform; }
.shade { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.6) 100%); }
.center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 ${Math.round(W * 0.08)}px; }
.kicker { font-family: "${th.display}", sans-serif; font-weight: 800; letter-spacing: 0.18em; text-transform: uppercase; color: ${th.accent}; font-size: ${Math.round(base * 0.032)}px; margin-bottom: ${Math.round(base * 0.025)}px; }
.title { font-family: "${th.display}", sans-serif; font-weight: 900; line-height: 1.05; letter-spacing: -0.02em; font-size: ${Math.round(base * (short ? 0.1 : 0.085))}px; }
.title .tw { display: inline-block; }
.sub { margin-top: ${Math.round(base * 0.03)}px; font-size: ${Math.round(base * 0.038)}px; opacity: 0.85; }
.badge { font-family: "${th.display}", sans-serif; font-weight: 900; background: ${th.accent}; color: ${th.bg}; border-radius: ${Math.round(base * 0.02)}px; padding: ${Math.round(base * 0.01)}px ${Math.round(base * 0.03)}px; font-size: ${Math.round(base * 0.075)}px; margin-bottom: ${Math.round(base * 0.035)}px; }
.heading { font-size: ${Math.round(base * 0.032)}px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.7; margin-bottom: ${Math.round(base * 0.02)}px; }
.item { font-family: "${th.display}", sans-serif; font-weight: 800; font-size: ${Math.round(base * 0.075)}px; line-height: 1.1; }
.detail { margin-top: ${Math.round(base * 0.03)}px; font-size: ${Math.round(base * 0.036)}px; opacity: 0.85; max-width: 90%; }
.qmark { font-family: "${th.display}", sans-serif; font-weight: 900; color: ${th.accent}; font-size: ${Math.round(base * 0.2)}px; line-height: 0.8; }
.qtext { font-family: "${th.display}", sans-serif; font-weight: 700; font-size: ${Math.round(base * 0.055)}px; line-height: 1.25; }
.qby { margin-top: ${Math.round(base * 0.03)}px; font-size: ${Math.round(base * 0.032)}px; color: ${th.accent}; }
.stat { font-family: "${th.display}", sans-serif; font-weight: 900; font-size: ${Math.round(base * 0.2)}px; color: ${th.accent}; line-height: 1; }
.slabel { margin-top: ${Math.round(base * 0.025)}px; font-size: ${Math.round(base * 0.045)}px; font-weight: 600; }
.label { position: absolute; left: ${Math.round(W * 0.06)}px; right: ${Math.round(W * 0.06)}px; top: ${Math.round(H * (short ? 0.12 : 0.08))}px; font-family: "${th.display}", sans-serif; font-weight: 800; font-size: ${Math.round(base * 0.045)}px; text-shadow: 0 4px 18px rgba(0,0,0,0.6); }
.credit { position: absolute; right: ${Math.round(W * 0.03)}px; bottom: ${Math.round(H * 0.015)}px; font-size: ${Math.round(base * 0.016)}px; opacity: 0.6; text-shadow: 0 1px 4px rgba(0,0,0,0.8); }
.lt { pointer-events: none; }
.lt-box { position: absolute; left: ${Math.round(W * 0.05)}px; ${short ? `top: ${Math.round(H * 0.2)}px;` : `bottom: ${Math.round(H * 0.16)}px;`} background: rgba(0,0,0,0.55); border-left: ${Math.round(base * 0.008)}px solid ${th.accent}; padding: ${Math.round(base * 0.015)}px ${Math.round(base * 0.025)}px; }
.lt-t { font-family: "${th.display}", sans-serif; font-weight: 800; font-size: ${Math.round(base * 0.038)}px; }
.lt-s { font-size: ${Math.round(base * 0.026)}px; opacity: 0.85; }
.cap { display: flex; justify-content: center; align-items: ${short ? "flex-start" : "flex-end"}; ${short ? `padding-top: ${Math.round(H * 0.62)}px;` : `padding-bottom: ${Math.round(H * 0.06)}px;`} z-index: 500; }
.cap-line { max-width: ${Math.round(W * 0.86)}px; text-align: center; font-family: "${th.display}", sans-serif; font-weight: 900; font-size: ${capSize}px; line-height: 1.15; ${short ? "text-transform: uppercase;" : ""} text-shadow: 0 0 ${Math.round(capSize * 0.12)}px rgba(0,0,0,0.9), 0 ${Math.round(capSize * 0.06)}px ${Math.round(capSize * 0.2)}px rgba(0,0,0,0.8); -webkit-text-stroke: ${Math.max(2, Math.round(capSize * 0.06))}px rgba(0,0,0,0.85); paint-order: stroke fill; }
.cap .w { display: inline-block; margin: 0 0.13em; }
.prog { z-index: 600; height: ${Math.max(6, Math.round(base * 0.008))}px; inset: 0 0 auto 0; background: rgba(255,255,255,0.15); }
.prog-bar { width: 100%; height: 100%; background: ${th.accent}; transform-origin: left center; }
.wm { z-index: 600; inset: auto auto ${Math.round(H * 0.025)}px ${Math.round(W * 0.03)}px; font-size: ${Math.round(base * 0.02)}px; font-weight: 700; opacity: 0.55; letter-spacing: 0.06em; }
`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<script src="gsap.min.js"></script>
<style>${css}</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${n(t.duration)}" data-width="${W}" data-height="${H}" data-fps="${t.fps}">
${body.join("\n")}
${audio.join("\n")}
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
${js.join("\n")}
window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
  return { html, assets };
}

interface SceneCtx {
  short: boolean;
  base: number;
  start: number;
  dur: number;
}

function sceneHtml(
  scene: Scene,
  id: string,
  asset: (src: string) => string,
  ctx: SceneCtx,
): string {
  const v = scene.visual;
  switch (v.type) {
    case "title": {
      const words = v.title
        .split(/\s+/)
        .map((w) => `<span class="tw">${esc(w)}</span>`)
        .join(" ");
      return `<div class="center">${v.kicker ? `<div class="kicker">${esc(v.kicker)}</div>` : ""}<div class="title">${words}</div>${v.subtitle ? `<div class="sub">${esc(v.subtitle)}</div>` : ""}</div>`;
    }
    case "list":
      return `<div class="center">${v.heading ? `<div class="heading">${esc(v.heading)}</div>` : ""}${v.index !== undefined ? `<div class="badge">#${v.index}</div>` : ""}<div class="item">${esc(v.item)}</div>${v.detail ? `<div class="detail">${esc(v.detail)}</div>` : ""}</div>`;
    case "quote":
      return `<div class="center"><div class="qmark">“</div><div class="qtext">${esc(v.text)}</div>${v.by ? `<div class="qby">— ${esc(v.by)}</div>` : ""}</div>`;
    case "stat":
      return `<div class="center"><div class="stat">${esc(v.prefix ?? "")}<span id="${id}-n">0</span>${esc(v.suffix ?? "")}</div><div class="slabel">${esc(v.label)}</div></div>`;
    case "still":
      return `<img class="media" src="${asset(v.src)}" alt="" /><div class="shade"></div>${v.label ? `<div class="label">${esc(v.label)}</div>` : ""}${v.credit ? `<div class="credit">${esc(v.credit)}</div>` : ""}`;
    case "video":
      return `<video class="media" src="${asset(v.src)}" muted playsinline data-start="${n(ctx.start)}" data-duration="${n(ctx.dur)}" data-media-start="${n(v.mediaStart)}"></video><div class="shade"></div>${v.label ? `<div class="label">${esc(v.label)}</div>` : ""}${v.credit ? `<div class="credit">${esc(v.credit)}</div>` : ""}`;
    case "color":
      return `<div class="center">${v.text ? `<div class="title">${esc(v.text)}</div>` : ""}</div>`;
  }
}

const MOVES: Record<string, { from: string; to: string }> = {
  "push-in": { from: "{ scale: 1.0 }", to: "{ scale: 1.14 }" },
  "pull-out": { from: "{ scale: 1.14 }", to: "{ scale: 1.0 }" },
  "pan-left": { from: "{ scale: 1.16, xPercent: 4 }", to: "{ scale: 1.16, xPercent: -4 }" },
  "pan-right": { from: "{ scale: 1.16, xPercent: -4 }", to: "{ scale: 1.16, xPercent: 4 }" },
  "tilt-up": { from: "{ scale: 1.16, yPercent: 4 }", to: "{ scale: 1.16, yPercent: -4 }" },
  "tilt-down": { from: "{ scale: 1.16, yPercent: -4 }", to: "{ scale: 1.16, yPercent: 4 }" },
  drift: {
    from: "{ scale: 1.08, xPercent: -2, rotation: -1 }",
    to: "{ scale: 1.16, xPercent: 2, rotation: 1 }",
  },
};

function sceneJs(
  scene: Scene,
  id: string,
  ctx: { start: number; dur: number; short: boolean },
): string[] {
  const v = scene.visual;
  const at = ctx.start;
  const sel = (s: string) => `"#${id} ${s}"`;
  const when = (cond: unknown, line: string): string[] => (cond ? [line] : []);
  switch (v.type) {
    case "title":
      return [
        ...when(
          v.kicker,
          `tl.from(${sel(".kicker")}, { y: 30, opacity: 0, duration: 0.4, ease: "power2.out" }, ${n(at + 0.05)});`,
        ),
        `tl.from(${sel(".tw")}, { y: 60, opacity: 0, duration: 0.5, ease: "power3.out", stagger: 0.08 }, ${n(at + 0.1)});`,
        ...when(
          v.subtitle,
          `tl.from(${sel(".sub")}, { opacity: 0, duration: 0.5 }, ${n(at + 0.6)});`,
        ),
        `tl.fromTo(${sel(".title")}, { scale: 1 }, { scale: 1.05, duration: ${n(ctx.dur)}, ease: "none" }, ${n(at)});`,
      ];
    case "list":
      return [
        ...when(
          v.index !== undefined,
          `tl.from(${sel(".badge")}, { scale: 0, duration: 0.45, ease: "back.out(2.5)" }, ${n(at + 0.05)});`,
        ),
        ...when(v.heading, `tl.from(${sel(".heading")}, { opacity: 0, duration: 0.3 }, ${n(at)});`),
        `tl.from(${sel(".item")}, { y: 50, opacity: 0, duration: 0.45, ease: "power3.out" }, ${n(at + 0.2)});`,
        ...when(
          v.detail,
          `tl.from(${sel(".detail")}, { opacity: 0, y: 20, duration: 0.4 }, ${n(at + 0.55)});`,
        ),
      ];
    case "quote":
      return [
        `tl.from(${sel(".qmark")}, { scale: 0.4, opacity: 0, duration: 0.4, ease: "back.out(2)" }, ${n(at)});`,
        `tl.from(${sel(".qtext")}, { y: 40, opacity: 0, duration: 0.6, ease: "power2.out" }, ${n(at + 0.15)});`,
        ...when(v.by, `tl.from(${sel(".qby")}, { opacity: 0, duration: 0.4 }, ${n(at + 0.8)});`),
      ];
    case "stat":
      return [
        `tl.from(${sel(".stat")}, { scale: 0.6, opacity: 0, duration: 0.45, ease: "back.out(1.8)" }, ${n(at)});`,
        `tl.fromTo("#${id}-n", { textContent: 0 }, { textContent: ${v.value}, duration: ${n(Math.min(1.6, ctx.dur * 0.6))}, ease: "power2.out", snap: { textContent: ${v.decimals === 0 ? 1 : 1 / 10 ** v.decimals} } }, ${n(at + 0.1)});`,
        `tl.from(${sel(".slabel")}, { opacity: 0, y: 20, duration: 0.4 }, ${n(at + 0.5)});`,
      ];
    case "still": {
      const m = MOVES[v.move] ?? MOVES["push-in"];
      return [
        `tl.fromTo(${sel(".media")}, ${m?.from}, { ...${m?.to}, duration: ${n(ctx.dur)}, ease: "sine.inOut" }, ${n(at)});`,
        ...when(
          v.label,
          `tl.from(${sel(".label")}, { opacity: 0, y: -20, duration: 0.4 }, ${n(at + 0.3)});`,
        ),
      ];
    }
    case "video":
      return [
        `tl.fromTo(${sel(".media")}, { scale: 1.0 }, { scale: 1.06, duration: ${n(ctx.dur)}, ease: "none" }, ${n(at)});`,
        ...when(
          v.label,
          `tl.from(${sel(".label")}, { opacity: 0, y: -20, duration: 0.4 }, ${n(at + 0.3)});`,
        ),
      ];
    case "color":
      return when(
        v.text,
        `tl.from(${sel(".title")}, { opacity: 0, scale: 0.9, duration: 0.5 }, ${n(at)});`,
      );
  }
}

/** Writes the project folder: index.html, GSAP and the assets (hard links when possible). */
export function writeProject(t: Timeline, dir: string): Built {
  const built = composeTimeline(t);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.copyFileSync(require.resolve("gsap/dist/gsap.min.js"), path.join(dir, "gsap.min.js"));
  for (const a of built.assets) {
    if (!fs.existsSync(a.from)) throw new Error(`Missing asset: ${a.from}`);
    const to = path.join(dir, a.to);
    try {
      fs.linkSync(a.from, to);
    } catch {
      fs.copyFileSync(a.from, to);
    }
  }
  fs.writeFileSync(path.join(dir, "index.html"), built.html);
  fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(t, null, 2));
  return built;
}
