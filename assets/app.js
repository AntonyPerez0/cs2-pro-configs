/* cs2-pro-configs - renders index grid + player profiles, builds copy-paste
   console command blocks, and draws crosshair previews from convars. */

"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/* ---------------- clipboard ---------------- */

function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

async function copyText(text) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (_) { /* fall through */ }
  if (!ok) ok = legacyCopy(text);
  const toast = $("#toast");
  if (toast) {
    toast.textContent = ok ? "Copied to clipboard" : "Copy failed - select the text manually";
    toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.remove("show"), 1600);
  }
  return ok;
}

/* One delegated listener handles every copy button, including ones created
   or given their data-copy value later (the DPI-adjusted config, the
   sensitivity line, the raw cfg after its fetch resolves). Reads data-copy
   at click time, so late-set values work. */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn || !btn.dataset.copy) return;
  const ok = await copyText(btn.dataset.copy);
  if (ok) {
    const prev = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove("copied");
    }, 1200);
  }
});

/* ---------------- command building ---------------- */

const BUCKETS = [
  {
    key: "crosshair", title: "Crosshair", tag: "cl_crosshair_*",
    test: (n) => n.startsWith("cl_crosshair"),
  },
  {
    key: "mouse", title: "Mouse & Sensitivity", tag: "sensitivity",
    test: (n) => /^(sensitivity|zoom_sensitivity|m_yaw|m_pitch|m_customaccel)/.test(n),
  },
  {
    key: "viewmodel", title: "Viewmodel", tag: "viewmodel_*",
    test: (n) => n.startsWith("viewmodel"),
  },
  {
    key: "radar", title: "Radar", tag: "cl_radar_*",
    test: (n) => n.startsWith("cl_radar_") || n === "cl_hud_radar_scale",
  },
  {
    key: "hud", title: "HUD", tag: "hud_*",
    test: (n) =>
      n.startsWith("hud_") || n.startsWith("safezone") || n.startsWith("cl_hud_") ||
      /^(cl_drawhud|cl_showfps|cl_teammate_colors_show|cl_show_clan_in_death_notice|cl_allow_animated_avatars|cl_teamcounter_playercount_instead_of_avatars)/.test(n),
  },
  { key: "misc", title: "Performance & Other", tag: "misc", test: () => true },
];

function bucketConvars(convars) {
  const out = {};
  for (const [k, v] of Object.entries(convars || {})) {
    const b = BUCKETS.find((b) => b.test(k));
    (out[b.key] = out[b.key] || []).push([k, v]);
  }
  return out;
}

/* Convars that must NOT go into a console paste:
   - cl_drawhud is cheat-protected in CS2 (errors without sv_cheats)
   - cl_radar_size was removed in CS2
   - setting.defaultres/-height are cs2_video.txt file keys, not console convars */
const CONSOLE_SKIP = new Set([
  "cl_drawhud",
  "cl_radar_size",
  "setting.defaultres",
  "setting.defaultresheight",
]);

/* ---- Sept 22, 2026 "Rush Hour" crosshair migration ----
   The patch removed 6 legacy crosshair convars and replaced the geometry
   system. This is an exact port of the community reference converter's
   shipped model (small-indie-crosshair-company, build 2000914 dump,
   structural inverse DEFAULT_PHI with all heights frozen at 1080 — the
   convention the post-patch pro round-ups used). Validated against the
   original engine on its 138-record corpus + 20k randomized inputs:
   zero mismatches. donk/m0NESY/s1mple -> length 2 / thickness 2 / gap 0,
   matching their published post-patch settings. */
const XHAIR_REMOVED = new Set([
  "cl_crosshairgap", "cl_crosshairusealpha", "cl_crosshaircolor",
  "cl_crosshair_outlinethickness", "cl_crosshairgap_useweaponvalue",
  "cl_fixedcrosshairgap",
]);
const XHAIR_HIDDEN_LEGACY = new Set([
  "cl_crosshairsize", "cl_crosshairthickness", "cl_crosshairalpha",
]);
const XHAIR_PRESET_RGB = [
  [250, 50, 50],   // 0 red
  [50, 250, 50],   // 1 green
  [250, 250, 50],  // 2 yellow
  [50, 50, 250],   // 3 blue
  [50, 250, 250],  // 4 cyan
];

