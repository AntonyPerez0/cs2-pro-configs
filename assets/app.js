/* cs2-pro-configs - progressive enhancement for the prerendered pages:
   copy buttons, index search/sort/filter, and the player-page DPI matcher.
   All console commands are built at build time by scraper/sitegen.py. */

"use strict";

const $ = (sel, el = document) => el.querySelector(sel);

/* localStorage throws (not just returns null) when site data is blocked */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* not persisted */ } },
};

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
   sensitivity line). Reads data-copy at click time, so late-set values work. */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn || !btn.dataset.copy) return;
  const ok = await copyText(btn.dataset.copy);
  if (ok) {
    // remember the real label once, so a second click inside the 1.2s
    // window can't capture "Copied!" as the label to restore
    if (!btn.classList.contains("copied")) btn._label = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.textContent = btn._label;
      btn.classList.remove("copied");
    }, 1200);
  }
});

/* ---------------- sensitivity converter (eDPI match) ---------------- */

const DPI_KEY = "cs2pros:your-dpi";

function getUserDpi() {
  const v = parseInt(store.get(DPI_KEY) || "", 10);
  return Number.isFinite(v) && v >= 50 ? v : null;
}

/* cm per 360° for an eDPI in CS2: 2.54*360 / (0.022 * eDPI) = 41563.6 / eDPI */
function cmPer360(edpi) {
  return 41563.6 / edpi;
}

/* the pro's effective sensitivity (or null if their page lacks DPI/sens) */
function proEdpi(dpi, sens) {
  const dpiPro = parseInt(String(dpi || "").replace(/[^\d]/g, ""), 10);
  const sensPro = parseFloat(sens);
  if (!Number.isFinite(dpiPro) || dpiPro <= 0 || !Number.isFinite(sensPro) || sensPro <= 0) return null;
  const edpi = dpiPro * sensPro;
  return { edpi, cm: cmPer360(edpi) };
}

function sensForDpi(base, yourDpi) {
  if (!base || !Number.isFinite(yourDpi) || yourDpi < 50) return null;
  return parseFloat((base.edpi / yourDpi).toFixed(4));
}

/* ---------------- index page: DOM filter over prerendered cards ---------------- */

function runIndex() {
  const grid = $("#grid");
  const count = $("#result-count");
  const input = $("#q");
  const sortSel = $("#sort");
  const resSel = $("#res");
  if (!grid || !grid.querySelector(".card")) return;

  const cards = [...grid.querySelectorAll(".card")];  // prerendered = recently updated order
  const state = { q: "", sort: "recent", res: "" };

  let empty = grid.querySelector(".empty");
  if (!empty) {
    empty = document.createElement("div");
    empty.className = "empty";
    grid.appendChild(empty);
  }

  const num = (c, k) => parseFloat(c.dataset[k]) || 0;
  const SORTS = {
    "recent": null,
    "edpi-desc": (a, b) => num(b, "edpi") - num(a, "edpi"),
    "edpi-asc": (a, b) => num(a, "edpi") - num(b, "edpi"),
    "sens-desc": (a, b) => num(b, "sens") - num(a, "sens"),
    "sens-asc": (a, b) => num(a, "sens") - num(b, "sens"),
    "name": (a, b) => (a.dataset.nick || "").localeCompare(b.dataset.nick || ""),
  };

  function apply() {
    const q = state.q.trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const hay = (card.dataset.nick || "") + " " + (card.dataset.real || "") + " " + (card.dataset.slug || "");
      const show = (!q || hay.includes(q)) && (!state.res || card.dataset.res === state.res);
      card.hidden = !show;
      if (show) visible++;
    }
    // always re-append from the original order, so going back to "recent"
    // undoes an earlier sort
    const cmp = SORTS[state.sort];
    (cmp ? [...cards].sort(cmp) : cards).forEach((c) => grid.appendChild(c));
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

  // restore from URL (?q= is the SearchAction sitelink target); ignore
  // values the selects don't offer
  const params = new URLSearchParams(location.search);
  if (params.get("q")) { state.q = params.get("q"); input.value = state.q; }
  const res = params.get("res");
  if (res && [...resSel.options].some((o) => o.value === res)) { state.res = res; resSel.value = res; }
  const sort = params.get("sort");
  if (sort && sort in SORTS) { state.sort = sort; sortSel.value = sort; }
  apply();
}

