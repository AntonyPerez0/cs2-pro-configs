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
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xhair_convert import convert_crosshair, convert_geometry, safe_value  # noqa: E402

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


def json_script(obj) -> str:
    # </script> inside a JSON string would break out of the script tag
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def esc(s) -> str:
    return (str(s if s is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


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
    """Console command list in paste order: converted crosshair first, so the
    most important part lands even if a very long paste gets truncated.
    Returns (commands, warnings) with warnings as readable strings."""
    cv = rec.get("convars") or {}
    xc_cmds, warnings = convert_crosshair(cv)
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
    return out, warnings


def letter_hue(nick: str) -> int:
    h = 0
    for ch in nick or "?":
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h % 360


def cmd_pre(cmds) -> str:
    """<pre> of a "; "-joined command line, one inline-block span per command
    so wrapping falls between commands, never inside one. The text content
    is still the exact single line."""
    cmds = list(cmds)
    spans = [f"<span>{esc(c)}{';' if i < len(cmds) - 1 else ''}</span>" for i, c in enumerate(cmds)]
    return "<pre>" + " ".join(spans) + "</pre>"


def res_key(r: str):
    """Sort key for "1280x960"-style labels: width, then height."""
    w, _, h = r.partition("x")
    return (int(w) if w.isdigit() else 0, int(h) if h.isdigit() else 0)


def avatar_img(path: str, size: int, lazy: bool = False) -> str:
    return (f'<img class="avatar" src="/{esc(path)}" alt="" width="{size}" height="{size}"'
            + (' loading="lazy"' if lazy else "") + ">")


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
        line = [f"{k} {v}" for k, v in fixed]
        text = "; ".join(line)
        parts.append(f'''<section class="section">
  <div class="section-head"><h2>{esc(title)} <span class="tag">{esc(tag)}</span></h2>
  <button type="button" class="btn ghost small" data-copy="{esc(text)}">Copy</button></div>
  <div class="cmd" tabindex="0" role="group" aria-label="Console commands, scrollable">{cmd_pre(line)}</div>''')
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
        inner += f'<div><table class="set"><caption class="sr-only">Advanced video</caption><tbody>{rows(adv)}</tbody></table></div>'
    return f'''<section class="section">
  <div class="section-head"><h2>Video settings <span class="tag">manual</span></h2></div>
  <div class="cols">{inner}</div>
  <p class="note">CS2 doesn't allow these via console commands — set them in Settings → Video. For <b>stretched</b> scaling also configure your GPU driver panel (or use the resolution launch options below).</p>
</section>'''


def xhair_svg(cv, aria: str):
    """Prerendered inline-SVG crosshair, 1 game px = 1 CSS px unless it has
    to be resized to fit the 64-160px box. Ships in the HTML itself, so it
    renders without JavaScript and can't come out blank the way a JS-drawn
    canvas could. Returns (svg, label)."""
    cmds, _ = convert_crosshair(cv)
    d = {k: v for k, v in cmds}
    iv = lambda k, dflt: int(float(d.get(k, dflt)))
    length = max(0, iv("cl_crosshair_length", 8))
    th = max(1, iv("cl_crosshair_thickness", 2))
    gap = max(0, iv("cl_crosshair_gap", 4))
    on = lambda k: str(d.get(k, 0)).strip().lower() in ("1", "true")
    dot = on("cl_crosshairdot")
    t_shape = on("cl_crosshair_t")
    outline = on("cl_crosshair_drawoutline")
    r = iv("cl_crosshaircolor_r", 255)
    g = iv("cl_crosshaircolor_g", 255)
    b = iv("cl_crosshaircolor_b", 255)
    a = max(0, min(255, iv("cl_crosshaircolor_a", 255))) / 255

    near = th // 2 + gap
    span = near + length
    half = span + 4
    size = half * 2
    disp = max(64, min(160, size))
    label = ("drawn to scale — enlarged to fit" if size < disp else
             "drawn to scale — shrunk to fit" if size > disp else "actual size")

    arms = []
    if length > 0:
        arms.append([-(near + length), -th / 2, length, th])   # left
        arms.append([near, -th / 2, length, th])               # right
        if not t_shape:
            arms.append([-th / 2, -(near + length), th, length])  # top
        arms.append([-th / 2, near, th, length])               # bottom
    if dot:
        arms.append([-th / 2, -th / 2, th, th])

    rects = "".join(
        f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}"/>'
        for x, y, w, h in arms)
    outline_rects = "".join(
        f'<rect x="{x - 1:g}" y="{y - 1:g}" width="{w + 2:g}" height="{h + 2:g}"/>'
        for x, y, w, h in arms)

    # the viewBox (centered on the origin, 4px margin) does all the fitting:
    # small crosshairs are enlarged into the 64px box, ones over 160px shrunk
    parts = [
        f'<svg class="xhair-svg" width="{disp}" height="{disp}" '
        f'viewBox="{-half} {-half} {size} {size}" role="img" '
        f'aria-label="Crosshair preview, {label}: {esc(aria)}">',
        f'<rect x="{-half}" y="{-half}" width="{size}" height="{size}" fill="#20242b"/>',
    ]
    if outline and arms:
        parts.append('<g fill="rgba(0,0,0,0.9)">' + outline_rects + "</g>")
    parts.append(f'<g fill="rgba({r},{g},{b},{a:.3f})">{rects}</g>')
    parts.append("</svg>")
    return "".join(parts), label


def player_page(rec: dict, top10_rank=None) -> str:
    slug = rec["slug"]
    nick = rec.get("nick") or slug
    real = rec.get("real_name") or ""
    cv = rec.get("convars") or {}
    mouse = (rec.get("tables") or {}).get("Mouse", {})
    video = (rec.get("tables") or {}).get("Video Settings", {})

    cmds, warnings = full_commands(rec)
    full_block = "; ".join(cmds)
    xc_cmds, _ = convert_crosshair(cv)
    xh_line = [f"{k} {v}" for k, v in xc_cmds]
    xh_text = "; ".join(xh_line)

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

    avatar_url = f"{BASE}/{rec['avatar']}" if rec.get("avatar") else f"{BASE}/assets/og-default.png"
    og_desc = (f"Copy {nick}'s full CS2 config in one paste: crosshair, sensitivity"
               + (f" ({edpi} eDPI)" if edpi else "") + ", viewmodel, HUD, radar.")

    # only what app.js's DPI matcher reads
    embed = json_script({"dpi": dpi, "sens": sens, "commands": cmds})

    raw_cfg = ""
    cfg_path = ROOT / "cfg" / f"{slug}.cfg"
    if cfg_path.exists():
        raw_cfg = cfg_path.read_text(encoding="utf-8", errors="replace")

    chips = []
    if top10_rank:
        chips.append(f'<span class="chip"><b>HLTV #{top10_rank}</b></span>')
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
    if rec.get("steamid64"):
        links.append(f'<a href="https://procrosshairs.com/player/{esc(rec["steamid64"])}/{esc(slug)}" target="_blank" rel="noopener">crosshair history</a>')

    avatar_html = avatar_img(rec["avatar"], 92) if rec.get("avatar") else letter_div(nick)

    warnings_html = ""
    if warnings:
        warnings_html = '<p class="note warn">' + "<br>".join("⚠ " + esc(w) for w in warnings) + "</p>"

    raw_html = ""
    if raw_cfg:
        raw_html = f'''<section class="section">
      <div class="section-head"><h2>Raw autoexec.cfg <span class="tag">file</span></h2>
        <button type="button" class="btn ghost small" data-copy="{esc(raw_cfg)}">Copy raw</button>
        <a class="btn ghost small" href="/cfg/{esc(slug)}.cfg" download="{esc(slug)}.cfg">Download</a>
      </div>
      <details class="raw"><summary>Show raw config file</summary><div class="cmd" tabindex="0" role="group" aria-label="Config file, scrollable"><pre>{esc(raw_cfg)}</pre></div></details>
      <p class="note">The exact autoexec.cfg from the source site — in the <b>original pre-patch format</b> (some crosshair convars in it were removed by the Sept 22, 2026 update). For applying settings use the copy blocks above.</p>
    </section>'''
    download_html = (f'<a class="btn ghost" href="/cfg/{esc(slug)}.cfg" download="{esc(slug)}.cfg">Download .cfg</a>'
                     if raw_cfg else "")

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

    entity = {
        "@type": "Person",
        "name": nick,
        "alternateName": real,
        "jobTitle": "CS2 professional player",
        "identifier": rec.get("steamid64"),
        "url": f"{BASE}/p/{slug}/",
    }
    person = {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        "mainEntity": {k: v for k, v in entity.items() if v},  # no nulls in structured data
    }
    xh_svg, xh_label = xhair_svg(cv, aria)

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
  <meta property="og:description" content="{esc(og_desc)}">
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
  {json_script(person)}
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
    <div class="chips profile-chips">{''.join(chips)}</div>
    <div class="head-actions">
      <button type="button" class="btn" data-copy="{esc(full_block)}">Copy full config</button>
      {download_html}
    </div>
    <section class="section">
      <div class="section-head"><h2>Crosshair <span class="tag">new system</span></h2>
        <button type="button" class="btn small" data-copy="{esc(xh_text)}">Copy crosshair</button></div>
      <div class="xhair-box">
        <div class="xhair-preview">
          {xh_svg}
          <div class="xhair-label">{xh_label}</div>
        </div>
        <div class="xhair-meta">
          <div class="cmd" tabindex="0" role="group" aria-label="Crosshair commands, scrollable">{cmd_pre(xh_line)}</div>
          {warnings_html}
          <p class="note">CS2's Sept 22, 2026 "Rush Hour" patch replaced the crosshair system, so these commands are converted to the new convars from {esc(nick)}'s original settings (reference: <a href="https://github.com/sebastianspicker/small-indie-crosshair-company" target="_blank" rel="noopener">community crosshair migration study</a>, build 2000914). They're also included at the start of the <b>Full config</b> below.</p>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Full config <span class="tag">paste in console</span></h2>
        <button type="button" class="btn small" data-copy="{esc(full_block)}">Copy all</button>
        <span id="btn-mydpi-slot"></span></div>
      <div class="cmd" tabindex="0" role="group" aria-label="Console commands, scrollable">{cmd_pre(cmds)}</div>
      <p class="note">One single line, <code>;</code>-separated so the console runs every command: press <b>~</b> in CS2, paste, hit Enter — done. (The CS2 console is single-line input, so multi-line pastes are unreliable.) The crosshair part is converted to the convars added by the Sept 22, 2026 patch; convars that were removed, renamed, cheat-protected or nonexistent in CS2 are filtered out. If a very long paste ever gets cut off, use the shorter per-section commands below instead.</p>
    </section>

    {category_sections_html(rec)}
    {launch_html}
    {video_tables_html(rec)}
    {raw_html}
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

    cards = []
    for p in players:
        slug = p["slug"]
        nick = p.get("nick") or slug
        real = p.get("real_name") or ""
        avatar = avatar_img(p["avatar"], 72, lazy=True) if p.get("avatar") else letter_div(nick)
        chips = []
        if p.get("edpi") is not None:
            chips.append(f'<span class="chip"><b>{p["edpi"]}</b> eDPI</span>')
        if p.get("sens"):
            chips.append(f'<span class="chip">sens {esc(p["sens"])}</span>')
        if p.get("res"):
            chips.append(f'<span class="chip">{esc(p["res"])}</span>')
        cards.append(f'''<a class="card" href="/p/{esc(slug)}/" data-nick="{esc(nick.lower())}" data-real="{esc(real.lower())}" data-slug="{esc(slug)}" data-edpi="{p.get("edpi") if p.get("edpi") is not None else ""}" data-sens="{esc(p.get("sens") or "")}" data-res="{esc(p.get("res") or "")}">
  {avatar}
  <div class="nick">{esc(nick)}</div>
  <div class="real">{esc(real)}</div>
  <div class="chips">{''.join(chips)}</div>
</a>''')

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
  <script type="application/ld+json">{json_script(ld)}</script>
</head>
<body data-page="index">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="logo" href="/">CS2<span class="dot">//</span>PROS <small>configs</small></a>
      <div class="spacer"></div>
      <label class="search">
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="Search players… ( / )" autocomplete="off" aria-label="Search players by nickname or real name">
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

    {top10_section_html(top10_data, players)}

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
      <select id="res"><option value="">Any</option>{''.join(f'<option value="{esc(r)}">{esc(r)}</option>' for r in sorted({p["res"] for p in players if p.get("res")}, key=res_key))}</select>
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


def top10_section_html(top10_data, players) -> str:
    if not top10_data:
        return ""
    by_slug = {p["slug"]: p for p in players}
    cards = []
    for t in top10_data["players"]:
        slug = t.get("slug") or ""
        p = by_slug.get(slug)
        href = f"/p/{esc(slug)}/" if p else (t.get("hltv") or "#")
        med = " medal" if t["rank"] <= 3 else ""
        avatar = avatar_img(p["avatar"], 72) if p and p.get("avatar") else letter_div(t["nick"])
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
  <meta name="robots" content="noindex">
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


def sitemap_xml(entries) -> str:
    """entries: (url, lastmod, priority) tuples."""
    urls = [f"<url><loc>{esc(u)}</loc><lastmod>{m}</lastmod><priority>{pr}</priority></url>"
            for u, m, pr in entries]
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "\n".join(urls) + "\n</urlset>\n")