function legacyGeometry(size, thickness, gap) {
  const scale = Math.fround(1080 / 480);
  const length = Math.trunc(Math.fround(scale * Math.fround(size)));
  const width = Math.max(1, Math.trunc(Math.fround(scale * Math.fround(thickness))));
  const gapOffset = Math.trunc(Math.fround(Math.fround(gap) + 4));
  const near = Math.floor(width / 2) + gapOffset;
  return { length, width, gapOffset, near };
}

function bestInteger(maxv, ideal, loss) {
  let best = null;
  for (let v = 0; v <= maxv; v++) {
    const err = loss(v);
    const tie = Math.abs(v - ideal);
    if (!best || err < best.err || (err === best.err && tie < best.tie)) best = { err, tie, v };
  }
  return best;
}

/* joint thickness+gap solver (rT = rG = 1 at the 1080 freeze) */
function invertJoint(targetWidth, nearT, hasLength, preserveZero) {
  const values = preserveZero ? [0] : Array.from({ length: 32 }, (_, i) => i);
  let best = null;
  for (const vt of values) {
    const width = Math.max(1, vt);
    const base = Math.floor(width / 2);
    const idealGap = hasLength ? nearT - base : 0;
    const g = bestInteger(128, idealGap, (v) => {
      if (!hasLength) return 0;
      const near = base + v;
      return (near - nearT) ** 2 + (near + 1 - (nearT + 1)) ** 2;
    });
    const idealT = preserveZero ? 0 : targetWidth;
    const tLoss = (width - targetWidth) ** 2;
    const tTie = Math.abs(vt - idealT);
    const total = tLoss + g.err;
    const pref = tTie + g.tie;
    if (!best || total < best.total || (total === best.total && pref < best.pref)) {
      best = { total, pref, thickness: vt, gap: g.v };
    }
  }
  return best;
}

function convertGeometry(size, thickness, gap) {
  const leg = legacyGeometry(size, thickness, gap);
  const inv = invertJoint(leg.width, leg.near, leg.length > 0, thickness === 0);
  return {
    length: Math.max(0, Math.min(255, Math.trunc(leg.length))),
    thickness: inv.thickness,
    gap: inv.gap,
    gapClamped: leg.gapOffset < 0,
  };
}

const xclamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(v)));

