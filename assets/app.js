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

function wireCopyButtons(root = document) {
  root.querySelectorAll("[data-copy]").forEach((btn) => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", async () => {
      const ok = await copyText(btn.dataset.copy);
      if (ok) {
        const prev = btn.textContent;
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove("copied");
        }, 1200);
      }
    });
  });
}

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
   system. Conversion model + ranges follow the community reference
   (small-indie-crosshair-company, build 2000914 dump), which reproduces the
   published post-patch values for donk/m0NESY/s1mple exactly. */
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

const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.round(v)));

function resHeightOf(rec) {
  const cv = rec.convars || {};
  const fromCfg = parseInt(cv["setting.defaultresheight"], 10);
  if (Number.isFinite(fromCfg) && fromCfg >= 240) return fromCfg;
  const res = rec.tables && rec.tables["Video Settings"] && rec.tables["Video Settings"]["Resolution"];
  if (res) {
    const m = String(res).match(/(\d+)\s*x\s*(\d+)/i);
    if (m) return clampInt(parseInt(m[2], 10), 240, 8640);
  }
  return 1080;
}

function convertCrosshair(cv, height) {
  const H = Math.max(240, height || 1080);
  const scale = H / 480;
  const num = (k, d) => {
    const v = parseFloat(cv[k]);
    return Number.isFinite(v) ? v : d;
  };
  const has = (k) => cv[k] !== undefined;
  const boolStr = (v) => (v === "1" || String(v).trim().toLowerCase() === "true" ? "true" : "false");
  const commands = [];
  const warnings = [];

  const style = Math.round(num("cl_crosshairstyle", 4));
  commands.push(`cl_crosshairstyle ${style}`);
  if (style !== 4) {
    warnings.push(`Style ${style} was renumbered in the Sept 2026 patch (4 = Static Cross). Non-static styles may need a manual pick in Settings → Crosshair/Scopes.`);
  }

  if (has("cl_crosshairsize")) {
    commands.push(`cl_crosshair_length ${clampInt(Math.trunc(scale * num("cl_crosshairsize", 5)), 0, 255)}`);
  }
  if (has("cl_crosshairthickness")) {
    const t = num("cl_crosshairthickness", 0.6);
    commands.push(`cl_crosshair_thickness ${t === 0 ? 0 : clampInt(Math.max(1, Math.trunc(scale * t)), 0, 31)}`);
  }
  if (has("cl_crosshairgap")) {
    const oldGap = num("cl_crosshairgap", 0);
    const px = Math.trunc(oldGap + 4);
    if (px < 0) {
      warnings.push(`Old gap ${oldGap} put the lines past the center — the new system's gap can't go below 0, so that overlap is clamped (closest possible look).`);
    }
    commands.push(`cl_crosshair_gap ${clampInt(px, 0, 128)}`);
  }

  for (const k of ["cl_crosshairdot", "cl_crosshair_t", "cl_crosshair_drawoutline", "cl_crosshair_recoil"]) {
    if (has(k)) commands.push(`${k} ${boolStr(cv[k])}`);
  }

  let rgb = null;
  const idx = has("cl_crosshaircolor") ? Math.round(num("cl_crosshaircolor", 5)) : null;
  if (idx === 5 || (idx === null && has("cl_crosshaircolor_r"))) {
    rgb = [
      clampInt(num("cl_crosshaircolor_r", 255), 0, 255),
      clampInt(num("cl_crosshaircolor_g", 255), 0, 255),
      clampInt(num("cl_crosshaircolor_b", 255), 0, 255),
    ];
  } else if (idx !== null && XHAIR_PRESET_RGB[idx]) {
    rgb = XHAIR_PRESET_RGB[idx];
    warnings.push("Old color preset converted to its legacy RGB values.");
  }
  if (rgb) {
    commands.push(`cl_crosshaircolor_r ${rgb[0]}`, `cl_crosshaircolor_g ${rgb[1]}`, `cl_crosshaircolor_b ${rgb[2]}`);
  }

  if (has("cl_crosshairalpha") || has("cl_crosshairusealpha")) {
    const enabled = String(cv["cl_crosshairusealpha"]).trim().toLowerCase() === "true" || cv["cl_crosshairusealpha"] === "1";
    const a = enabled ? clampInt(num("cl_crosshairalpha", 200), 0, 255) : 200;
    commands.push(`cl_crosshaircolor_a ${a}`);
    if (!enabled) warnings.push("Old config had the alpha slider disabled; opacity is reconstructed as 200 (new system changed how alpha works).");
  }

  for (const [k, v] of Object.entries(cv)) {
    if (/^cl_crosshair_dynamic_/.test(k) || k === "cl_crosshair_sniper_width") commands.push(`${k} ${v}`);
  }

  commands.push(`cl_crosshair_screen_height ${H}`);
  return { commands, warnings };
}

