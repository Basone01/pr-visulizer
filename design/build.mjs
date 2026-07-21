// Generates the Claude Design handoff bundle: token files + self-contained
// preview cards. Single source of truth for tokens so cards can't drift.
// Run: node design/build.mjs   (emits *.html + tokens.css/ts next to itself)
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const OUT = dirname(fileURLToPath(import.meta.url))

// ── tokens: single source of truth ─────────────────────────
// Light theme is referenced from GitHub's pull-request styling: surfaces + diff colors from
// Primer color primitives (@primer/primitives light, canvas/fg/border/diff), syntax from
// GitHub's prettylights.syntax roles (the exact palette github.com renders diffs in).
// Dark theme is referenced from the official Dracula spec (draculatheme.com / dracula.yml):
// surfaces from Dracula's published UI variants, syntax mapped per the Dracula spec's role
// table (keyword=pink, string=yellow, function=green, type=cyan, constant=purple, comment).
// Every foreground/background pair was contrast-checked (WCAG 2.2 AA + APCA) — see the theme
// task report. A few dark surface tints are derived (OKLCH) from the Dracula hues to seat the
// bright syntax colors on diff rows; the syntax colors themselves are verbatim Dracula.
const TOKENS = {
  light: {
    bg: "#f6f8fa", // canvas.subtle
    panel: "#ffffff", // canvas.default
    text: "#1f2328", // fg.default
    muted: "#656d76", // fg.muted
    border: "#d0d7de", // border.default
    codeBg: "#eaeef2", // scale.gray[1]
    accent: "#0969da", // accent.emphasis
    accentSoft: "#ddf4ff", // accent.subtle
    added: "#1a7f37", // success.fg
    addedSoft: "#e6ffec", // diffBlob addition line
    modified: "#9a6700", // attention.fg
    modifiedSoft: "#fff8c5", // attention.subtle
    deleted: "#cf222e", // danger.emphasis
    deletedSoft: "#ffebe9", // diffBlob deletion line
    reviewed: "#8c959f", // scale.gray[5]
    synKeyword: "#cf222e", // prettylights keyword
    synString: "#0a3069", // prettylights string
    synFunc: "#8250df", // prettylights entity (functions)
    synType: "#953800", // prettylights variable (types)
    synConst: "#0550ae", // prettylights constant
    synComment: "#6e7781", // prettylights comment
  },
  dark: {
    bg: "#21222c", // Dracula BG (darker) — app frame
    panel: "#282a36", // Dracula Background — editor/cards
    text: "#f8f8f2", // Dracula Foreground
    muted: "#96a0c6", // Dracula Comment, lightened to clear AA on every surface
    border: "#44475a", // Dracula Selection
    codeBg: "#343746", // Dracula BG (lighter) — gutter/hunk/inline code
    accent: "#bd93f9", // Dracula Purple — the signature interactive hue
    accentSoft: "#322c4a", // derived: dark purple tint of the panel
    added: "#50fa7b", // Dracula Green
    addedSoft: "#1b3326", // derived: dark green diff-add ground
    modified: "#ffb86c", // Dracula Orange
    modifiedSoft: "#3a2c1a", // derived: dark orange ground
    deleted: "#ff5555", // Dracula Red
    deletedSoft: "#3b1d22", // derived: dark red diff-del ground
    reviewed: "#565f7d", // derived: dimmed slate for checked-off files
    synKeyword: "#ff79c6", // Dracula Pink
    synString: "#f1fa8c", // Dracula Yellow
    synFunc: "#50fa7b", // Dracula Green
    synType: "#8be9fd", // Dracula Cyan
    synConst: "#bd93f9", // Dracula Purple
    synComment: "#6272a4", // Dracula Comment (verbatim — deliberately recessive)
  },
}

const USAGE = {
  bg: "app background",
  panel: "cards, panes, nodes",
  text: "primary text",
  muted: "secondary text, ghost nodes, edges",
  border: "hairlines, node strokes",
  codeBg: "inline code, diff gutter",
  accent: "suggested-next, links, primary buttons",
  accentSoft: "suggested-row background",
  added: "added files/symbols/diff lines",
  addedSoft: "added backgrounds",
  modified: "modified files/symbols",
  modifiedSoft: "modified backgrounds",
  deleted: "deleted diff lines, request-changes",
  deletedSoft: "deleted backgrounds",
  reviewed: "checked-off files (dimmed)",
  synKeyword: "import / export / function / if",
  synString: "string literals",
  synFunc: "function names, call sites",
  synType: "type names",
  synConst: "constants, numbers",
  synComment: "comments",
}

// hand-tagged syntax spans for mockup code (no parser — these are static previews)
const kw = (s) => `<span style="color:var(--syn-keyword)">${s}</span>`
const st = (s) => `<span style="color:var(--syn-string)">${s}</span>`
const fn = (s) => `<span style="color:var(--syn-func)">${s}</span>`
const ty = (s) => `<span style="color:var(--syn-type)">${s}</span>`
const ct = (s) => `<span style="color:var(--syn-const)">${s}</span>`
// symbol with a counterpart in the PR — underlined, clickable in the real app
const sym = (s) => `<span class="symlink">${s}</span>`

const kebab = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())
const varsBlock = (mode) =>
  Object.entries(TOKENS[mode])
    .map(([k, v]) => `  --${kebab(k)}: ${v};`)
    .join("\n")