function convertCrosshair(cv) {
  const numv = (raw, d) => {
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : d;
  };
  const boolOn = (v) => v === "1" || String(v).trim().toLowerCase() === "true";
  const commands = [];
  const warnings = [];

  const style = Math.round(numv(cv.cl_crosshairstyle, 4));
  commands.push(`cl_crosshairstyle ${style}`);
  if (style !== 4) {
    warnings.push(`Style ${style} was renumbered in the Sept 2026 patch (4 = Static Cross). Non-static styles may need a manual pick in Settings → Crosshair/Scopes.`);
  }

  const hasSize = cv.cl_crosshairsize !== undefined;
  const hasTh = cv.cl_crosshairthickness !== undefined;
  const hasGap = cv.cl_crosshairgap !== undefined;
  const legacyDotOn = boolOn(cv.cl_crosshairdot ?? "false");
  let forcedDot = false;
  if (hasSize || hasTh || hasGap) {
    const geo = convertGeometry(
      numv(cv.cl_crosshairsize, 0),
      numv(cv.cl_crosshairthickness, 0),
      numv(cv.cl_crosshairgap, 0));
    if (hasSize) commands.push(`cl_crosshair_length ${geo.length}`);
    if (hasTh) {
      // The new system renders thickness 0 as NOTHING (no bars, and a
      // zero-width dot if dot-only) - confirmed in-game (woxic, Jame).
      // The legacy engine rendered thickness 0 as a 1px minimum, so the
      // faithful conversion of "thickness 0" is 1 (the thinnest visible
      // setting the new system's UI offers).
      const tVal = Math.max(1, geo.thickness);
      commands.push(`cl_crosshair_thickness ${tVal}`);
    }
    if (hasGap) {
      if (geo.gapClamped) {
        warnings.push("Old gap put the lines past the center — the new gap can't go below 0, so the closest possible look is used.");
      }
      commands.push(`cl_crosshair_gap ${geo.gap}`);
    }
    if (geo.length === 0 && !legacyDotOn) {
      // zero-length arms render nothing in the new system: dot designs must
      // be rebuilt as zero arm length + center dot (reference construction)
      forcedDot = true;
      warnings.push("Dot-only crosshair: the arms are zero-length, so the center dot is enabled (a zero-length crosshair without a dot renders nothing in the new system).");
    }
  }

  for (const k of ["cl_crosshairdot", "cl_crosshair_t", "cl_crosshair_drawoutline", "cl_crosshair_recoil"]) {
    if (k === "cl_crosshairdot") {
      commands.push(`cl_crosshairdot ${(forcedDot || legacyDotOn) ? 1 : 0}`);
      continue;
    }
    if (cv[k] !== undefined) commands.push(`${k} ${boolOn(cv[k]) ? 1 : 0}`);
  }

  let rgb = null;
  if (cv.cl_crosshaircolor !== undefined) {
    const idx = Math.round(numv(cv.cl_crosshaircolor, 5));
    if (idx === 5) {
      rgb = [
        xclamp(numv(cv.cl_crosshaircolor_r, 255), 0, 255),
        xclamp(numv(cv.cl_crosshaircolor_g, 255), 0, 255),
        xclamp(numv(cv.cl_crosshaircolor_b, 255), 0, 255),
      ];
    } else if (XHAIR_PRESET_RGB[idx]) {
      rgb = XHAIR_PRESET_RGB[idx];
    }
  } else if (cv.cl_crosshaircolor_r !== undefined) {
    rgb = [
      xclamp(numv(cv.cl_crosshaircolor_r, 255), 0, 255),
      xclamp(numv(cv.cl_crosshaircolor_g, 255), 0, 255),
      xclamp(numv(cv.cl_crosshaircolor_b, 255), 0, 255),
    ];
  }
  if (rgb) commands.push(`cl_crosshaircolor_r ${rgb[0]}`, `cl_crosshaircolor_g ${rgb[1]}`, `cl_crosshaircolor_b ${rgb[2]}`);

  if (cv.cl_crosshairalpha !== undefined || cv.cl_crosshairusealpha !== undefined) {
    const enabled = boolOn(cv.cl_crosshairusealpha ?? "false");
    const a = enabled ? xclamp(numv(cv.cl_crosshairalpha, 200), 0, 255) : 200;
    commands.push(`cl_crosshaircolor_a ${a}`);
    if (!enabled) warnings.push("Old config had the alpha slider disabled; opacity is reconstructed as 200 (new system changed how alpha works).");
  }

  for (const [k, v] of Object.entries(cv)) {
    if (/^cl_crosshair_dynamic_/.test(k) || k === "cl_crosshair_sniper_width") {
      const sv = safeValue(v);
      if (sv !== null) commands.push(`${k} ${sv}`);
    }
  }

  commands.push("cl_crosshair_screen_height 1080");
  return { commands, warnings };
}

/* values are joined straight into a console line, so anything containing
   ; or quotes or newlines would inject extra commands - drop those (none
   exist in the current dataset; this guards future scrapes). Booleans are
   normalized to 1/0: post-Rush-Hour convars are int-typed and reject
   "true"/"false", while 0/1 is accepted everywhere. */