/* commands in paste order: converted crosshair first (most important lands
   first even if a very long paste ever gets truncated), misc last */
function consoleCommands(rec, resHeight) {
  const buckets = bucketConvars(rec.convars);
  const out = [];
  const xc = convertCrosshair(rec.convars || {}, resHeight);
  out.push(...xc.commands);
  for (const b of BUCKETS) {
    if (b.key === "crosshair") continue;
    for (const [k, v] of buckets[b.key] || []) {
      if (!CONSOLE_SKIP.has(k) && !XHAIR_REMOVED.has(k) && !XHAIR_HIDDEN_LEGACY.has(k)) out.push(`${k} ${v}`);
    }
  }
  return { commands: out, warnings: xc.warnings };
}

function buildFullBlock(rec, resHeight) {
  return consoleCommands(rec, resHeight).commands.join("; ");
}

/* ---------------- crosshair preview ---------------- */

const XHAIR_COLORS = {
  0: [255, 0, 0],
  1: [0, 255, 0],
  2: [255, 255, 0],
  3: [0, 191, 255],
  4: [0, 255, 255],
};

function drawCrosshair(canvas, cv) {
  const ctx = canvas.getContext("2d");
  const S = canvas.width;
  const num = (x, d) => {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : d;
  };
  const bool = (x, d = false) => (x === undefined ? d : String(x).trim().toLowerCase() === "true" || x === "1");

  const size = num(cv.cl_crosshairsize, 5);
  const t = Math.max(0.1, num(cv.cl_crosshairthickness, 1));
  const gap = num(cv.cl_crosshairgap, 5);
  const dot = bool(cv.cl_crosshairdot);
  const outline = bool(cv.cl_crosshair_drawoutline);
  const outlineT = num(cv.cl_crosshair_outlinethickness, 1);
  const useAlpha = bool(cv.cl_crosshairusealpha, true);
  const alpha = useAlpha ? Math.min(1, Math.max(0, num(cv.cl_crosshairalpha, 255) / 255)) : 1;

  const colorIdx = parseInt(cv.cl_crosshaircolor, 10);
  let rgb = XHAIR_COLORS[Number.isFinite(colorIdx) ? colorIdx : 1] || XHAIR_COLORS[1];
  if (colorIdx === 5 || cv.cl_crosshaircolor_r) {
    rgb = [
      num(cv.cl_crosshaircolor_r, 255),
      num(cv.cl_crosshaircolor_g, 255),
      num(cv.cl_crosshaircolor_b, 255),
    ];
  }

  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = "#23282f";
  ctx.fillRect(0, 0, S, S);

  const u = S / 64;
  const c = S / 2;
  const inner = Math.max(0, gap + t / 2) * u;
  const len = size * u;
  const th = t * u;

  ctx.globalAlpha = alpha;
  ctx.fillStyle = `rgb(${rgb.map(Math.round).join(",")})`;

  const arms = [
    [c - inner - len, c - th / 2, len, th],
    [c + inner, c - th / 2, len, th],
    [c - th / 2, c - inner - len, th, len],
    [c - th / 2, c + inner, th, len],
  ];
  if (dot) arms.push([c - th / 2, c - th / 2, th, th]);

  if (outline) {
    ctx.fillStyle = "#000";
    const o = Math.max(0.5, outlineT) * u;
    for (const [x, y, w, h] of arms) {
      ctx.fillRect(x - o, y - o, w + o * 2, h + o * 2);
    }
    ctx.fillStyle = `rgb(${rgb.map(Math.round).join(",")})`;
  }
  for (const [x, y, w, h] of arms) ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
}

/* ---------------- avatars ---------------- */

function avatarEl(rec) {
  if (rec.avatar) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.loading = "lazy";
    img.src = rec.avatar;
    img.alt = "";
    img.onerror = () => img.replaceWith(letterAvatar(rec.nick || rec.slug));
    return img;
  }
  return letterAvatar(rec.nick || rec.slug);
}