// ── shared card scaffold ────────────────────────────────────
const BASE_CSS = `
:root {\n${varsBlock("light")}\n}
@media (prefers-color-scheme: dark) { :root {\n${varsBlock("dark")}\n} }
:root[data-theme="light"] {\n${varsBlock("light")}\n}
:root[data-theme="dark"] {\n${varsBlock("dark")}\n}
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; background: var(--bg); color: var(--text);
  font: 14px/1.5 -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
h4 { margin: 0 0 10px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.symlink { text-decoration: underline dotted; text-underline-offset: 3px; cursor: pointer; }
`

function card({ path, group, name, subtitle, width, height, css, body }) {
  const html = `<!-- @dsCard group="${group}" name="${name}" subtitle="${subtitle}" viewport="${width}x${height}" -->
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<style>${BASE_CSS}${css || ""}</style></head>
<body>
${body}
</body></html>`
  const file = join(OUT, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html)
  return { path, group, name, subtitle, width, height }
}

const cards = []

// ── tokens/colors ───────────────────────────────────────────
const swatchRow = (keys) =>
  keys
    .map(
      (k) => `
  <div class="sw">
    <div class="chip" style="background:${TOKENS.light[k]}"></div>
    <div class="chip dark" style="background:${TOKENS.dark[k]}"></div>
    <div class="lbl mono">--${kebab(k)}</div>
    <div class="hex mono">${TOKENS.light[k]} · ${TOKENS.dark[k]}</div>
    <div class="use">${USAGE[k]}</div>
  </div>`
    )
    .join("")

cards.push(
  card({
    path: "tokens/colors.html",
    group: "Colors",
    name: "Semantic colors",
    subtitle: "diff status · review state · syntax · surfaces — light+dark",
    width: 860,
    height: 880,
    css: `
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.sw { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.chip { height: 26px; border-radius: 6px; }
.chip.dark { margin-top: 4px; }
.lbl { margin-top: 8px; font-size: 12px; font-weight: 600; }
.hex { font-size: 11px; color: var(--muted); }
.use { font-size: 12px; color: var(--muted); margin-top: 2px; }
section { margin-bottom: 20px; }`,
    body: `
<section><h4>Diff status</h4><div class="grid">${swatchRow(["added", "addedSoft", "modified", "modifiedSoft", "deleted", "deletedSoft"])}</div></section>
<section><h4>Review state</h4><div class="grid">${swatchRow(["accent", "accentSoft", "reviewed"])}</div></section>
<section><h4>Syntax (diff code)</h4><div class="grid">${swatchRow(["synKeyword", "synString", "synFunc", "synType", "synConst", "synComment"])}</div></section>
<section><h4>Surfaces</h4><div class="grid">${swatchRow(["bg", "panel", "border", "text", "muted", "codeBg"])}</div></section>
<p style="color:var(--muted);font-size:12px">Top chip = light, bottom = dark. Ghost nodes reuse <span class="mono">--muted</span> with a dashed stroke — no extra hue. In diffs: <b>background = diff status, foreground = syntax</b> — the two layers never fight.</p>`,
  })
)

// ── tokens/type ─────────────────────────────────────────────
cards.push(
  card({
    path: "tokens/type.html",
    group: "Type",
    name: "Typography",
    subtitle: "UI sans · code mono · tabular numerals",
    width: 700,
    height: 420,
    css: `
.spec { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.spec .demo { margin: 6px 0; }
.tab { font-variant-numeric: tabular-nums; }
.small { font-size: 12px; color: var(--muted); }`,
    body: `
<div class="spec"><h4>UI — system sans</h4>
  <div class="demo" style="font-size:17px;font-weight:700">Review PR #42 — Add login rate limiting</div>
  <div class="demo">Start with the file the rest of the PR is built on.</div>
  <div class="small mono">-apple-system, "SF Pro Text", "Segoe UI", Roboto · 14px base / 1.5</div></div>
<div class="spec"><h4>Code — mono (paths, symbols, diff)</h4>
  <div class="demo mono">src/middleware/withRateLimit.ts</div>
  <div class="demo mono" style="font-size:12px;color:var(--muted)">createRateLimiter · RateLimitConfig · +26 −0</div>
  <div class="small mono">ui-monospace, "SF Mono", Menlo · 12–13px</div></div>
<div class="spec"><h4>Numbers — tabular</h4>
  <div class="demo mono tab">readiness&nbsp;&nbsp;1.00&nbsp;·&nbsp;0.67&nbsp;·&nbsp;0.33&nbsp;·&nbsp;0.00</div>
  <div class="small">font-variant-numeric: tabular-nums — scores align in columns while counting up.</div></div>`,
  })
)

// ── components/graph-node ───────────────────────────────────
const node = (cls, name, chips, meta, order, extra = "") => `
<div class="node ${cls}">
  <div class="top"><span class="mono nm">${name}</span>${order ? `<span class="order">#${order}</span>` : ""}</div>
  <div class="chips mono">${chips}</div>
  <div class="meta mono">${meta}</div>${extra}
</div>`

cards.push(
  card({
    path: "components/graph-node.html",
    group: "Components",
    name: "Graph nodes",
    subtitle: "added / modified / suggested / reviewed / ghost",
    width: 860,
    height: 400,
    css: `
