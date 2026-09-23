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

function buildFullBlock(rec) {
  const lines = [];
  if (rec.crosshair_code) lines.push(`apply_crosshair_code ${rec.crosshair_code}`);
  for (const [k, v] of Object.entries(rec.convars || {})) lines.push(`${k} ${v}`);
  return lines.join("\n");
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
  const fullBlock = buildFullBlock(rec);
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
  if (rec.crosshair_code || buckets.crosshair) {
    const cv = rec.convars || {};
    const sec = document.createElement("section");
    sec.className = "section";
    sec.innerHTML = `<div class="section-head"><h2>Crosshair <span class="tag">1 command</span></h2></div>`;
    const box = document.createElement("div");
    box.className = "xhair-box";
    const canvas = document.createElement("canvas");
    canvas.id = "xhair";
    canvas.width = 300; canvas.height = 300;
    box.appendChild(canvas);
    const metaBox = document.createElement("div");
    metaBox.className = "xhair-meta";
    if (rec.crosshair_code) {
      metaBox.innerHTML = `
        <p class="note" style="margin:2px 0 6px">One command applies the exact crosshair (share code):</p>
        <div class="code-line">${esc(rec.crosshair_code)}</div>`;
      const b = document.createElement("button");
      b.className = "btn small";
      b.dataset.copy = `apply_crosshair_code ${rec.crosshair_code}`;
      b.textContent = "Copy crosshair command";
      metaBox.appendChild(b);
      if (buckets.crosshair) {
        const b2 = document.createElement("button");
        b2.className = "btn ghost small";
        b2.style.marginLeft = "8px";
        b2.dataset.copy = buckets.crosshair.map(([k, v]) => `${k} ${v}`).join("\n");
        b2.textContent = "Copy raw convars instead";
        metaBox.appendChild(b2);
      }
    }
    box.appendChild(metaBox);
    sec.appendChild(box);
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
    sec.appendChild(cmdBlock(fullBlock, true));
    sec.insertAdjacentHTML("beforeend", `<p class="note">Press <b>~</b> (or <b>\\</b>) in CS2 to open the console, paste everything, hit Enter. Every setting applies instantly.</p>`);
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
    const text = lines.map(([k, v]) => `${k} ${v}`).join("\n");
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
    <p class="note">The exact autoexec.cfg file. Alternative to pasting: save as <code>autoexec.cfg</code> in <code>…/Counter-Strike Global Offensive/game/csgo/cfg/</code> and run <code>exec autoexec</code> in console.</p>`;
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