function letterAvatar(name) {
  const d = document.createElement("div");
  d.className = "avatar-letter";
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  d.style.background = `linear-gradient(135deg, hsl(${hue} 45% 30%), hsl(${(hue + 40) % 360} 45% 22%))`;
  d.textContent = String(name || "?").charAt(0).toUpperCase();
  return d;
}

/* ---------------- index page ---------------- */

async function runIndex() {
  const main = $("#app");
  let data;
  try {
    data = await fetchJSON("data/index.json");
  } catch (e) {
    main.innerHTML = `<div class="error-box">Failed to load player data: ${esc(e.message)}</div>`;
    return;
  }
  const players = data.players;
  $("#meta-stamp").textContent = `${data.meta.count} players · data refreshed ${new Date(data.meta.generated).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;

  const state = { q: "", sort: "recent", res: "" };

  const grid = $("#grid");
  const count = $("#result-count");
  const input = $("#q");
  const sortSel = $("#sort");
  const resSel = $("#res");

  const resValues = [...new Set(players.map((p) => p.res).filter(Boolean))].sort(
    (a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0)
  );
  for (const rv of resValues) {
    const o = document.createElement("option");
    o.value = rv; o.textContent = rv;
    resSel.appendChild(o);
  }

  const num = (s) => (s === null || s === undefined || s === "" ? NaN : parseFloat(s));

  function apply() {
    let list = players.slice();
    const q = state.q.trim().toLowerCase();
    if (q) {
      list = list.filter((p) =>
        (p.nick || "").toLowerCase().includes(q) ||
        (p.real_name || "").toLowerCase().includes(q) ||
        (p.slug || "").toLowerCase().includes(q));
    }
    if (state.res) list = list.filter((p) => p.res === state.res);
    const by = {
      "edpi-desc": (a, b) => (num(b.edpi) || 0) - (num(a.edpi) || 0),
      "edpi-asc": (a, b) => (num(a.edpi) || 0) - (num(b.edpi) || 0),
      "sens-desc": (a, b) => (num(b.sens) || 0) - (num(a.sens) || 0),
      "sens-asc": (a, b) => (num(a.sens) || 0) - (num(b.sens) || 0),
      "name": (a, b) => (a.nick || "").localeCompare(b.nick || ""),
    }[state.sort];
    if (by) list.sort(by);

    count.textContent = `${list.length} player${list.length === 1 ? "" : "s"}`;
    grid.innerHTML = "";
    if (!list.length) {
      grid.innerHTML = `<div class="empty">No players match "${esc(state.q)}".</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const p of list) {
      const a = document.createElement("a");
      a.className = "card";
      a.href = `player.html?p=${encodeURIComponent(p.slug)}`;
      a.appendChild(avatarEl(p));
      const nick = document.createElement("div");
      nick.className = "nick";
      nick.textContent = p.nick || p.slug;
      a.appendChild(nick);
      const real = document.createElement("div");
      real.className = "real";
      real.textContent = p.real_name || "";
      a.appendChild(real);
      const chips = document.createElement("div");
      chips.className = "chips";
      if (p.edpi !== null && p.edpi !== undefined) {
        chips.insertAdjacentHTML("beforeend", `<span class="chip"><b>${p.edpi}</b> eDPI</span>`);
      }
      if (p.sens) chips.insertAdjacentHTML("beforeend", `<span class="chip">sens ${esc(p.sens)}</span>`);
      if (p.res) chips.insertAdjacentHTML("beforeend", `<span class="chip">${esc(p.res)}</span>`);
      a.appendChild(chips);
      frag.appendChild(a);
    }
    grid.appendChild(frag);
  }

  input.addEventListener("input", () => { state.q = input.value; apply(); });
  sortSel.addEventListener("change", () => { state.sort = sortSel.value; apply(); });
  resSel.addEventListener("change", () => { state.res = resSel.value; apply(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      input.focus();
    }
  });

  apply();
}

/* ---------------- player page ---------------- */

function cmdBlock(text, hlFirst = false) {
  const div = document.createElement("div");
  div.className = "cmd";
  const pre = document.createElement("pre");
  const lines = String(text).split("\n");
  pre.innerHTML = lines
    .map((l, i) => (hlFirst && i === 0 ? `<span class="hl">${esc(l)}</span>` : esc(l)))
    .join("\n");
  div.appendChild(pre);
  return div;
}

