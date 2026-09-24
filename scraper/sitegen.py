#!/usr/bin/env python3
"""
Static site generator for cs2-pro-configs.

Prerenders the whole site to plain HTML so search engines (and users
without JS) see full content:
  index.html          - hero, HLTV top 10, prerendered player grid
  p/<slug>/index.html - one static page per player (clean URLs)
  player.html         - redirect stub for legacy ?p= links
  sitemap.xml, robots.txt, 404.html

Run AFTER scrape.py / top10.py (reads data/*.json, cfg/*.cfg).
Canonical origin: https://copyprosta.com
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xhair_convert import convert_crosshair, convert_geometry  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://copyprosta.com"

CONSOLE_SKIP = {"cl_drawhud", "cl_radar_size", "setting.defaultres", "setting.defaultresheight"}
XHAIR_REMOVED = {
    "cl_crosshairgap", "cl_crosshairusealpha", "cl_crosshaircolor",
    "cl_crosshair_outlinethickness", "cl_crosshairgap_useweaponvalue",
    "cl_fixedcrosshairgap",
}
XHAIR_HIDDEN_LEGACY = {"cl_crosshairsize", "cl_crosshairthickness", "cl_crosshairalpha"}

BUCKETS = [
    ("crosshair", "Crosshair", "cl_crosshair_*", lambda n: n.startswith("cl_crosshair")),
    ("mouse", "Mouse & Sensitivity", "sensitivity",
     lambda n: n.startswith(("sensitivity", "zoom_sensitivity", "m_yaw", "m_pitch", "m_customaccel"))),
    ("viewmodel", "Viewmodel", "viewmodel_*", lambda n: n.startswith("viewmodel")),
    ("radar", "Radar", "cl_radar_*",
     lambda n: n.startswith("cl_radar_") or n == "cl_hud_radar_scale"),
    ("hud", "HUD", "hud_*",
     lambda n: n.startswith(("hud_", "safezone", "cl_hud_")) or n.startswith((
         "cl_drawhud", "cl_showfps", "cl_teammate_colors_show",
         "cl_show_clan_in_death_notice", "cl_allow_animated_avatars",
         "cl_teamcounter_playercount_instead_of_avatars"))),
    ("misc", "Performance & Other", "misc", None),
]

FAVICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E"
           "%3Crect width='100' height='100' rx='20' fill='%23ff8a3c'/%3E"
           "%3Ctext x='50' y='68' font-size='52' text-anchor='middle' font-family='monospace' "
           "font-weight='bold' fill='%231a0e02'%3ECS%3C/text%3E%3C/svg%3E")


def esc(s) -> str:
    return (str(s if s is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def safe_value(v):
    s = str(v).strip()
    if not s or any(c in s for c in ';"\n\r'):
        return None
    low = s.lower()
    if low == "true":
        return "1"
    if low == "false":
        return "0"
    return s


def bucket_convars(convars):
    out = {key: [] for key, *_ in BUCKETS}
    for k, v in (convars or {}).items():
        placed = False
        for key, _title, _tag, test in BUCKETS:
            if key == "misc":
                continue
            if test(k):
                out[key].append((k, v))
                placed = True
                break
        if not placed:
            out["misc"].append((k, v))
    return out


def full_commands(rec):
    """Console command list in paste order (crosshair first) — mirrors app.js."""
    cv = rec.get("convars") or {}
    xc_cmds, _ = convert_crosshair(cv)
    out = [f"{k} {v}" for k, v in xc_cmds]
    buckets = bucket_convars(cv)
    for key, _title, _tag, _t in BUCKETS:
        if key == "crosshair":
            continue
        for k, v in buckets[key]:
            if k in CONSOLE_SKIP or k in XHAIR_REMOVED or k in XHAIR_HIDDEN_LEGACY:
                continue
            sv = safe_value(v)
            if sv is not None:
                out.append(f"{k} {sv}")
    return out, xc_cmds


def letter_hue(nick: str) -> int:
    h = 0
    for ch in nick or "?":
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h % 360


def letter_div(nick: str) -> str:
    hue = letter_hue(nick)
    return (f'<div class="avatar-letter" role="img" aria-label="{esc(nick)}" '
            f'style="background:linear-gradient(135deg,hsl({hue} 45% 30%),hsl({(hue + 40) % 360} 45% 22%))">'
            f'{esc((nick or "?")[:1].upper())}</div>')


def category_sections_html(rec) -> str:
    buckets = bucket_convars(rec.get("convars"))
    mouse = (rec.get("tables") or {}).get("Mouse", {})
    parts = []
    for key, title, tag, _t in BUCKETS:
        if key == "crosshair":
            continue
        fixed = []
        for k, v in buckets[key]:
            if k in CONSOLE_SKIP or k in XHAIR_REMOVED or k in XHAIR_HIDDEN_LEGACY:
                continue
            sv = safe_value(v)
            if sv is not None:
                fixed.append((k, sv))
        if not fixed:
            continue
        text = "; ".join(f"{k} {v}" for k, v in fixed)
        parts.append(f'''<section class="section">
  <div class="section-head"><h2>{esc(title)} <span class="tag">{esc(tag)}</span></h2>
  <button type="button" class="btn ghost small" data-copy="{esc(text)}">Copy</button></div>
  <div class="cmd" tabindex="0" role="group" aria-label="Console commands, scrollable"><pre>{esc(text)}</pre></div>''')
        if key == "mouse":
            bits = []
            if mouse.get("DPI"):
                bits.append(f"DPI {esc(mouse['DPI'])}")
            sens = (rec.get("convars") or {}).get("sensitivity")
            if mouse.get("DPI") and sens:
                try:
                    bits.append(f"eDPI {int(float(mouse['DPI']) * float(sens))}")
                except ValueError:
                    pass
            if mouse.get("Polling rate"):
                bits.append(f"polling {esc(mouse['Polling rate'])}")
            if bits:
                parts[-1] += (f'\n  <p class="note">DPI &amp; polling rate are set in your <b>mouse software</b>, '
                              f'not in-game. Recommended: {" · ".join(bits)}</p>')
            parts[-1] += '\n  <div id="dpi-slot"></div>'
        if key == "misc":
            parts[-1] += ('\n  <p class="note">Misc convars (fps caps, gamma, gameplay toggles) '
                          "captured from this player's config.</p>")
        parts[-1] += "\n</section>"
    return "\n".join(parts)


def video_tables_html(rec):
    tables = rec.get("tables") or {}
    video = tables.get("Video Settings", {})
    adv = tables.get("Advanced Video", {})
    if not video and not adv:
        return ""
    def rows(d):
        return "".join(f'<tr><th scope="row">{esc(k)}</th><td>{esc(v)}</td></tr>' for k, v in d.items())
    inner = ""
    if video:
        inner += f'<div><table class="set"><caption class="sr-only">Video settings</caption><tbody>{rows(video)}</tbody></table></div>'
    if adv:
        inner += f'<div><table class="set"><tbody>{rows(adv)}</tbody></table></div>'
    return f'''<section class="section">
  <div class="section-head"><h2>Video settings <span class="tag">manual</span></h2></div>
  <div class="cols">{inner}</div>
  <p class="note">CS2 doesn't allow these via console commands — set them in Settings → Video. For <b>stretched</b> scaling also configure your GPU driver panel (or use the resolution launch options below).</p>
</section>'''


def xh_aria(cv) -> str:
    try:
        g = convert_geometry(float(cv.get("cl_crosshairsize", 0) or 0),
                             float(cv.get("cl_crosshairthickness", 0) or 0),
                             float(cv.get("cl_crosshairgap", 0) or 0))
        return f"{g['length']} pixel arms, {max(1, g['thickness'])} pixel thick, gap {g['gap']}"
    except Exception:
        return "crosshair preview"


def player_page(rec: dict, generated: str, top10_rank=None) -> str:
    slug = rec["slug"]
    nick = rec.get("nick") or slug
    real = rec.get("real_name") or ""
    cv = rec.get("convars") or {}
    mouse = (rec.get("tables") or {}).get("Mouse", {})
    video = (rec.get("tables") or {}).get("Video Settings", {})

    cmds, warnings = full_commands(rec)
    full_block = "; ".join(cmds)
    xc_cmds, _ = convert_crosshair(cv)
    xh_text = "; ".join(f"{k} {v}" for k, v in xc_cmds)

    dpi = mouse.get("DPI", "")
    sens = cv.get("sensitivity", "")
    try:
        edpi = int(float(dpi) * float(sens))
    except (TypeError, ValueError):
        edpi = None

    res = video.get("Resolution", "")
    desc = (f"Copy {nick}'s full CS2 config in one paste: converted crosshair"
            + (f", {dpi} DPI x {sens} sens ({edpi} eDPI)" if edpi else "")
            + (f", {res}" + (f" {video['Scaling Mode']}" if video.get("Scaling Mode") else "") if res else "")
            + ", viewmodel, HUD, radar and launch options - ready for the CS2 console.")

    avatar_url = f"{BASE}/data/avatars/{slug}.png" if rec.get("avatar") else f"{BASE}/assets/og-default.png"
    og_desc = (f"Copy {nick}'s full CS2 config in one paste: crosshair, sensitivity"
               + (f" ({edpi} eDPI)" if edpi else "") + ", viewmodel, HUD, radar.")

    embed = json.dumps({
        "slug": slug, "nick": nick, "dpi": dpi, "sens": sens,
        "convars": cv,
        "xhairCmds": [f"{k} {v}" for k, v in xc_cmds],
        "commands": cmds,
    }, ensure_ascii=False, separators=(",", ":"))

    raw_cfg = ""
    cfg_path = ROOT / "cfg" / f"{slug}.cfg"
    if cfg_path.exists():
        raw_cfg = cfg_path.read_text(encoding="utf-8", errors="replace")

    chips = []
    if top10_rank:
        chips.append(f'<span class="chip"><b>HLTV #{top10_rank}</b> top 20 of 2025</span>')
    if dpi:
        chips.append(f'<span class="chip"><b>{esc(dpi)}</b> DPI</span>')
    if mouse.get("Polling rate"):
        chips.append(f'<span class="chip">{esc(mouse["Polling rate"])}</span>')
    for k in ("Resolution", "Aspect Ratio", "Scaling Mode"):
        if video.get(k):
            chips.append(f'<span class="chip">{esc(video[k])}</span>')

    links = []
    if rec.get("steamid64"):
        links.append(f'<a href="https://steamcommunity.com/profiles/{esc(rec["steamid64"])}" target="_blank" rel="noopener">Steam profile</a>')
    links.append(f'<a href="https://settings.gg/players/{esc(slug)}" target="_blank" rel="noopener">settings.gg</a>')
    if rec.get("crosshair_code"):
        links.append(f'<a href="https://procrosshairs.com/player/{esc(rec.get("steamid64") or "")}/{esc(slug)}" target="_blank" rel="noopener">crosshair history</a>')

    avatar_html = (f'<img class="avatar" src="/data/avatars/{esc(slug)}.png" alt="" width="92" height="92">'
                   if rec.get("avatar") else
                   f'<div class="avatar-letter" role="img" aria-label="{esc(nick)}">{esc(nick[:1].upper())}</div>')

    share_code_html = ""
    if rec.get("crosshair_code"):
        share_code_html = (f'<button type="button" class="btn ghost small" style="margin-left:8px" '
                           f'data-copy="{esc(rec["crosshair_code"])}">Copy legacy share code (no longer importable)</button>'
                           f'<div class="code-line" style="margin-top:8px">{esc(rec["crosshair_code"])}</div>')

    warnings_html = ""
    if warnings:
        warnings_html = '<p class="note" style="margin-top:8px">' + "<br>".join("⚠ " + esc(w) for w in warnings) + "</p>"

    launch = rec.get("launch_options")
    launch_html = ""
    if launch:
        launch_html = f'''<section class="section">
  <div class="section-head"><h2>Launch Options <span class="tag">Steam</span></h2>
  <button type="button" class="btn ghost small" data-copy="{esc(launch)}">Copy</button></div>
  <div class="cmd" tabindex="0" role="group" aria-label="Console commands, scrollable"><pre>{esc(launch)}</pre></div>
  <p class="note">Steam → right-click Counter-Strike 2 → Properties → Launch Options → paste.</p>
</section>'''

    try:
        g = convert_geometry(float(cv.get("cl_crosshairsize", 0) or 0),
                             float(cv.get("cl_crosshairthickness", 0) or 0),
                             float(cv.get("cl_crosshairgap", 0) or 0))
        aria = f"{g['length']} pixel arms, {max(1, g['thickness'])} pixel thick, gap {g['gap']}"
    except Exception:
        aria = "crosshair preview"

    person = {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        "mainEntity": {
            "@type": "Person",
            "name": nick,
            "alternateName": real or None,
            "jobTitle": "CS2 professional player",
            "identifier": rec.get("steamid64") or None,
            "url": f"{BASE}/p/{slug}/",
        },
    }

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{esc(nick)} CS2 Settings, Crosshair &amp; Sensitivity — Copy-Paste Config</title>
  <meta name="description" content="{esc(desc)}">
  <link rel="canonical" href="{BASE}/p/{esc(slug)}/">
  <meta name="theme-color" content="#0d1014">
  <meta property="og:site_name" content="CS2 Pro Configs">
  <meta property="og:title" content="{esc(nick)} — CS2 Settings &amp; Config Commands">
  <meta property="og:description" content="{esc(og_desc := (f"Copy {nick}'s full CS2 config in one paste: crosshair, sensitivity" + (f" ({edpi} eDPI)" if edpi else "") + ", viewmodel, HUD, radar."))}">
  <meta property="og:type" content="profile">
  <meta property="og:url" content="{BASE}/p/{esc(slug)}/">
  <meta property="og:image" content="{avatar_url}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="{esc(nick)} — CS2 Settings &amp; Config Commands">
  <meta name="twitter:description" content="{esc(og_desc)}">
  <meta name="twitter:image" content="{avatar_url}">
  <link rel="icon" href="{FAVICON}">
  <link rel="stylesheet" href="/assets/style.css">
  <script type="application/ld+json">
  {json.dumps(person, ensure_ascii=False)}
  </script>
</head>
<body data-page="player-static">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="logo" href="/">CS2<span class="dot">//</span>PROS <small>configs</small></a>
      <div class="spacer"></div>
      <a class="btn ghost small" href="/">All players</a>
    </div>
  </header>

  <main class="wrap" id="main">
    <nav aria-label="Breadcrumb"><a class="back" href="/">← All players</a></nav>
    <div class="profile-head">
      {avatar_html}
      <div>
        <h1>{esc(nick)}</h1>
        <div class="real">{esc(real)}</div>
        <div class="links">{''.join(links)}</div>
      </div>
    </div>
    <div class="chips" style="margin-top:14px">{''.join(chips)}</div>
    <div class="head-actions">
      <button type="button" class="btn" data-copy="{esc(full_block)}">Copy full config</button>
      <a class="btn ghost" href="/cfg/{esc(slug)}.cfg" download="{esc(slug)}.cfg">Download .cfg</a>
    </div>
    <p class="note">Dataset refreshed {esc(generated)} · source <a href="https://settings.gg/players/{esc(slug)}" target="_blank" rel="noopener">settings.gg</a></p>

    <section class="section">
      <div class="section-head"><h2>Crosshair <span class="tag">new system</span></h2></div>
      <div class="xhair-box">
        <div class="xhair-canvases">
          <canvas id="xhair" width="300" height="300" role="img" aria-label="Crosshair preview: {esc(aria)}"></canvas>
          <div class="xhair-label">true scale on your screen</div>
          <canvas id="xhair-zoom" width="300" height="300" role="img" aria-label="Zoomed crosshair shape"></canvas>
          <div class="xhair-label">pixel zoom</div>
        </div>
        <div class="xhair-meta">
          <p class="note" style="margin:0 0 6px">CS2's Sept 22, 2026 "Rush Hour" patch replaced the crosshair system. Old share codes no longer import, so use the <b>console commands</b> below — converted to the new convars from {esc(nick)}'s original settings.</p>
          <button type="button" class="btn small" data-copy="{esc(xh_text)}">Copy crosshair commands</button>{share_code_html}
          {warnings_html}
          <p class="note" style="margin-top:8px">Conversion reference: <a href="https://github.com/sebastianspicker/small-indie-crosshair-company" target="_blank" rel="noopener">community crosshair migration study</a> (build 2000914). The converted crosshair commands are included at the start of the <b>Full config</b> below.</p>
          <noscript><div class="cmd" style="margin-top:8px"><pre>{esc(xh_text)}</pre></div></noscript>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Full config <span class="tag">paste in console</span></h2>
        <button type="button" class="btn small" data-copy="{esc(full_block)}">Copy all</button>
        <span id="btn-mydpi-slot"></span></div>
      <div class="cmd" tabindex="0" role="group" aria-label="Console commands, scrollable"><pre>{esc(full_block)}</pre></div>
      <p class="note">One single line, <code>;</code>-separated so the console runs every command: press <b>~</b> in CS2, paste, hit Enter — done. (The CS2 console is single-line input, so multi-line pastes are unreliable.) The crosshair part is converted to the convars added by the Sept 22, 2026 patch; convars that were removed, renamed, cheat-protected or nonexistent in CS2 are filtered out. If a very long paste ever gets cut off, use the shorter per-section commands below instead.</p>
      <noscript><div class="cmd" tabindex="0" role="group" aria-label="Console commands, scrollable"><pre>{esc(full_block)}</pre></div></noscript>
    </section>

    {category_sections_html(rec)}
    {launch_html}
    {video_tables_html(rec)}

    <section class="section">
      <div class="section-head"><h2>Raw autoexec.cfg <span class="tag">file</span></h2>
        <button type="button" class="btn ghost small" data-copy="{esc(raw_cfg)}">Copy raw</button>
        <a class="btn ghost small" href="/cfg/{esc(slug)}.cfg" download="{esc(slug)}.cfg">Download</a>
      </div>
      <details class="raw"><summary>Show raw config file</summary><div class="cmd" tabindex="0" role="group" aria-label="Console commands, scrollable"><pre>{esc(raw_cfg)}</pre></div></details>
      <p class="note">The exact autoexec.cfg from the source site — in the <b>original pre-patch format</b> (some crosshair convars in it were removed by the Sept 22, 2026 update). For applying settings use the copy blocks above.</p>
    </section>
  </main>

  <footer>
    <div class="wrap">
      <p>Settings data from <a href="https://settings.gg/players" target="_blank" rel="noopener">settings.gg</a> · Unofficial fan-made tool, not affiliated with Valve or settings.gg. CS2 and Counter-Strike are trademarks of Valve.</p>
    </div>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script type="application/json" id="player-data">{embed}</script>
  <script src="/assets/app.js"></script>
</body>
</html>
'''


def index_page(players, top10_data, generated) -> str:
    count = len(players)
    t10 = ""
    if top10_data:
        cards = []
        for t in top10_data["players"]:
            slug = t.get("slug") or ""
            has = (ROOT / "data" / "players" / f"{slug}.json").exists()
            href = f"/p/{esc(slug)}/" if slug and has else (t.get("hltv") or "#")
            med = " medal" if t["rank"] <= 3 else ""
            avatar = (f'<img class="avatar" src="/data/avatars/{esc(slug)}.png" alt="" width="72" height="72" loading="lazy">'
                      if has and (ROOT / "data" / "avatars" / f"{slug}.png").exists()
                      else letter_div(t["nick"]))
            cards.append(f'''<li class="top10-card" data-rank="{t["rank"]}"><a href="{href}" title="{esc(t["nick"])} — open config">
  <span class="top10-rank{med}">#{t["rank"]}</span>
  {avatar}
  <span class="top10-nick">{esc(t["nick"])}</span>
  <span class="top10-team">{esc(t.get("team") or "")}</span>
</a></li>''')
        t10 = f'''<section class="top10" aria-labelledby="top10-title">
  <div class="top10-head">
    <h2 id="top10-title">{esc(top10_data["title"])}</h2>
    <span class="top10-list">{esc(top10_data["listName"])} · as of {esc(top10_data["asOf"])}</span>
    <a class="top10-src" href="{esc(top10_data["sourceUrl"])}" target="_blank" rel="noopener">source: HLTV ↗</a>
  </div>
  <ol class="top10-grid">{''.join(cards)}</ol>
  <p class="top10-note">{esc(top10_data["note"])}</p>
</section>'''

    cards = []
    for p in players:
        slug = p["slug"]
        nick = p.get("nick") or slug
        real = p.get("real_name") or ""
        avatar = (f'<img class="avatar" src="/data/avatars/{esc(slug)}.png" alt="" width="72" height="72" loading="lazy">'
                  if p.get("avatar") else letter_div(nick))
        chips = []
        if p.get("edpi") is not None:
            chips.append(f'<span class="chip"><b>{p["edpi"]}</b> eDPI</span>')
        if p.get("sens"):
            chips.append(f'<span class="chip">sens {esc(p["sens"])}</span>')
        if p.get("res"):
            chips.append(f'<span class="chip">{esc(p["res"])}</span>')
        cards.append(f'''<a class="card" href="/p/{esc(slug)}/" data-nick="{esc(nick.lower())}" data-real="{esc(real.lower())}" data-slug="{esc(slug)}" data-edpi="{p.get("edpi") if p.get("edpi") is not None else ""}" data-sens="{p.get("sens") or ""}" data-res="{esc(p.get("res") or "")}">
  {avatar}
  <div class="nick">{esc(nick)}</div>
  <div class="real">{esc(real)}</div>
  <div class="chips">{''.join(chips)}</div>
</a>''')

    res_opts = "".join(f'<option value="{esc(r)}">{esc(r)}</option>'
                       for r in sorted({p["res"] for p in players if p.get("res")},
                                       key=lambda r: int(r.split("x")[0]) if r.split("x")[0].isdigit() else 0))

    ld = {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": "CS2 Pro Configs",
        "alternateName": "copyprosta.com",
        "url": BASE + "/",
        "potentialAction": {
            "@type": "SearchAction",
            "target": {"@type": "EntryPoint", "urlTemplate": BASE + "/?q={search_term_string}"},
            "query-input": "required name=search_term_string",
        },
    }

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CS2 Pro Configs — {count} Pro Player Settings as Copy-Paste Console Commands</title>
  <meta name="description" content="Browse {count} CS2 pro players' full settings and copy ready-to-paste console commands: crosshair, sensitivity, viewmodel, HUD, radar and full configs. Works with any mouse DPI.">
  <link rel="canonical" href="{BASE}/">
  <meta name="theme-color" content="#0d1014">
  <meta property="og:site_name" content="CS2 Pro Configs">
  <meta property="og:title" content="CS2 Pro Configs — Pro Player Settings as Console Commands">
  <meta property="og:description" content="Full CS2 settings from {count} pro players converted into ready-to-paste console commands. Pick a player, copy, paste into your console.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="{BASE}/">
  <meta property="og:image" content="{BASE}/assets/og-default.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="CS2 Pro Configs — Pro Player Settings as Console Commands">
  <meta name="twitter:description" content="Copy any pro's full CS2 config in one paste: crosshair, sensitivity, viewmodel, HUD, radar.">
  <meta name="twitter:image" content="{BASE}/assets/og-default.png">
  <link rel="icon" href="{FAVICON}">
  <link rel="stylesheet" href="/assets/style.css">
  <script type="application/ld+json">{json.dumps(ld)}</script>
</head>
<body data-page="index">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="logo" href="/">CS2<span class="dot">//</span>PROS <small>configs</small></a>
      <div class="spacer"></div>
      <label class="search">
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="Search {count} players… (press / )" autocomplete="off" aria-label="Search players by nickname or real name">
        <kbd aria-hidden="true">/</kbd>
      </label>
    </div>
  </header>

  <main class="wrap" id="main">
    <div class="hero">
      <h1>Play like a pro<span class="dot">.</span> One paste.</h1>
      <p>Full CS2 settings from {count} of the world's best players, converted into ready-to-paste console commands.
         Pick a player, hit copy, paste into your console — crosshair, sensitivity, viewmodel, HUD and radar apply instantly.</p>
      <div class="steps">
        <div class="step"><b><span class="num">1</span>Pick a pro</b>Search by nickname and open their profile.</div>
        <div class="step"><b><span class="num">2</span>Copy the config</b>Grab the full config or just a section like crosshair.</div>
        <div class="step"><b><span class="num">3</span>Paste in CS2 console</b>Press <b>~</b> in CS2, paste, Enter. Done — settings applied.</div>
      </div>
    </div>

    {top10_section_html(top10_data)}

    <div class="controls">
      <label for="sort">Sort</label>
      <select id="sort">
        <option value="recent">Recently updated</option>
        <option value="edpi-desc">eDPI high → low</option>
        <option value="edpi-asc">eDPI low → high</option>
        <option value="sens-desc">Sens high → low</option>
        <option value="sens-asc">Sens low → high</option>
        <option value="name">Name A → Z</option>
      </select>
      <label for="res">Resolution</label>
      <select id="res"><option value="">Any</option>{''.join(f'<option value="{esc(r)}">{esc(r)}</option>' for r in sorted({p["res"] for p in players if p.get("res")}, key=lambda r: int(r.split("x")[0]) if r.split("x")[0].isdigit() else 0))}</select>
      <span class="result-count" id="result-count" aria-live="polite"></span>
    </div>

    <h2 class="sr-only">All players</h2>
    <div class="grid" id="grid">{''.join(cards)}</div>
  </main>

  <footer>
    <div class="wrap">
      <p>Data refreshed {esc(generated)} · Data source: <a href="https://settings.gg/players" target="_blank" rel="noopener">settings.gg</a> (community-generated pro configs).</p>
      <p>Unofficial fan-made tool. Not affiliated with settings.gg, Valve or any player. CS2, Counter-Strike and all related marks belong to Valve.</p>
    </div>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script src="/assets/app.js"></script>
</body>
</html>
'''


def top10_section_html(top10_data) -> str:
    if not top10_data:
        return ""
    cards = []
    for t in top10_data["players"]:
        slug = t.get("slug") or ""
        has_player = (ROOT / "data" / "players" / f"{slug}.json").exists()
        has_avatar = has_player and (ROOT / "data" / "avatars" / f"{slug}.png").exists()
        href = f"/p/{esc(slug)}/" if has_player else (t.get("hltv") or "#")
        med = " medal" if t["rank"] <= 3 else ""
        avatar = (f'<img class="avatar" src="/data/avatars/{esc(slug)}.png" alt="" width="72" height="72" loading="lazy">'
                  if has_avatar else letter_div(t["nick"]))
        cards.append(f'<li class="top10-card" data-rank="{t["rank"]}"><a href="{href}" title="{esc(t["nick"])} — open config">'
                     f'<span class="top10-rank{med}">#{t["rank"]}</span>{avatar}'
                     f'<span class="top10-nick">{esc(t["nick"])}</span>'
                     f'<span class="top10-team">{esc(t.get("team") or "")}</span></a></li>')
    return f'''<section class="top10" aria-labelledby="top10-title">
  <div class="top10-head">
    <h2 id="top10-title">{esc(top10_data["title"])}</h2>
    <span class="top10-list">{esc(top10_data["listName"])} · as of {esc(top10_data["asOf"])}</span>
    <a class="top10-src" href="{esc(top10_data["sourceUrl"])}" target="_blank" rel="noopener">source: HLTV ↗</a>
  </div>
  <ol class="top10-grid">{''.join(cards)}</ol>
  <p class="top10-note">{esc(top10_data["note"])}</p>
</section>'''


def not_found_page() -> str:
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page not found — CS2 Pro Configs</title>
  <meta name="robots" content="noindex">
  <link rel="icon" href="{FAVICON}">
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body data-page="plain">
  <main class="wrap" style="min-height:70vh;display:flex;align-items:center;justify-content:center">
    <div class="error-box">
      <h1 style="margin-top:0">404 — page not found</h1>
      <p>That player page doesn't exist.</p>
      <p><a class="btn" href="/">Browse all pro configs</a></p>
    </div>
  </main>
</body>
</html>
'''


def redirect_stub() -> str:
    return '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Redirecting… — CS2 Pro Configs</title>
  <meta http-equiv="refresh" content="0;url=/">
  <link rel="canonical" href="/">
</head>
<body>
  <p>This page moved to a cleaner address. <a href="/">Go to all pro configs</a>.</p>
  <script>
    var p = new URLSearchParams(location.search).get("p");
    location.replace(p ? "/p/" + encodeURIComponent(p) + "/" : "/");
  </script>
</body>
</html>
'''


def sitemap_xml(players, lastmod: str) -> str:
    urls = [f"<url><loc>{BASE}/</loc><lastmod>{lastmod}</lastmod><priority>1.0</priority></url>"]
    for p in players:
        urls.append(f"<url><loc>{BASE}/p/{esc(p['slug'])}/</loc><lastmod>{lastmod}</lastmod><priority>0.8</priority></url>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "\n".join(urls) + "\n</urlset>\n")


def robots_txt() -> str:
    return f"User-agent: *\nAllow: /\n\nSitemap: {BASE}/sitemap.xml\n"


def main() -> None:
    index = json.loads((ROOT / "data" / "index.json").read_text())
    players = index["players"]
    generated = index["meta"]["generated"]
    lastmod = generated[:10]

    try:
        top10_data = json.loads((ROOT / "data" / "top10.json").read_text())
    except Exception:
        top10_data = None
    top10_rank = {}
    if top10_data:
        top10_rank = {t["slug"]: t["rank"] for t in top10_data.get("players", []) if t.get("slug")}

    # index
    (ROOT / "index.html").write_text(index_page(players, top10_data, generated), encoding="utf-8")
    print("index.html")

    # player pages
    n = 0
    for p in players:
        slug = p["slug"]
        f = ROOT / "data" / "players" / f"{slug}.json"
        if not f.exists():
            continue
        rec = json.loads(f.read_text())
        rec["_generated"] = generated
        d = ROOT / "p" / slug
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(player_page(rec, generated, top10_rank.get(slug)), encoding="utf-8")
        n += 1
    print(f"p/ pages: {n}")

    (ROOT / "player.html").write_text(redirect_stub(), encoding="utf-8")
    (ROOT / "404.html").write_text(not_found_page(), encoding="utf-8")
    (ROOT / "sitemap.xml").write_text(sitemap_xml(players, lastmod), encoding="utf-8")
    (ROOT / "robots.txt").write_text(robots_txt(), encoding="utf-8")
    print("sitemap.xml robots.txt 404.html player.html")


if __name__ == "__main__":
    main()