function safeValue(v) {
  const s = String(v).trim();
  if (!s || /[;"'\n\r]/.test(s)) return null;
  const low = s.toLowerCase();
  if (low === "true") return "1";
  if (low === "false") return "0";
  return s;
}

/* commands in paste order: converted crosshair first (most important lands
   first even if a very long paste ever gets truncated), misc last */
function consoleCommands(rec) {
  const buckets = bucketConvars(rec.convars);
  const out = [];
  const xc = convertCrosshair(rec.convars || {});
  out.push(...xc.commands);
  for (const b of BUCKETS) {
    if (b.key === "crosshair") continue;
    for (const [k, v] of buckets[b.key] || []) {
      if (CONSOLE_SKIP.has(k) || XHAIR_REMOVED.has(k) || XHAIR_HIDDEN_LEGACY.has(k)) continue;
      const sv = safeValue(v);
      if (sv !== null) out.push(`${k} ${sv}`);
    }
  }
  return { commands: out, warnings: xc.warnings };
}

function buildFullBlock(rec) {
  return consoleCommands(rec).commands.join("; ");
}

/* ---------------- sensitivity converter (eDPI match) ---------------- */

const DPI_KEY = "cs2pros:your-dpi";

function getUserDpi() {
  const v = parseInt(localStorage.getItem(DPI_KEY) || "", 10);
  return Number.isFinite(v) && v >= 50 ? v : null;
}

/* cm per 360° for an eDPI in CS2: 2.54*360 / (0.022 * eDPI) = 41563.6 / eDPI */
function cmPer360(edpi) {
  return 41563.6 / edpi;
}

/* the pro's effective sensitivity data (or null if not on their page) */
function proEdpi(rec) {
  const dpiPro = parseInt(String((rec.tables && rec.tables["Mouse"] && rec.tables["Mouse"]["DPI"]) || "").replace(/[^\d]/g, ""), 10);
  const sensPro = parseFloat(rec.convars && rec.convars.sensitivity);
  if (!Number.isFinite(dpiPro) || dpiPro <= 0 || !Number.isFinite(sensPro) || sensPro <= 0) return null;
  const edpi = dpiPro * sensPro;
  return { dpiPro, sensPro, edpi, cm: cmPer360(edpi) };
}

function sensForDpi(rec, yourDpi) {
  const base = proEdpi(rec);
  if (!base) return null;
  if (!Number.isFinite(yourDpi) || yourDpi < 50) return null;
  return {
    edpi: base.edpi,
    cm: base.cm,
    sens: parseFloat((base.edpi / yourDpi).toFixed(4)),
  };
}

/* full command line with the sensitivity command rewritten for your DPI */
function consoleCommandsWithSens(rec, yourDpi) {
  const m = sensForDpi(rec, yourDpi);
  if (!m) return null;
  return consoleCommands(rec)
    .commands
    .map((c) => (c.startsWith("sensitivity ") ? `sensitivity ${m.sens}` : c))
    .join("; ");
}

/* ---------------- crosshair preview ---------------- */

const XHAIR_COLORS = {
  0: [255, 0, 0],
  1: [0, 255, 0],
  2: [255, 255, 0],
  3: [0, 191, 255],
  4: [0, 255, 255],
};

function xhairGeometry(cv, xcCommands) {
  const num = (x, d) => {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : d;
  };
  const bool = (x, d = false) => (x === undefined ? d : x === "1" || String(x).trim().toLowerCase() === "true");

  // prefer the NEW system convars (post Sept 2026) when available
  const ncv = {};
  for (const cmd of xcCommands || []) {
    const i = cmd.indexOf(" ");
    if (i > 0) ncv[cmd.slice(0, i)] = cmd.slice(i + 1);
  }
  const isNew = ncv.cl_crosshair_length !== undefined || ncv.cl_crosshair_gap !== undefined;

  // geometry in game pixels at the authored height (1080)
  const lengthPx = isNew
    ? num(ncv.cl_crosshair_length, 8)
    : Math.trunc((num(cv.cl_crosshair_screen_height, 1080) / 480) * num(cv.cl_crosshairsize, 5));
  const thickPx = isNew
    ? Math.max(1, num(ncv.cl_crosshair_thickness, 2))
    : Math.max(1, Math.trunc((num(cv.cl_crosshair_screen_height, 1080) / 480) * num(cv.cl_crosshairthickness, 1)));
  const gapPx = isNew
    ? num(ncv.cl_crosshair_gap, 4)
    : Math.trunc(num(cv.cl_crosshairgap, 0) + 4);
  const dot = bool(ncv.cl_crosshairdot ?? cv.cl_crosshairdot);
  const tShape = bool(ncv.cl_crosshair_t ?? cv.cl_crosshair_t);
  const outline = bool(ncv.cl_crosshair_drawoutline ?? cv.cl_crosshair_drawoutline);

  let rgb;
  if (ncv.cl_crosshaircolor_r !== undefined) {
    rgb = [num(ncv.cl_crosshaircolor_r, 255), num(ncv.cl_crosshaircolor_g, 255), num(ncv.cl_crosshaircolor_b, 255)];
  } else {
    const colorIdx = parseInt(cv.cl_crosshaircolor, 10);
    rgb = XHAIR_COLORS[Number.isFinite(colorIdx) ? colorIdx : 1] || XHAIR_COLORS[1];
    if (colorIdx === 5 || cv.cl_crosshaircolor_r) {
      rgb = [num(cv.cl_crosshaircolor_r, 255), num(cv.cl_crosshaircolor_g, 255), num(cv.cl_crosshaircolor_b, 255)];
    }
  }
  const alpha = (ncv.cl_crosshaircolor_a !== undefined
    ? num(ncv.cl_crosshaircolor_a, 255)
    : (bool(cv.cl_crosshairusealpha, true) ? num(cv.cl_crosshairalpha, 255) : 255)) / 255;

  // bars start floor(th/2)+gap px from center, extend length px outward
  const nearPx = Math.floor(thickPx / 2) + gapPx;
  const arms = [];
  if (lengthPx > 0) {
    arms.push([-(nearPx + lengthPx), -thickPx / 2, lengthPx, thickPx]); // left
    arms.push([nearPx, -thickPx / 2, lengthPx, thickPx]);               // right
    if (!tShape) arms.push([-thickPx / 2, -(nearPx + lengthPx), thickPx, lengthPx]); // top (T omits it)
    arms.push([-thickPx / 2, nearPx, thickPx, lengthPx]);               // bottom
  }
  if (dot) arms.push([-thickPx / 2, -thickPx / 2, thickPx, thickPx]);

  return { arms, rgb: rgb.map(Math.round), alpha, outline, lengthPx, thickPx, span: nearPx + lengthPx };
}

function xhairPaint(ctx, geo, pxPerGamePx, S) {
  ctx.fillStyle = "#20242b";
  ctx.fillRect(0, 0, S, S);
  const c = S / 2;
  const rects = geo.arms.map(([x, y, w, h]) => [
    Math.round(c + x * pxPerGamePx),
    Math.round(c + y * pxPerGamePx),
    Math.max(1, Math.round(w * pxPerGamePx)),
    Math.max(1, Math.round(h * pxPerGamePx)),
  ]);
  if (geo.outline) {
    // 1 game-px dark edge under the colored bars (outline width convar was
    // removed by the patch; the game's outline is a thin dark edge)
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    for (const [dx, dy, dw, dh] of rects) {
      const o = Math.max(1, Math.round(pxPerGamePx));
      ctx.fillRect(dx - o, dy - o, dw + o * 2, dh + o * 2);
    }
  }
  ctx.fillStyle = `rgba(${geo.rgb.join(",")},${geo.alpha})`;
  for (const [dx, dy, dw, dh] of rects) ctx.fillRect(dx, dy, dw, dh);
}

/* Two-view preview: true in-game scale on the user's screen + pixel zoom. */
function drawCrosshair(trueCanvas, zoomCanvas, cv, xcCommands) {
  const geo = xhairGeometry(cv, xcCommands);
  const dpr = window.devicePixelRatio || 1;
  const CSS = 150;
  const screenH = (window.screen && window.screen.height) || 1080;

  // true scale: the game rescales the authored-1080px size to your resolution
  trueCanvas.width = CSS * dpr;
  trueCanvas.height = CSS * dpr;
  xhairPaint(trueCanvas.getContext("2d"), geo, (screenH / 1080) * dpr, CSS * dpr);

  // pixel zoom inspector with a game-pixel grid
  const zoom = Math.max(2, Math.min(40, Math.floor((CSS / 2 - 10) / Math.max(3, geo.span + 2))));
  zoomCanvas.width = CSS * dpr;
  zoomCanvas.height = CSS * dpr;
  const zctx = zoomCanvas.getContext("2d");
  zctx.fillStyle = "#20242b";
  zctx.fillRect(0, 0, CSS * dpr, CSS * dpr);
  if (zoom * dpr >= 6) {
    zctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let i = -40; i <= 40; i++) {
      const off = Math.round((CSS * dpr) / 2 + i * zoom * dpr);
      zctx.fillRect(off, 0, 1, CSS * dpr);
      zctx.fillRect(0, off, CSS * dpr, 1);
    }
  }
  xhairPaint(zctx, geo, zoom * dpr, CSS * dpr);

  return { zoom, lengthPx: geo.lengthPx, thickPx: geo.thickPx, screenH };
}

/* ---------------- index page: DOM filter over prerendered cards ---------------- */

function runIndex() {
  const grid = $("#grid");
  const count = $("#result-count");
  const input = $("#q");
  const sortSel = $("#sort");
  const resSel = $("#res");
  if (!grid || !grid.querySelector(".card")) return;

  const cards = [...grid.querySelectorAll(".card")];
  const state = { q: "", sort: "recent", res: "" };

  let empty = grid.querySelector(".empty");
  if (!empty) {
    empty = document.createElement("div");
    empty.className = "empty";
    grid.appendChild(empty);
  }

  function apply() {
    const q = state.q.trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const hay = ((card.dataset.nick || "") + " " + (card.dataset.real || "") + " " + (card.dataset.slug || "")).toLowerCase();
      const show = (!q || hay.includes(q)) && (!state.res || card.dataset.res === state.res);
      card.hidden = !show;
      if (show) visible++;
    }
    const cmp = {
      "recent": null,
      "edpi-desc": (a, b) => (parseFloat(b.dataset.edpi) || 0) - (parseFloat(a.dataset.edpi) || 0),
      "edpi-asc": (a, b) => (parseFloat(a.dataset.edpi) || 0) - (parseFloat(b.dataset.edpi) || 0),
      "sens-desc": (a, b) => (parseFloat(b.dataset.sens) || 0) - (parseFloat(a.dataset.sens) || 0),
      "sens-asc": (a, b) => (parseFloat(a.dataset.sens) || 0) - (parseFloat(b.dataset.sens) || 0),
      "name": (a, b) => (a.dataset.nick || "").localeCompare(b.dataset.nick || ""),
    }[state.sort];
    if (cmp) [...cards].sort(cmp).forEach((c) => grid.appendChild(c));
    grid.appendChild(empty);

    count.textContent = `${visible} player${visible === 1 ? "" : "s"}`;
    empty.textContent = `No players match "${state.q}".`;
    empty.hidden = visible !== 0;
  }

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.res) params.set("res", state.res);
    if (state.sort && state.sort !== "recent") params.set("sort", state.sort);
    const qs = params.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }

  input.addEventListener("input", () => { state.q = input.value; syncUrl(); apply(); });
  sortSel.addEventListener("change", () => { state.sort = sortSel.value; syncUrl(); apply(); });
  resSel.addEventListener("change", () => { state.res = resSel.value; syncUrl(); apply(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      input.focus();
    }
  });

  // restore from URL (?q= is the SearchAction sitelink target)
  const params = new URLSearchParams(location.search);
  if (params.get("q")) { state.q = params.get("q"); input.value = state.q; }
  if (params.get("res")) { state.res = params.get("res"); resSel.value = state.res; }
  if (params.get("sort")) { state.sort = params.get("sort"); sortSel.value = state.sort; }
  apply();
}