async function runPlayer() {
  const main = $("#app");
  const slug = new URLSearchParams(location.search).get("p");

  main.innerHTML = `<div class="loading"><span class="spin"></span>Loading profile…</div>`;

  let rec, meta;
  try {
    [rec, meta] = await Promise.all([
      fetchJSON(`data/players/${encodeURIComponent(slug)}.json`),
      fetchJSON("data/meta.json"),
    ]);
  } catch (e) {
    main.innerHTML = `<div class="error-box">Player not found. <a href="index.html">Back to all players</a></div>`;
    return;
  }
  main.innerHTML = "";

  document.title = `${rec.nick} CS2 Settings & Config Commands - CS2 Pro Configs`;

  const buckets = bucketConvars(rec.convars);
  const resHeight = resHeightOf(rec);
  const xc = convertCrosshair(rec.convars || {}, resHeight);
  const fullBlock = buildFullBlock(rec, resHeight);
  const mouse = (rec.tables && rec.tables["Mouse"]) || {};
  const video = (rec.tables && rec.tables["Video Settings"]) || {};
  const adv = (rec.tables && rec.tables["Advanced Video"]) || {};

  /* header */
  const head = document.createElement("div");
  head.innerHTML = `
    <a class="back" href="index.html">← All players</a>
    <div class="profile-head">
      <div>
        <h1>${esc(rec.nick)}</h1>
        <div class="real">${esc(rec.real_name || "")}</div>
        <div class="links">
          ${rec.steamid64 ? `<a href="https://steamcommunity.com/profiles/${esc(rec.steamid64)}" target="_blank" rel="noopener">Steam profile</a>` : ""}
          <a href="https://settings.gg/players/${esc(rec.slug)}" target="_blank" rel="noopener">settings.gg</a>
          ${rec.crosshair_code ? `<a href="https://procrosshairs.com/player/${esc(rec.steamid64 || "")}/${esc(rec.slug)}" target="_blank" rel="noopener">crosshair history</a>` : ""}
        </div>
      </div>
    </div>
    <div class="chips" style="margin-top:14px">
      ${mouse["DPI"] ? `<span class="chip"><b>${esc(mouse["DPI"])}</b> DPI</span>` : ""}
      ${mouse["Polling rate"] ? `<span class="chip">${esc(mouse["Polling rate"])}</span>` : ""}
      ${video["Resolution"] ? `<span class="chip">${esc(video["Resolution"])}</span>` : ""}
      ${video["Aspect Ratio"] ? `<span class="chip">${esc(video["Aspect Ratio"])}</span>` : ""}
      ${video["Scaling Mode"] ? `<span class="chip">${esc(video["Scaling Mode"])}</span>` : ""}
    </div>
    <div class="head-actions">
      ${fullBlock ? `<button class="btn" data-copy="${esc(fullBlock)}">Copy full config</button>` : ""}
      <a class="btn ghost" href="cfg/${esc(rec.slug)}.cfg" download="${esc(rec.slug)}.cfg">Download .cfg</a>
    </div>
    <p class="note">Dataset refreshed ${new Date(meta.generated).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · source settings.gg</p>
  `;
  main.appendChild(head);
  const ph = $(".profile-head", head);
  ph.insertBefore(avatarEl(rec), ph.firstChild);

  /* crosshair */
  if (rec.crosshair_code || xc.commands.length) {
    const cv = rec.convars || {};
    const sec = document.createElement("section");
    sec.className = "section";
    sec.innerHTML = `<div class="section-head"><h2>Crosshair <span class="tag">new system</span></h2></div>`;
    const box = document.createElement("div");
    box.className = "xhair-box";
    const canvas = document.createElement("canvas");
    canvas.id = "xhair";
    canvas.width = 300; canvas.height = 300;
    box.appendChild(canvas);
    const metaBox = document.createElement("div");
    metaBox.className = "xhair-meta";
    metaBox.innerHTML = `
      <p class="note" style="margin:0 0 6px">CS2's Sept 22, 2026 "Rush Hour" patch replaced the crosshair system. Old share codes now fail to import (<i>"invalid or old crosshair code"</i>), so use the <b>console commands</b> below — converted to the new convars from this player's original settings.</p>`;
    const b2 = document.createElement("button");
    b2.className = "btn small";
    b2.dataset.copy = xc.commands.join("; ");
    b2.textContent = "Copy crosshair commands";
    metaBox.appendChild(b2);
    if (rec.crosshair_code) {
      const b = document.createElement("button");
      b.className = "btn ghost small";
      b.style.marginLeft = "8px";
      b.dataset.copy = rec.crosshair_code;
      b.textContent = "Copy legacy share code (no longer importable)";
      metaBox.appendChild(b);
      metaBox.insertAdjacentHTML("beforeend", `<div class="code-line" style="margin-top:8px">${esc(rec.crosshair_code)}</div>`);
    }
    if (xc.warnings.length) {
      metaBox.insertAdjacentHTML("beforeend",
        `<p class="note" style="margin-top:8px">${xc.warnings.map((w) => `⚠ ${esc(w)}`).join("<br>")}</p>`);
    }
    metaBox.insertAdjacentHTML("beforeend",
      `<p class="note" style="margin-top:8px">Conversion reference: <a href="https://github.com/sebastianspicker/small-indie-crosshair-company" target="_blank" rel="noopener">community crosshair migration study</a> (build 2000914) — validated against published post-patch pro settings.</p>`);
    box.appendChild(metaBox);
    sec.appendChild(box);
    const cmdWrap = document.createElement("div");
    cmdWrap.style.marginTop = "12px";
    cmdWrap.appendChild(cmdBlock(xc.commands.join("; ")));
    sec.appendChild(cmdWrap);
    main.appendChild(sec);
    drawCrosshair(canvas, cv);
  }

  /* full config */
  if (fullBlock) {
    const sec = document.createElement("section");
    sec.className = "section";
    sec.innerHTML = `<div class="section-head"><h2>Full config <span class="tag">paste in console</span></h2></div>`;
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.dataset.copy = fullBlock;
    btn.textContent = "Copy all";
    $(".section-head", sec).appendChild(btn);
    sec.appendChild(cmdBlock(fullBlock));
    sec.insertAdjacentHTML("beforeend", `<p class="note">One single line, <code>;</code>-separated so the console runs every command: press <b>~</b> in CS2, paste, hit Enter — done. (The CS2 console is single-line input, so multi-line pastes are unreliable — this is why everything is joined into one line.) The crosshair part is converted to the convars added by the Sept 22, 2026 patch; convars that were removed, renamed, cheat-protected or nonexistent in CS2 are filtered out. If a very long paste ever gets cut off, use the shorter per-section commands below instead.</p>`);
    main.appendChild(sec);
  }

  /* category blocks */
  const cols = document.createElement("div");
  cols.className = "cols";
  const order = ["mouse", "viewmodel", "hud", "radar", "misc"];
  for (const key of order) {
    const b = BUCKETS.find((x) => x.key === key);
    const lines = buckets[key];
    if (!lines || !lines.length) continue;
    const text = lines
      .filter(([k]) => !CONSOLE_SKIP.has(k) && !XHAIR_REMOVED.has(k) && !XHAIR_HIDDEN_LEGACY.has(k))
      .map(([k, v]) => `${k} ${v}`).join("; ");
    const sec = document.createElement("section");
    sec.className = "section";
    const headHtml = `<div class="section-head"><h2>${esc(b.title)} <span class="tag">${esc(b.tag || "")}</span></h2></div>`;
    sec.innerHTML = headHtml;
    const btn = document.createElement("button");
    btn.className = "btn ghost small";
    btn.dataset.copy = text;
    btn.textContent = "Copy";
    $(".section-head", sec).appendChild(btn);
    sec.appendChild(cmdBlock(text));
    if (key === "mouse") {
      const bits = [];
      if (mouse["DPI"]) bits.push(`DPI ${esc(mouse["DPI"])}`);
      if (mouse["DPI"] && rec.convars && rec.convars.sensitivity) {
        bits.push(`eDPI ${esc(String(Math.round(parseFloat(mouse["DPI"]) * parseFloat(rec.convars.sensitivity))))}`);
      }
      if (mouse["Polling rate"]) bits.push(`polling ${esc(mouse["Polling rate"])}`);
      if (bits.length) {
        sec.insertAdjacentHTML("beforeend", `<p class="note">DPI & polling rate are set in your <b>mouse software</b>, not in-game. Recommended: ${bits.join(" · ")}</p>`);
      }
    }
    if (key === "misc") {
      sec.insertAdjacentHTML("beforeend", `<p class="note">Misc convars (fps caps, gamma, gameplay toggles) captured from this player's config.</p>`);
    }
    cols.appendChild(sec);
  }

  /* launch options */
  const suggested = (() => {
    if (video["Resolution"] && (video["Display Mode"] || "").toLowerCase().includes("fullscreen")) {
      const [w, h] = video["Resolution"].split("x");
      if (w && h) return `-w ${w} -h ${h} -fullscreen`;
    }
    return null;
  })();
  if (rec.launch_options || suggested) {
    const sec = document.createElement("section");
    sec.className = "section";
    const text = rec.launch_options || suggested;
    const label = rec.launch_options ? "Launch Options" : "Launch Options (derived from resolution)";
    sec.innerHTML = `<div class="section-head"><h2>${esc(label)} <span class="tag">Steam</span></h2></div>`;
    const btn = document.createElement("button");
    btn.className = "btn ghost small";
    btn.dataset.copy = text;
    btn.textContent = "Copy";
    $(".section-head", sec).appendChild(btn);
    const pre = document.createElement("div");
    pre.className = "cmd";
    pre.innerHTML = `<pre>${esc(text)}</pre>`;
    sec.appendChild(pre);
    sec.insertAdjacentHTML("beforeend", `<p class="note">Steam → right-click Counter-Strike 2 → Properties → Launch Options → paste.${rec.launch_options ? "" : " This player didn't publish launch options; this line just forces their resolution + fullscreen."}</p>`);
    cols.appendChild(sec);
  }
  main.appendChild(cols);

  /* video settings (manual) */
  if (Object.keys(video).length || Object.keys(adv).length) {
    const sec = document.createElement("section");
    sec.className = "section";
    sec.innerHTML = `<div class="section-head"><h2>Video settings <span class="tag">manual</span></h2></div>`;
    const inner = document.createElement("div");
    inner.className = "cols";
    if (Object.keys(video).length) {
      inner.insertAdjacentHTML("beforeend", `
        <div>
          <table class="set"><tbody>
            ${Object.entries(video).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
          </tbody></table>
        </div>`);
    }
    if (Object.keys(adv).length) {
      inner.insertAdjacentHTML("beforeend", `
        <div>
          <table class="set"><tbody>
            ${Object.entries(adv).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
          </tbody></table>
        </div>`);
    }
    sec.appendChild(inner);
    sec.insertAdjacentHTML("beforeend", `<p class="note">CS2 doesn't allow these via console commands — set them in Settings → Video. For <b>stretched</b> scaling also configure your GPU driver panel (or use the resolution launch options above).</p>`);
    main.appendChild(sec);
  }

  /* raw config */
  const raw = document.createElement("section");
  raw.className = "section";
  raw.innerHTML = `
    <div class="section-head"><h2>Raw autoexec.cfg <span class="tag">file</span></h2>
      <button class="btn ghost small" data-copy-raw>Copy raw</button>
      <a class="btn ghost small" href="cfg/${esc(rec.slug)}.cfg" download="${esc(rec.slug)}.cfg">Download</a>
    </div>
    <details class="raw"><summary>Show raw config file</summary><div class="cmd" id="raw-cmd"><pre>…</pre></div></details>
    <p class="note">The exact autoexec.cfg file from the source site — in the <b>original pre-patch format</b> (some crosshair convars in it were removed by the Sept 22, 2026 update). For applying settings use the copy blocks above; this file is kept for reference. Alternative to pasting: save as <code>autoexec.cfg</code> in <code>…/Counter-Strike Global Offensive/game/csgo/cfg/</code> and run <code>exec autoexec</code> in console.</p>`;
  main.appendChild(raw);
  const rawCmd = $("#raw-cmd", raw);
  const rawBtn = $("[data-copy-raw]", raw);
  fetch(`cfg/${encodeURIComponent(rec.slug)}.cfg`)
    .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
    .then((t) => {
      rawCmd.querySelector("pre").textContent = t;
      rawBtn.dataset.copy = t;
    })
    .catch(() => {
      rawCmd.querySelector("pre").textContent = "raw config not available";
      rawBtn.remove();
    });

  wireCopyButtons(main);
}

/* ---------------- boot ---------------- */

const page = document.body.dataset.page;
if (page === "index") runIndex();
else if (page === "player") runPlayer();