def previous_lastmods() -> dict:
    try:
        text = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    return dict(re.findall(r"<loc>([^<]+)</loc><lastmod>([^<]+)</lastmod>", text))


def write_if_changed(path: Path, text: str) -> bool:
    try:
        if path.read_text(encoding="utf-8") == text:
            return False
    except FileNotFoundError:
        pass
    path.write_text(text, encoding="utf-8")
    return True


def robots_txt() -> str:
    return f"User-agent: *\nAllow: /\n\nSitemap: {BASE}/sitemap.xml\n"


def main() -> None:
    index = json.loads((ROOT / "data" / "index.json").read_text())
    players = index["players"]
    generated = index["meta"]["generated"]

    try:
        top10_data = json.loads((ROOT / "data" / "top10.json").read_text())
    except Exception:
        top10_data = None
    top10_rank = {}
    if top10_data:
        top10_rank = {t["slug"]: t["rank"] for t in top10_data.get("players", []) if t.get("slug")}

    # sitemap lastmod moves only when a page's HTML actually changes, so
    # crawlers aren't told all 600+ pages changed on every weekly refresh
    today = datetime.now(timezone.utc).date().isoformat()
    prev = previous_lastmods()
    entries = []

    def emit(path: Path, html: str, url: str, priority: str) -> None:
        changed = write_if_changed(path, html)
        entries.append((url, today if changed or url not in prev else prev[url], priority))

    emit(ROOT / "index.html", index_page(players, top10_data, generated), f"{BASE}/", "1.0")
    print("index.html")

    n = 0
    for p in players:
        slug = p["slug"]
        f = ROOT / "data" / "players" / f"{slug}.json"
        if not f.exists():
            continue
        rec = json.loads(f.read_text())
        d = ROOT / "p" / slug
        d.mkdir(parents=True, exist_ok=True)
        emit(d / "index.html", player_page(rec, top10_rank.get(slug)), f"{BASE}/p/{slug}/", "0.8")
        n += 1
    print(f"p/ pages: {n}")

    write_if_changed(ROOT / "player.html", redirect_stub())
    write_if_changed(ROOT / "404.html", not_found_page())
    write_if_changed(ROOT / "sitemap.xml", sitemap_xml(entries))
    write_if_changed(ROOT / "robots.txt", robots_txt())
    print("sitemap.xml robots.txt 404.html player.html")


if __name__ == "__main__":
    main()