.rowc { display: flex; gap: 14px; flex-wrap: wrap; }
.node { width: 200px; background: var(--panel); border: 1.5px solid var(--border); border-radius: 9px; padding: 10px 12px; position: relative; }
.node.added { border-color: var(--added); }
.node.modified { border-color: var(--modified); }
.node.suggest { border-color: var(--accent); border-width: 3px; box-shadow: 0 0 0 4px var(--accent-soft); }
.node.done { opacity: .55; }
.node.ghost { border-style: dashed; border-color: var(--muted); background: transparent; }
.top { display: flex; justify-content: space-between; align-items: baseline; }
.nm { font-weight: 600; font-size: 12px; }
.order { color: var(--accent); font-size: 11px; font-weight: 700; }
.chips { color: var(--muted); font-size: 10px; margin-top: 3px; }
.meta { color: var(--muted); font-size: 10px; margin-top: 3px; }
.tick { position: absolute; right: 10px; bottom: 8px; color: var(--added); font-weight: 700; }
.blast { display: inline-block; margin-top: 5px; font-size: 10px; background: var(--modified-soft); color: var(--modified); border-radius: 4px; padding: 0 6px; font-weight: 600; }
.cap { color: var(--muted); font-size: 12px; margin-top: 14px; }`,
    body: `
<div class="rowc">
${node("added", "rateLimiter.ts", "createRateLimiter", "+48 −0", 3)}
${node("modified", "http.ts", "ApiError", "+2 −1", 2)}
${node("suggest", "limits.ts", "RateLimitConfig · LOGIN_RATE_LIMIT", "+4 −0", 1)}
${node("added done", "withRateLimit.ts", "withRateLimit", "+26 −0", 4, '<span class="tick">✓</span>')}
${node("ghost", "admin.ts 👻", "calls withRateLimit", "unchanged · deep only", 0)}
${node("added", "withRateLimit.ts", "withRateLimit", "+26 −0", 4, '<div class="blast">blast radius 1 ⚠️</div>')}
</div>
<p class="cap">Border color = diff status. Blue ring = suggested next. Dimmed + ✓ = reviewed. Dashed = ghost (deep engine only, never in the queue). Blast-radius badge appears only with deep data.</p>`,
  })
)

// ── components/edge-legend ──────────────────────────────────
cards.push(
  card({
    path: "components/edge-legend.html",
    group: "Components",
    name: "Edges",
    subtitle: "kinds · engine source · direction convention",
    width: 640,
    height: 380,
    css: `