/* ---------------- static player pages: enhancement only ----------------
   Content is prerendered; this wires the DPI sensitivity matcher and the
   "Copy all at my DPI" button from the embedded #player-data JSON. */

function runPlayerStatic() {
  let data;
  try {
    data = JSON.parse(document.getElementById("player-data").textContent);
  } catch (_) {
    return;
  }
  const base = proEdpi(data.dpi, data.sens);
  if (!base) return;

  /* "Copy all at my DPI" button -> #btn-mydpi-slot */
  const mySlot = $("#btn-mydpi-slot");
  let refreshAdjusted = () => {};
  if (mySlot && Array.isArray(data.commands)) {
    const btnMy = document.createElement("button");
    btnMy.type = "button";
    btnMy.className = "btn ghost small";
    btnMy.hidden = true;
    btnMy.title = "Same config, but the sensitivity line is rewritten so the speed (eDPI) matches this pro on YOUR mouse DPI";
    mySlot.appendChild(btnMy);
    refreshAdjusted = () => {
      const dpi = getUserDpi();
      const sens = sensForDpi(base, dpi);
      if (sens !== null) {
        btnMy.dataset.copy = data.commands
          .map((c) => (c.startsWith("sensitivity ") ? `sensitivity ${sens}` : c))
          .join("; ");
        btnMy.textContent = `Copy all at my DPI (${dpi})`;
        btnMy.hidden = false;
      } else {
        btnMy.hidden = true;
      }
    };
    refreshAdjusted();
  }

  /* DPI matcher widget -> #dpi-slot */
  const dpiSlot = $("#dpi-slot");
  if (!dpiSlot) return;
  const box = document.createElement("div");
  box.className = "dpi-match";
  box.innerHTML = `
    <div class="dpi-line">
      <label class="dpi-label">Your mouse DPI
        <input type="number" min="50" step="50" inputmode="numeric" class="dpi-input" placeholder="e.g. 1600">
      </label>
      <span class="dpi-result" aria-live="polite"></span>
      <button type="button" class="btn ghost small" hidden></button>
    </div>
    <p class="note">Matching keeps the same <b>eDPI</b> (${Math.round(base.edpi)}) — that's <b>${base.cm.toFixed(1)} cm</b> per 360° turn at any DPI. Enter your DPI and use this sensitivity instead of theirs (or use <b>Copy all at my DPI</b> in the Full config above, which rewrites the <code>sensitivity</code> line for you).</p>`;
  dpiSlot.replaceWith(box);
  const input = $(".dpi-input", box);
  const result = $(".dpi-result", box);
  const btnSens = $("button", box);
  const saved = getUserDpi();
  if (saved) input.value = saved;
  const update = () => {
    const dpi = parseInt(input.value, 10);
    const sens = sensForDpi(base, dpi);
    if (sens !== null) {
      store.set(DPI_KEY, String(dpi));
      result.innerHTML = `→ in-game <b>sensitivity ${sens}</b>`;
      btnSens.dataset.copy = `sensitivity ${sens}`;
      btnSens.textContent = `Copy sensitivity ${sens}`;
      btnSens.hidden = false;
    } else {
      result.textContent = "";
      btnSens.hidden = true;
    }
    refreshAdjusted();
  };
  input.addEventListener("input", update);
  if (saved) update();
}

/* ---------------- boot ---------------- */

const page = document.body.dataset.page;
if (page === "index") runIndex();
else if (page === "player-static") runPlayerStatic();