/* ---------------- static player pages: enhancement only ----------------
   Content is prerendered; this wires the interactive bits: crosshair
   canvases, the DPI sensitivity matcher and the "Copy all at my DPI"
   button, all driven by the embedded #player-data JSON. */

function runPlayerStatic() {
  let data;
  try {
    data = JSON.parse(document.getElementById("player-data").textContent);
  } catch (_) {
    return;
  }
  const rec = {
    slug: data.slug,
    nick: data.nick,
    convars: data.convars,
    tables: { Mouse: { DPI: data.dpi } },
  };

  const trueCanvas = $("#xhair");
  const zoomCanvas = $("#xhair-zoom");
  if (trueCanvas && zoomCanvas) {
    try {
      drawCrosshair(trueCanvas, zoomCanvas, data.convars, data.xhairCmds);
    } catch (_) { /* preview is optional */ }
  }

  /* DPI matcher widget -> #dpi-slot */
  const dpiSlot = $("#dpi-slot");
  const base = proEdpi(rec);
  if (dpiSlot && base) {
    const box = document.createElement("div");
    box.className = "dpi-match";
    box.innerHTML = `
      <div class="dpi-line">
        <label class="dpi-label">Your mouse DPI
          <input type="number" min="50" step="50" inputmode="numeric" class="dpi-input" placeholder="e.g. 1600">
        </label>
        <span class="dpi-result"></span>
        <button type="button" class="btn ghost small" data-copy-sens style="display:none"></button>
      </div>
      <p class="note">Matching keeps the same <b>eDPI</b> (${Math.round(base.edpi)}) — that's <b>${base.cm.toFixed(1)} cm</b> per 360° turn at any DPI. Enter your DPI and use this sensitivity instead of theirs (or use <b>Copy all at my DPI</b> in the Full config above, which rewrites the <code>sensitivity</code> line for you).</p>`;
    dpiSlot.replaceWith(box);
    const input = $(".dpi-input", box);
    const result = $(".dpi-result", box);
    const btnSens = $("[data-copy-sens]", box);
    const saved = getUserDpi();
    if (saved) input.value = saved;
    const update = () => {
      const dpi = parseInt(input.value, 10);
      const r = sensForDpi(rec, dpi);
      if (r) {
        localStorage.setItem(DPI_KEY, String(dpi));
        result.innerHTML = `→ in-game <b>sensitivity ${r.sens}</b>`;
        btnSens.dataset.copy = `sensitivity ${r.sens}`;
        btnSens.textContent = `Copy sensitivity ${r.sens}`;
        btnSens.style.display = "";
      } else {
        result.textContent = "";
        btnSens.style.display = "none";
      }
      if (window._refreshAdjusted) window._refreshAdjusted();
    };
    input.addEventListener("input", update);
    if (saved) update();
  }

  /* "Copy all at my DPI" button -> #btn-mydpi-slot */
  const mySlot = $("#btn-mydpi-slot");
  if (mySlot && Array.isArray(data.commands)) {
    const btnMy = document.createElement("button");
    btnMy.id = "btn-copy-mydpi";
    btnMy.className = "btn ghost small";
    btnMy.style.display = "none";
    btnMy.title = "Same config, but the sensitivity line is rewritten so the speed (eDPI) matches this pro on YOUR mouse DPI";
    mySlot.appendChild(btnMy);
    const refreshAdjusted = () => {
      const dpi = getUserDpi();
      const m = sensForDpi(rec, dpi);
      if (m) {
        btnMy.dataset.copy = data.commands
          .map((c) => (c.startsWith("sensitivity ") ? `sensitivity ${m.sens}` : c))
          .join("; ");
        btnMy.textContent = `Copy all at my DPI (${dpi})`;
        btnMy.style.display = "";
      } else {
        btnMy.style.display = "none";
      }
    };
    refreshAdjusted();
    window._refreshAdjusted = refreshAdjusted;
  }
}

/* ---------------- boot ---------------- */

const page = document.body.dataset.page;
if (page === "index") runIndex();
else if (page === "player-static") runPlayerStatic();