.lg { display: grid; grid-template-columns: 120px 1fr; gap: 10px 14px; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
svg { display: block; }
.d { font-size: 13px; }
.dir { margin-top: 14px; padding: 10px 14px; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 8px 8px 0; font-size: 13px; }`,
    body: `
<div class="lg">
  <svg width="110" height="14"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)"/></marker></defs><line x1="2" y1="7" x2="102" y2="7" stroke="var(--muted)" stroke-width="1.6" marker-end="url(#a)"/></svg>
  <div class="d"><b>imports / calls / uses-type</b> — solid, source <span class="mono">ast</span> (fast engine)</div>
  <svg width="110" height="14"><line x1="2" y1="7" x2="102" y2="7" stroke="var(--accent)" stroke-width="2.2" marker-end="url(#a)"/></svg>
  <div class="d"><b>confirmed by deep engine</b> — accent, source <span class="mono">lsp</span> (compiler-grade)</div>
  <svg width="110" height="14"><line x1="2" y1="7" x2="102" y2="7" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#a)"/></svg>
  <div class="d"><b>ghost reference</b> — dashed, from an unchanged file (deep only)</div>
  <svg width="110" height="14"><line x1="2" y1="7" x2="102" y2="7" stroke="var(--muted)" stroke-width="3.2" marker-end="url(#a)"/></svg>
  <div class="d"><b>edge weight</b> — thickness = number of symbol-level references</div>
</div>
<div class="dir"><b>Direction convention:</b> A → B means <b>"A depends on B"</b>. Arrows point at foundations; review flows against the arrows, left to right.</div>`,
  })
)

// ── components/readiness ────────────────────────────────────
const chip = (v, cls, label) => `
<div class="rc ${cls}"><span class="bar"><span style="width:${v * 100}%"></span></span><span class="mono val">${label ?? v.toFixed(2)}</span></div>`
cards.push(
  card({
    path: "components/readiness.html",
    group: "Components",
    name: "Readiness chips",
    subtitle: 'reviewed-deps ÷ total-deps — drives "best next"',
    width: 640,
    height: 360,
    css: `
.list { display: flex; flex-direction: column; gap: 10px; max-width: 420px; }
.rc { display: flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; }
.rc.next { border-color: var(--accent); background: var(--accent-soft); }
.bar { flex: 1; height: 6px; border-radius: 3px; background: var(--code-bg); overflow: hidden; display: block; }
.bar span { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.val { font-variant-numeric: tabular-nums; font-size: 12px; width: 68px; text-align: right; }
.rc.done .bar span { background: var(--reviewed); }
.cap { color: var(--muted); font-size: 12px; margin-top: 12px; max-width: 460px; }`,
    body: `
<div class="list">
  ${chip(1, "next", "1.00 👉 next")}
  ${chip(1, "", "1.00")}
  ${chip(0.67, "", "0.67")}
  ${chip(0.33, "", "0.33")}
  ${chip(0, "", "0.00")}
  ${chip(1, "done", "✓ reviewed")}
</div>
<p class="cap">1.00 = every changed file this one depends on is already reviewed — full context right now. Ties break by lower topo level, then higher fan-in. The suggestion guides, never blocks.</p>`,
  })
)

// ── components/review-tray ──────────────────────────────────
const tray = (nm, state, ready, extra = "") => {
  const cls = state === "done" ? "done" : state === "next" ? "next" : ""
  const right =
    state === "done"
      ? '<span class="ok">✓</span>'
      : state === "next"
        ? '<span class="nx">👉 next</span>'
        : `<span class="mono rd">${ready}</span>`
  return `<div class="tr ${cls}"><span class="mono p">${nm}</span>${extra}${right}</div>`
}
cards.push(
  card({
    path: "components/review-tray.html",
    group: "Components",
    name: "Review tray",
    subtitle: "queue rows · progress · submit",
    width: 640,
    height: 480,
    css: `
.tray { max-width: 400px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.hd { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; font-size: 13px; }
.hd b { font-variant-numeric: tabular-nums; }
.tr { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 12px; }
.tr .p { flex: 1; }
.tr.done { color: var(--reviewed); }
.tr.done .p { text-decoration: line-through; text-decoration-color: var(--border); }
.tr.next { background: var(--accent-soft); font-weight: 600; }
.ok { color: var(--added); font-weight: 700; }
.nx { color: var(--accent); font-size: 11px; font-weight: 700; }
.rd { color: var(--muted); font-variant-numeric: tabular-nums; }
.blast { font-size: 10px; background: var(--modified-soft); color: var(--modified); border-radius: 4px; padding: 0 5px; font-weight: 600; }
.ft { padding: 12px 14px; display: flex; gap: 8px; }
.btn { flex: 1; text-align: center; padding: 8px 0; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn[disabled] { opacity: .4; }`,
    body: `
<div class="tray">
  <div class="hd"><span>Review queue</span><b>3 / 6 reviewed</b></div>
  ${tray("src/config/limits.ts", "done", "")}
  ${tray("src/types/http.ts", "done", "")}
  ${tray("src/lib/rateLimiter.ts", "done", "")}
  ${tray("src/middleware/withRateLimit.ts", "next", "", '<span class="blast">⚠️ 1</span>')}
  ${tray("src/lib/rateLimiter.test.ts", "", "1.00")}
  ${tray("src/api/routes/login.ts", "", "0.00")}
  <div class="ft"><button class="btn" disabled>Submit review</button><button class="btn primary">Open next</button></div>
</div>
<p style="color:var(--muted);font-size:12px;max-width:420px">Rows ordered by the live ranking, not alphabetically. Submit enables at 6/6 (or on explicit override). ⚠️ = blast radius from deep mode.</p>`,
  })
)

// ── components/preset-selector ──────────────────────────────
cards.push(
  card({
    path: "components/preset-selector.html",
    group: "Components",
    name: "Ranking presets + engine toggle",
    subtitle: "foundations-first · blast-radius-first · quick-wins · fast/deep",
    width: 700,
    height: 380,
    css: `
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--panel); }
.seg button { border: 0; background: transparent; color: var(--text); padding: 8px 16px; font-size: 13px; cursor: pointer; border-right: 1px solid var(--border); }
.seg button:last-child { border-right: 0; }
.seg button.on { background: var(--accent); color: #fff; font-weight: 600; }
.cap { color: var(--muted); font-size: 12px; margin: 8px 0 18px; }
.eng { display: inline-flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; font-size: 13px; }
.badge { font-size: 11px; font-weight: 700; border-radius: 5px; padding: 1px 8px; }
.badge.fast { background: var(--added-soft); color: var(--added); }
.badge.deep { background: var(--accent-soft); color: var(--accent); }`,
    body: `
<h4>Ranking preset (RankingPolicy)</h4>
<div class="seg"><button class="on">foundations-first</button><button>blast-radius-first</button><button>quick-wins</button></div>
<p class="cap">One config object, three named presets — switching reorders the queue without touching the algorithm.</p>
<h4>Analysis engine</h4>
<div class="eng"><span class="badge fast">FAST · AST</span> analyzed in 3.2s · <a href="#" style="color:var(--accent)">Deepen analysis 🔬</a></div>
<p class="cap" style="margin-top:8px">…and after the deep job lands:</p>
<div class="eng"><span class="badge deep">DEEP · REPO</span> repo-wide · 2 ghost files · edges upgraded</div>`,
  })
)

// ── components/diff-header ──────────────────────────────────
cards.push(
  card({
    path: "components/diff-header.html",
    group: "Components",
    name: "Diff panel header",
    subtitle: "path · status · churn · view toggles · symbols · viewed",
    width: 860,
    height: 300,
    css: `
.dh { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; max-width: 780px; }
.r1 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.p { font-weight: 600; font-size: 13px; }
.tag { font-size: 11px; font-weight: 600; border-radius: 4px; padding: 0 6px; }
.tag.added { background: var(--added-soft); color: var(--added); }
.churn { color: var(--muted); font-size: 12px; }
.spacer { flex: 1; }
.viewed { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.r2 { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.sym { font-size: 11px; border: 1px solid var(--border); border-radius: 5px; padding: 1px 8px; color: var(--muted); }
.sym.changed { border-color: var(--added); color: var(--added); }
.toggle { font-size: 11px; border: 1px solid var(--border); border-radius: 14px; padding: 2px 10px; background: var(--panel); color: var(--muted); cursor: pointer; }
.toggle.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.nextHint { margin-top: 10px; font-size: 12px; color: var(--accent); }`,
    body: `
<div class="dh">
  <div class="r1">
    <span class="mono p">src/lib/rateLimiter.ts</span>
    <span class="tag added">added</span>
    <span class="mono churn">+48 −0 · level 1 · fan-in 2</span>
    <span class="spacer"></span>
    <button class="toggle" aria-pressed="false" title="Wrap long lines instead of scrolling horizontally">wrap</button>
    <button class="toggle on" aria-pressed="true" title="Hide whitespace-only changes">hide WS</button>
    <label class="viewed"><input type="checkbox"> Mark viewed <span style="color:var(--muted);font-size:11px">(syncs to GitHub)</span></label>
  </div>
  <div class="r2"><span class="sym changed mono symlink">createRateLimiter ●</span><span class="sym mono">imports: limits.ts</span><span class="sym mono symlink">2 usages in PR →</span></div>
  <div class="nextHint">After this → <span class="mono">withRateLimit.ts</span> (readiness 1.00)</div>
</div>`,
  })
)

// ── components/symbol-nav ───────────────────────────────────
cards.push(
  card({
    path: "components/symbol-nav.html",
    group: "Components",
    name: "Symbol navigation",
    subtitle: "ladder: peek → show-more expand → jump",
    width: 860,
    height: 900,
    css: `
.snip { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-width: 660px; margin-bottom: 16px; }
.sh { padding: 7px 12px; border-bottom: 1px solid var(--border); font-size: 12px; display: flex; gap: 8px; align-items: center; }
.code { font: 12px/1.8 ui-monospace, Menlo, monospace; padding: 6px 0; }
.cl { padding: 0 12px; white-space: pre; }
.cl.add { background: var(--added-soft); }
.cl .ln { display: inline-block; width: 26px; color: var(--muted); }
.peek { margin: 6px 12px 10px 46px; max-width: 560px; background: var(--panel); border: 1px solid var(--accent); border-radius: 9px; overflow: hidden; box-shadow: 0 6px 18px rgba(0,0,0,.14); }
.peek .ph { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 11px; }
.peek .pf { display: flex; gap: 12px; align-items: center; padding: 6px 10px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
.peek .pf b { color: var(--accent); cursor: pointer; }
.peek .code { font-size: 11px; }
.trunc { position: relative; }
.trunc::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 26px; background: linear-gradient(transparent, var(--panel)); }
.duo { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; margin: 6px 12px 10px 46px; }
.duo .peek { margin: 0; flex: 1; min-width: 280px; }
.scrolly { max-height: 130px; overflow-y: auto; }
.tag { font-size: 10px; font-weight: 600; border-radius: 4px; padding: 0 6px; background: var(--added-soft); color: var(--added); }
.pill { display: inline-block; font-size: 11px; font-weight: 600; border-radius: 10px; padding: 1px 9px; background: var(--accent-soft); color: var(--accent); cursor: pointer; }
.pop { position: relative; margin: 4px 12px 8px 46px; display: inline-block; background: var(--panel); border: 1px solid var(--accent); border-radius: 8px; padding: 8px 12px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.12); }
.back { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; border: 1px solid var(--border); border-radius: 14px; padding: 3px 12px; background: var(--panel); cursor: pointer; }
.uses { margin: 6px 0 0; padding-left: 16px; font-size: 12px; }
.uses li { margin: 2px 0; }
.cap { color: var(--muted); font-size: 12px; max-width: 660px; }`,
    body: `
<h4>Click a usage → peek (default) — short definitions never need a jump</h4>
<div class="snip">
  <div class="sh"><span class="mono">withRateLimit.ts</span></div>
  <div class="code">
<div class="cl add"><span class="ln">9</span>+     ${kw("if")} (!limiter.${sym(fn("checkLimit"))}(req.ip)) {</div>
  </div>
  <div class="peek">
    <div class="ph"><span class="mono">rateLimiter.ts:12</span><span class="tag">added in this PR</span><span style="flex:1"></span><span style="color:var(--muted)">esc</span></div>
    <div class="code">
<div class="cl add"><span class="ln">12</span>+   ${fn("checkLimit")}(key: ${ty("string")}): ${ty("boolean")} {</div>
<div class="cl add"><span class="ln">13</span>+     ${kw("const")} now = Date.${fn("now")}();</div>
<div class="cl add"><span class="ln">14</span>+     ${fn("pruneOldHits")}(key, now);</div>
<div class="cl add"><span class="ln">15</span>+     ${kw("return")} hits.${fn("get")}(key)!.length &lt; config.max;</div>
<div class="cl add"><span class="ln">16</span>+   }</div>
    </div>
    <div class="pf">whole definition (5 lines) · <b>Jump ⏎</b> · <span>⌘-click jumps directly</span></div>
  </div>
</div>
<h4>Long definition → peek expands in place; jump only for full-width reading</h4>
<div class="snip">
  <div class="sh"><span class="mono">login.ts</span></div>
  <div class="code">
<div class="cl add"><span class="ln">7</span>+ ${kw("export const")} loginHandler = ${sym(fn("withRateLimit"))}(${kw("async")} (req, res) => {</div>
  </div>
  <div class="duo">
  <div class="peek">
    <div class="ph"><span class="mono">withRateLimit.ts:7</span><span class="tag">added in this PR</span></div>
    <div class="code trunc">
<div class="cl add"><span class="ln">7</span>+ ${kw("export function")} ${fn("withRateLimit")}(handler: ${ty("Handler")}) {</div>
<div class="cl add"><span class="ln">8</span>+   ${kw("return")} ${kw("async")} (req, res) => {</div>
<div class="cl add"><span class="ln">9</span>+     ${kw("if")} (!limiter.${fn("checkLimit")}(req.ip)) {</div>
    </div>
    <div class="pf"><b>Show 16 more ↓</b> · <b>Jump ⏎</b></div>
  </div>
  <div class="peek">
    <div class="ph"><span class="mono">withRateLimit.ts:7</span><span class="tag">added in this PR</span><span style="flex:1"></span><span style="color:var(--muted)">expanded</span></div>
    <div class="code scrolly">
<div class="cl add"><span class="ln">7</span>+ ${kw("export function")} ${fn("withRateLimit")}(handler: ${ty("Handler")}) {</div>
<div class="cl add"><span class="ln">8</span>+   ${kw("return")} ${kw("async")} (req, res) => {</div>
<div class="cl add"><span class="ln">9</span>+     ${kw("if")} (!limiter.${fn("checkLimit")}(req.ip)) {</div>
<div class="cl add"><span class="ln">10</span>+       ${kw("const")} err: ${ty("ApiError")} = {</div>
<div class="cl add"><span class="ln">11</span>+         code: ${st("'RATE_LIMITED'")},</div>
<div class="cl add"><span class="ln">12</span>+         message: ${st("'Too many attempts'")},</div>
<div class="cl add"><span class="ln">13</span>+         retryAfterSeconds: ${ct("60")},</div>
<div class="cl add"><span class="ln">14</span>+       };</div>
<div class="cl add"><span class="ln">15</span>+       ${kw("return")} res.status(${ct("429")}).json(err);</div>
    </div>
    <div class="pf">23 lines · scrolls in place — main diff never moves · <b>Jump ⏎</b></div>
  </div>
  </div>
</div>
<h4>Definition → usages (each with its line inline — pre-peeked)</h4>
<div class="snip">
  <div class="sh"><span class="mono">rateLimiter.ts</span><span class="pill">2 usages in this PR</span></div>
  <div class="pop">
    <ul class="uses" style="margin-top:0">
      <li><span class="mono">withRateLimit.ts:9</span> — <span class="mono">limiter.checkLimit(req.ip)</span></li>
      <li><span class="mono">rateLimiter.test.ts:14</span> — <span class="mono">expect(limiter.checkLimit('k'))</span></li>
    </ul>
  </div>
</div>
<div class="back">↩ back to <span class="mono">withRateLimit.ts:9</span></div>
<p class="cap" style="margin-top:12px">The ladder is <b>peek → expand → jump</b>, each step heavier than the last. Definitions longer than <span class="mono">peekMaxLines</span> (default 15, a controllable-core setting) truncate with a fade; <b>Show more</b> grows the popup in place, and past ~60% viewport height the code scrolls <i>inside</i> it — the main diff never moves. Only real jumps enter the jump stack behind the ↩ chip. Underlines appear only when the counterpart is inside the PR (<span class="mono">SymbolOccurrence[]</span>); deep mode extends peeks to ghost files, read-only.</p>`,
  })
)

// ── components/buttons ──────────────────────────────────────
cards.push(
  card({
    path: "components/buttons.html",
    group: "Components",
    name: "Buttons & verdicts",
    subtitle: "primary / secondary / verdict trio / disabled",
    width: 700,
    height: 340,
    css: `
.row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
.btn { border-radius: 8px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.approve { background: var(--added); border-color: var(--added); color: #fff; }
.btn.reject { background: var(--deleted); border-color: var(--deleted); color: #fff; }
.btn[disabled] { opacity: .4; cursor: default; }`,
    body: `
<h4>Actions</h4>
<div class="row"><button class="btn primary">Open next file</button><button class="btn">Deepen analysis 🔬</button><button class="btn" disabled>Submit review</button></div>
<h4>Verdict (one required at submit)</h4>
<div class="row"><button class="btn approve">✓ Approve</button><button class="btn">💬 Comment</button><button class="btn reject">✗ Request changes</button></div>
<p style="color:var(--muted);font-size:12px">Verdict colors reuse diff-status tokens: approve = added-green, request-changes = deleted-red. No new hues.</p>`,
  })
)

// ── screens/app-shell (hero) ────────────────────────────────
const miniNode = (x, y, cls, nm, ord, tick = false) => `
<div class="mn ${cls}" style="left:${x}px;top:${y}px"><span class="mono">${nm}</span><span class="o">#${ord}</span>${tick ? '<span class="t">✓</span>' : ""}</div>`
cards.push(
  card({
    path: "screens/app-shell.html",
    group: "Screens",
    name: "App shell — reviewing PR #42",
    subtitle: "graph pane · rich diff · review tray (3/6, next suggested)",
    width: 1440,
    height: 780,
    css: `
body { padding: 0; }
.shell { display: grid; grid-template-columns: 400px 1fr 300px; height: 740px; }
.pane { border-right: 1px solid var(--border); overflow: hidden; display: flex; flex-direction: column; }
.ph { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; background: var(--panel); }
.badge { font-size: 10px; font-weight: 700; border-radius: 5px; padding: 1px 7px; background: var(--added-soft); color: var(--added); }
.gwrap { position: relative; flex: 1; }
.mn { position: absolute; width: 150px; background: var(--panel); border: 1.5px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 10px; }
.mn .o { color: var(--accent); font-weight: 700; margin-left: 5px; }
.mn .t { color: var(--added); font-weight: 700; float: right; }
.mn.added { border-color: var(--added); } .mn.modified { border-color: var(--modified); }
.mn.next { border-color: var(--accent); border-width: 2.5px; box-shadow: 0 0 0 3px var(--accent-soft); }
.mn.done { opacity: .5; }
.mn.ghost { border-style: dashed; border-color: var(--muted); background: transparent; }
.glines { position: absolute; inset: 0; }
.diff { flex: 1; overflow: hidden; font: 12px/1.7 ui-monospace, Menlo, monospace; }
.dl { padding: 0 14px; white-space: pre; }
.dl.add { background: var(--added-soft); }
.dl .ln { display: inline-block; width: 30px; color: var(--muted); }
.tray-rows { flex: 1; }
.tr { display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 11px; }
.tr .p { flex: 1; }
.tr.done { color: var(--reviewed); }
.tr.next { background: var(--accent-soft); font-weight: 700; }
.ok { color: var(--added); font-weight: 700; } .nx { color: var(--accent); font-weight: 700; }
.ft { padding: 10px 12px; display: flex; gap: 8px; border-top: 1px solid var(--border); }
.btn { flex: 1; text-align: center; padding: 8px 0; border-radius: 8px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.top { height: 40px; display: flex; align-items: center; gap: 12px; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--panel); font-size: 13px; }`,
    body: `
<div class="top"><b>PR #42 — Add login rate limiting</b><span class="badge">DEEP · REPO</span><span title="Clone folder settings" style="font-size:13px;cursor:pointer">⚙️</span><span style="flex:1"></span><span class="mono" style="font-size:11px;color:var(--muted)">acme/webapp · headSha 3f9c2e1</span></div>
<div class="shell">
  <div class="pane">
    <div class="ph">Dependency graph <span class="mono" style="font-size:10px;color:var(--muted)">A → B = depends on</span></div>
    <div class="gwrap">
      <svg class="glines" width="400" height="640">
        <defs><marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)"/></marker></defs>
        <line x1="150" y1="215" x2="110" y2="120" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#m)"/>
        <line x1="215" y1="360" x2="160" y2="245" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#m)"/>
        <line x1="215" y1="380" x2="120" y2="470" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#m)"/>
        <line x1="200" y1="370" x2="115" y2="140" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#m)"/>
        <line x1="235" y1="520" x2="245" y2="415" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#m)"/>
        <line x1="140" y1="595" x2="120" y2="245" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#m)"/>
        <line x1="170" y1="600" x2="145" y2="140" stroke="var(--muted)" stroke-width="1.4" marker-end="url(#m)"/>
      </svg>
      ${miniNode(40, 80, "added done", "limits.ts", 1, true)}
      ${miniNode(40, 460, "modified done", "http.ts", 2, true)}
      ${miniNode(100, 205, "added done", "rateLimiter.ts", 3, true)}
      ${miniNode(180, 350, "added next", "withRateLimit.ts", 4)}
      ${miniNode(180, 510, "added", "rateLimiter.test.ts", 5)}
      ${miniNode(100, 590, "modified", "login.ts", 6)}
    </div>
  </div>
  <div class="pane">
    <div class="ph"><span class="mono">src/middleware/withRateLimit.ts</span><label style="font-weight:400;font-size:12px"><input type="checkbox"> Mark viewed</label></div>
    <div class="diff">
<div class="dl add"><span class="ln">1</span>+ ${kw("import")} { ${sym(fn("createRateLimiter"))} } ${kw("from")} ${st("'../lib/rateLimiter'")};</div>
<div class="dl add"><span class="ln">2</span>+ ${kw("import")} { ${sym(ct("LOGIN_RATE_LIMIT"))} } ${kw("from")} ${st("'../config/limits'")};</div>
<div class="dl add"><span class="ln">3</span>+ ${kw("import type")} { ${sym(ty("ApiError"))} } ${kw("from")} ${st("'../types/http'")};</div>
<div class="dl add"><span class="ln">4</span>+</div>
<div class="dl add"><span class="ln">5</span>+ ${kw("const")} limiter = ${sym(fn("createRateLimiter"))}(${sym(ct("LOGIN_RATE_LIMIT"))});</div>
<div class="dl add"><span class="ln">6</span>+</div>
<div class="dl add"><span class="ln">7</span>+ ${kw("export function")} ${fn("withRateLimit")}(handler: ${ty("Handler")}): ${ty("Handler")} {</div>
<div class="dl add"><span class="ln">8</span>+   ${kw("return")} ${kw("async")} (req, res) => {</div>
<div class="dl add"><span class="ln">9</span>+     ${kw("if")} (!limiter.${sym(fn("checkLimit"))}(req.ip)) {</div>
<div class="dl add"><span class="ln">10</span>+       ${kw("const")} err: ${sym(ty("ApiError"))} = { code: ${st("'RATE_LIMITED'")},</div>
<div class="dl add"><span class="ln">11</span>+         message: ${st("'Too many attempts'")}, retryAfterSeconds: ${ct("60")} };</div>
<div class="dl add"><span class="ln">12</span>+       ${kw("return")} res.status(${ct("429")}).json(err);</div>
<div class="dl add"><span class="ln">13</span>+     }</div>
<div class="dl add"><span class="ln">14</span>+     ${kw("return")} handler(req, res);</div>
<div class="dl add"><span class="ln">15</span>+   };</div>
<div class="dl add"><span class="ln">16</span>+ }</div>
    </div>
  </div>
  <div class="pane" style="border-right:0">
    <div class="ph">Review — <span class="mono">3/6</span></div>
    <div class="tray-rows">
      <div class="tr done"><span class="p mono">limits.ts</span><span class="ok">✓</span></div>
      <div class="tr done"><span class="p mono">http.ts</span><span class="ok">✓</span></div>
      <div class="tr done"><span class="p mono">rateLimiter.ts</span><span class="ok">✓</span></div>
      <div class="tr next"><span class="p mono">withRateLimit.ts</span><span class="nx">👉 next</span></div>
      <div class="tr"><span class="p mono">rateLimiter.test.ts</span><span class="mono" style="color:var(--muted)">1.00</span></div>
      <div class="tr"><span class="p mono">login.ts</span><span class="mono" style="color:var(--muted)">0.00</span></div>
    </div>
    <div class="ft"><button class="btn" disabled>Submit</button><button class="btn primary">Open next</button></div>
  </div>
</div>`,
  })
)

// ── screens/home (My repos) ─────────────────────────────────
const prRow = (num, title, meta) => `
<div class="pr"><span class="mono n">#${num}</span><span class="t">${title}</span><span class="m">${meta}</span></div>`
const repoCard = (name, slug, path, count, rows) => `
<div class="repo">
  <div class="rh"><span class="rn">${name}</span><span class="rs mono">${slug}</span><span class="rc">${count}</span><span class="ic">↻</span><span class="ic">✕</span></div>
  <div class="rp mono">${path}</div>
  ${rows}
</div>`
cards.push(
  card({
    path: "screens/home.html",
    group: "Screens",
    name: "Home — My repos",
    subtitle: "linked local repos · open-PR picker · URL paste on top",
    width: 720,
    height: 780,
    css: `
.wrap { max-width: 640px; margin: 0 auto; padding: 28px 4px 40px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 28px; }
.sh { display: flex; align-items: center; justify-content: space-between; margin: 0 0 10px; }
.st { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.row { display: flex; gap: 8px; margin-bottom: 32px; }
.in { flex: 1; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--muted); font-size: 13px; }
.btn { padding: 9px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.sm { padding: 6px 12px; font-size: 12px; }
.repo { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); margin-bottom: 12px; overflow: hidden; }
.rh { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.rn { font-weight: 600; }
.rs { font-size: 11px; color: var(--muted); flex: 1; }
.rc { font-size: 12px; color: var(--muted); }
.ic { color: var(--muted); font-size: 13px; padding: 0 4px; cursor: pointer; }
.rp { padding: 6px 14px; font-size: 11px; color: var(--muted); border-bottom: 1px solid var(--border); }
.pr { display: flex; align-items: baseline; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); font-size: 13px; }
.pr:first-of-type { border-top: 0; }
.pr:hover { background: var(--accent-soft); }
.pr .n { color: var(--muted); font-size: 12px; }
.pr .t { flex: 1; }
.pr .m { font-size: 11px; color: var(--muted); white-space: nowrap; }
.empty-pr { padding: 12px 14px; font-size: 12px; color: var(--muted); }`,
    body: `
<div class="wrap">
  <h1>PR Review Visualizer</h1>
  <p class="sub">Open a pull request by URL, or pick one from your linked repos.</p>

  <div class="sh"><span class="st">Open a PR</span></div>
  <div class="row"><span class="in">Paste a GitHub PR URL…</span><span class="btn primary">Go</span></div>

  <div class="sh"><span class="st">My repos</span><span class="btn sm">+ Add local repo</span></div>
  ${repoCard(
    "webapp",
    "acme/webapp",
    "/Users/dev/src/webapp",
    "3 open PRs",
    prRow(42, "Add login rate limiting", "octocat · 2h ago") +
      prRow(40, "Fix session refresh", "hubber · 1d ago") +
      prRow(38, "Retry queue for webhooks", "octocat · 3d ago")
  )}
  ${repoCard(
    "mobile",
    "acme/mobile",
    "/Users/dev/src/mobile",
    "1 open PR",
    prRow(7, "Bump RN to 0.81", "appdev · 5h ago")
  )}
  ${repoCard("infra", "acme/infra", "/Users/dev/src/infra", "0 open PRs", '<div class="empty-pr">No open PRs.</div>')}
</div>`,
  })
)

// ── token source files (not cards) ──────────────────────────
writeFileSync(
  join(OUT, "tokens.css"),
  `/* PR Review Visualizer — design tokens (source of truth: build.mjs) */
:root {\n${varsBlock("light")}\n}
@media (prefers-color-scheme: dark) { :root {\n${varsBlock("dark")}\n} }
:root[data-theme="light"] {\n${varsBlock("light")}\n}
:root[data-theme="dark"] {\n${varsBlock("dark")}\n}
`
)
writeFileSync(
  join(OUT, "tokens.ts"),
  `// PR Review Visualizer — design tokens (source of truth: build.mjs)
export const tokens = ${JSON.stringify(TOKENS, null, 2)} as const;
export type TokenName = keyof typeof tokens.light;
`
)

console.log("emitted:", cards.length, "cards + tokens.css + tokens.ts")
console.log(JSON.stringify(cards, null, 1))
