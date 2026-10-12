#!/usr/bin/env python3
"""
Static site generator for cs2-pro-configs.

Prerenders the whole site to plain HTML so search engines (and users
without JS) see full content:
  index.html          - hero, HLTV top 10, prerendered player grid
  p/<slug>/index.html - one static page per player (clean URLs)
  cfg/<slug>.cfg      - the converted config as an exec-able file
  player.html         - redirect stub for legacy ?p= links
  sitemap.xml, robots.txt, 404.html

Run AFTER scrape.py, top10.py and crosshair.mjs (reads data/*.json, cfg/raw/*.cfg).
Canonical origin: https://copyprosta.com
"""

import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://copyprosta.com"

# CS2 still ships the Source tokenizer, which rejects a console line longer than
# 510 characters ("...overflows the tokenizer buffer.. Skipping!"), so every
# console copy string is kept at or under this, with a margin
LINE_LIMIT = 500

CONSOLE_SKIP = {
    "cl_drawhud", "cl_radar_size", "setting.defaultres", "setting.defaultresheight",
    # removed by the Sept 2026 crosshair update; the cl_crosshair* convars are
    # replaced as a whole by the converted crosshair commands
    "cl_fixedcrosshairgap",
    # not a CS2 convar or command (absent from the build 2000930 dump)
    "cl_mouselook",
}

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

# the full config as console lines: crosshair, then mouse/viewmodel/radar, then HUD/misc
PART_GROUPS = [
    ("Crosshair", ("crosshair",)),
    ("Mouse, viewmodel & radar", ("mouse", "viewmodel", "radar")),
    ("HUD & other", ("hud", "misc")),
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


def safe_value(v):
    """Value as it goes into a ;-joined console line, or None to drop it.
    Anything containing ; quotes or newlines would inject extra commands.
    Booleans become 1/0, which every convar accepts."""
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


def section_commands(rec) -> dict:
    """Console commands per non-crosshair bucket (the crosshair comes from the
    converter, see crosshair_commands)."""
    buckets = bucket_convars(rec.get("convars"))
    out = {}
    for key, *_ in BUCKETS:
        if key == "crosshair":
            continue
        out[key] = []
        for k, v in buckets[key]:
            if k in CONSOLE_SKIP:
                continue
            sv = safe_value(v)
            if sv is not None:
                out[key].append(f"{k} {sv}")
    return out


def kind_of(xp) -> str:
    """"converted" from pre-patch settings, "copied" (already new format) or "blocked"."""
    return (xp or {}).get("kind") or ("converted" if (xp or {}).get("commands") else "blocked")


def crosshair_commands(xp) -> list:
    """Converted crosshair commands, or [] when the converter refused the input."""
    return list(xp.get("commands") or []) if xp else []


def chunk(cmds, limit=LINE_LIMIT) -> list:
    """Split commands into groups whose "; "-joined line is at most `limit` characters."""
    out, cur = [], []
    for c in cmds:
        if len(c) > limit:
            raise ValueError(f"console command longer than {limit} characters: {c[:60]}...")
        if cur and len("; ".join(cur + [c])) > limit:
            out.append(cur)
            cur = []
        cur.append(c)
    if cur:
        out.append(cur)
    return out


def console_parts(rec, xp) -> list:
    """The full config as [(label, commands)], every part one console line of at
    most LINE_LIMIT characters."""
    sections = section_commands(rec)
    parts = []
    for label, keys in PART_GROUPS:
        cmds = crosshair_commands(xp) if keys == ("crosshair",) else [c for k in keys for c in sections[k]]
        pieces = chunk(cmds)
        for i, piece in enumerate(pieces):
            parts.append((label + (f" ({i + 1}/{len(pieces)})" if len(pieces) > 1 else ""), piece))
    return parts


def full_commands(rec, xp) -> list:
    """Every console command in paste order (crosshair first)."""
    return [c for _, cmds in console_parts(rec, xp) for c in cmds]


def player_cfg(rec, xp) -> str:
    """The converted config as an exec-able .cfg file, one command per line."""
    slug = rec["slug"]
    nick = rec.get("nick") or slug
    about = {
        "converted": ["// From the settings settings.gg lists for this player; the pre-patch crosshair",
                      "// is converted to the Sept 2026 crosshair system (community reconstruction)."],
        "copied": ["// From the settings settings.gg lists for this player; the crosshair is copied",
                   "// as listed (already in the format CS2 uses since the Sept 2026 update)."],
    }.get(kind_of(xp), ["// From the settings settings.gg lists for this player. The crosshair couldn't",
                        "// be converted automatically and is not included."])
    head = [f"// {nick} - CS2 config from {BASE}/p/{slug}/", *about,
            f"// Save as Counter-Strike Global Offensive/game/csgo/cfg/{slug}.cfg, then run: exec {slug}", ""]
    return "\n".join(head + full_commands(rec, xp)) + "\n"


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


def cmd_block(cmds, label="Console commands") -> str:
    return f'<div class="cmd" tabindex="0" role="group" aria-label="{esc(label)}, scrollable">{cmd_pre(cmds)}</div>'


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
    sections = section_commands(rec)
    mouse = (rec.get("tables") or {}).get("Mouse", {})
    parts = []
    for key, title, tag, _t in BUCKETS:
        if key == "crosshair" or not sections[key]:
            continue
        pieces = chunk(sections[key])
        buttons = "".join(
            f'<button type="button" class="btn ghost small" data-copy="{esc("; ".join(piece))}">'
            f'Copy{f" {i + 1}/{len(pieces)}" if len(pieces) > 1 else ""}</button>'
            for i, piece in enumerate(pieces))
        parts.append(f'''<section class="section">
  <div class="section-head"><h2>{esc(title)} <span class="tag">{esc(tag)}</span></h2>
  {buttons}</div>
  {cmd_block(sections[key])}''')
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


def _cell(v: float) -> int:
    # the converter's raster convention: a rect edge at v covers cells from ceil(v - 0.5)
    return math.ceil(v - 0.5)


def xhair_svg(preview: dict, height: int, aria: str):
    """Inline-SVG preview of the converted crosshair: the pixel rectangles the
    converter's renderer model draws at the pro's resolution, 1 game px = 1 CSS
    px unless resized to fit the 64-160px box. Ships in the HTML, so it renders
    without JavaScript. Returns (svg, label)."""
    def cells(rects):
        out = []
        for x, y, w, h in rects:
            x0, y0 = _cell(x), _cell(y)
            out.append((x0, y0, _cell(x + w) - x0, _cell(y + h) - y0))
        return [r for r in out if r[2] > 0 and r[3] > 0]

    fill, outline = cells(preview["fill"]), cells(preview["outline"])
    extent = max([max(-x, x + w, -y, y + h) for x, y, w, h in fill + outline] or [4])
    half = extent + 3
    size = 2 * half
    disp = max(64, min(160, size))
    label = (f"{height}p pixels, enlarged" if size < disp else
             f"{height}p pixels, shrunk to fit" if size > disp else f"1:1 at {height}p")

    def rgba(c):
        return f"rgba({c[0]},{c[1]},{c[2]},{c[3] / 255:.3f})"

    def path(rects):
        # one path, so overlapping rects are filled once (no doubled alpha)
        return "".join(f"M{x} {y}h{w}v{h}h{-w}z" for x, y, w, h in rects)

    parts = [
        f'<svg class="xhair-svg" width="{disp}" height="{disp}" viewBox="{-half} {-half} {size} {size}" '
        f'shape-rendering="crispEdges" role="img" aria-label="Crosshair preview, {label}: {esc(aria)}">',
        f'<rect x="{-half}" y="{-half}" width="{size}" height="{size}" fill="#4a505b"/>',
    ]
    if outline and preview.get("outlineRgba"):
        parts.append(f'<path fill="{rgba(preview["outlineRgba"])}" d="{path(outline)}"/>')
    if fill:
        parts.append(f'<path fill="{rgba(preview["rgba"])}" d="{path(fill)}"/>')
    parts.append("</svg>")
    return "".join(parts), label


def crosshair_section_html(rec, xp, reference) -> str:
    slug = rec["slug"]
    nick = rec.get("nick") or slug
    history = (f' — see their <a href="https://procrosshairs.com/player/{esc(rec["steamid64"])}/{esc(slug)}" '
               f'target="_blank" rel="noopener">crosshair history</a>' if rec.get("steamid64") else "")
    ref_link = (f'<a href="{esc(reference["url"])}" target="_blank" rel="noopener">{esc(reference["name"])}</a> '
                f'v{esc(reference["version"])}, model {esc(reference["model"])}, CS2 build {esc(reference["build"])}')
    cmds = crosshair_commands(xp)
    if not cmds:
        why = " ".join((xp or {}).get("blockers") or []) or (xp or {}).get("error") or "no data"
        return f'''<section class="section" id="crosshair">
      <div class="section-head"><h2>Crosshair <span class="tag">new system</span></h2></div>
      <p class="note warn">This crosshair can't be converted automatically: {esc(why)}</p>
      <p class="note">Converter: {ref_link}.</p>
    </section>'''

    n = xp["native"]
    height = xp["height"]
    aria = f"{n['length']} pixel arms, {n['thickness']} pixel thick, gap {n['gap']}, at {height}p"
    svg, label = xhair_svg(xp["preview"], height, aria) if xp.get("preview") else ("", "no preview for this style")
    notes = ""
    if xp.get("warnings"):
        notes = ('<ul class="xh-notes" aria-label="Conversion notes">'
                 + "".join(f"<li>{esc(w['text'])}</li>" for w in xp["warnings"]) + "</ul>")
    authored = {
        "resolution": f"authored at {height}p, {esc(nick)}'s resolution",
        "config": f"authored at {height}p, as their config says",
    }.get(xp.get("heightSource"), f"authored at {height}p (their resolution isn't listed)")
    if kind_of(xp) == "copied":
        about = (f'<p class="note">settings.gg lists {esc(nick)}\'s crosshair in the format CS2 uses since the '
                 f"Sept 22, 2026 update, so it's copied as-is, {authored}; CS2 rescales it to your resolution.</p>")
    else:
        about = (f'<p class="note">Converted from the pre-patch crosshair settings.gg lists for {esc(nick)} to CS2\'s '
                 f"crosshair system since the Sept 22, 2026 update, {authored}; CS2 rescales it to your resolution. "
                 f"Many pros rebuilt their crosshair after the update, so this may not be what {esc(nick)} uses now{history}.</p>\n"
                 f'          <p class="note">Valve published no conversion formula. This uses a community reconstruction '
                 f"({ref_link}) that hasn't been checked against in-game captures.</p>")
    pieces = chunk(cmds)
    buttons = "".join(
        f'<button type="button" class="btn small" data-copy="{esc("; ".join(piece))}">'
        f'Copy crosshair{f" {i + 1}/{len(pieces)}" if len(pieces) > 1 else ""}</button>'
        for i, piece in enumerate(pieces))
    return f'''<section class="section" id="crosshair">
      <div class="section-head"><h2>Crosshair <span class="tag">new system</span></h2>
        {buttons}</div>
      <div class="xhair-box">
        <div class="xhair-preview">
          {svg}
          <div class="xhair-label">{label}</div>
        </div>
        <div class="xhair-meta">
          {cmd_block(cmds, "Crosshair commands")}
          {notes}
          {about}
        </div>
      </div>
    </section>'''


def player_page(rec: dict, xp: dict, reference: dict, top10_rank=None) -> str:
    slug = rec["slug"]
    nick = rec.get("nick") or slug
    real = rec.get("real_name") or ""
    cv = rec.get("convars") or {}
    mouse = (rec.get("tables") or {}).get("Mouse", {})
    video = (rec.get("tables") or {}).get("Video Settings", {})

    parts = console_parts(rec, xp)
    xh_cmds = crosshair_commands(xp)

    dpi = mouse.get("DPI", "")
    sens = cv.get("sensitivity", "")
    try:
        edpi = int(float(dpi) * float(sens))
    except (TypeError, ValueError):
        edpi = None

    res = video.get("Resolution", "")
    kind = kind_of(xp)
    xh_phrase = {"converted": "crosshair converted to the new crosshair system", "copied": "crosshair"}.get(kind)
    desc = (f"{nick}'s CS2 settings as console commands: " + (xh_phrase or "sensitivity")
            + (f", {dpi} DPI x {sens} sens ({edpi} eDPI)" if edpi else "")
            + (f", {res}" + (f" {video['Scaling Mode']}" if video.get("Scaling Mode") else "") if res else "")
            + ", viewmodel, HUD, radar and launch options - copy, paste, play.")

    avatar_url = f"{BASE}/{rec['avatar']}" if rec.get("avatar") else f"{BASE}/assets/og-default.png"
    og_desc = (f"{nick}'s CS2 " + ({"converted": "crosshair (converted to the new system), sensitivity",
                                     "copied": "crosshair, sensitivity"}.get(kind, "sensitivity"))
               + (f" ({edpi} eDPI)" if edpi else "") + ", viewmodel, HUD and radar as copy-paste console commands.")

    # only what app.js's DPI matcher reads
    embed = json_script({"dpi": dpi, "sens": sens, "parts": [cmds for _, cmds in parts]})

    raw_cfg = ""
    raw_path = ROOT / "cfg" / "raw" / f"{slug}.cfg"
    if raw_path.exists():
        raw_cfg = raw_path.read_text(encoding="utf-8", errors="replace")

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
    download = f'<a class="btn ghost" href="/cfg/{esc(slug)}.cfg" download="{esc(slug)}.cfg">Download .cfg</a>'

    part_blocks = "\n".join(f'''<div class="part">
        <div class="part-head"><span class="part-label">Part {i + 1} · {esc(label)}</span>
          <button type="button" class="btn small" data-copy="{esc("; ".join(cmds))}">Copy part {i + 1}</button>
          <span class="mydpi-slot" data-part="{i}"></span></div>
        {cmd_block(cmds)}
      </div>''' for i, (label, cmds) in enumerate(parts))

    raw_html = ""
    if raw_cfg:
        raw_html = f'''<section class="section">
      <div class="section-head"><h2>Original autoexec.cfg <span class="tag">{"settings.gg" if kind == "copied" else "pre-patch"}</span></h2>
        <a class="btn ghost small" href="/cfg/raw/{esc(slug)}.cfg" download="{esc(slug)}-original.cfg">Download original</a>
      </div>
      <details class="raw"><summary>Show original config file</summary>{cmd_block_raw(raw_cfg)}</details>
      <p class="note">{"The autoexec.cfg exactly as settings.gg serves it. The commands and .cfg above leave out the convars that don't work in CS2." if kind == "copied" else "The autoexec.cfg exactly as settings.gg serves it, in the format from before the Sept 22, 2026 update: its crosshair settings no longer work in CS2, so don't exec it — use the converted commands or .cfg above."}</p>
    </section>'''

    launch = rec.get("launch_options")
    launch_html = ""
    if launch:
        launch_html = f'''<section class="section">
  <div class="section-head"><h2>Launch Options <span class="tag">Steam</span></h2>
  <button type="button" class="btn ghost small" data-copy="{esc(launch)}">Copy</button></div>
  <div class="cmd" tabindex="0" role="group" aria-label="Launch options, scrollable"><pre>{esc(launch)}</pre></div>
  <p class="note">Steam → right-click Counter-Strike 2 → Properties → Launch Options → paste.</p>
</section>'''

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
    if not xh_cmds:
        head_copy = ""
    elif len(chunk(xh_cmds)) == 1:
        head_copy = f'<button type="button" class="btn" data-copy="{esc("; ".join(xh_cmds))}">Copy crosshair</button>'
    else:
        head_copy = '<a class="btn" href="#crosshair">Crosshair ↓</a>'


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
      {head_copy}
      {download}
      <a class="btn ghost" href="#full-config">Full config ↓</a>
    </div>
    {crosshair_section_html(rec, xp, reference)}

    <section class="section" id="full-config">
      <div class="section-head"><h2>Full config <span class="tag">{len(parts)} part{"s" if len(parts) != 1 else ""}</span></h2>
        {download.replace('class="btn ghost"', 'class="btn ghost small"')}</div>
      <p class="note lead">The CS2 console can reject a pasted line longer than 510 characters, so the full config comes in parts: press <b>~</b> in CS2, paste part 1, press Enter, then do the same with the next part. Or download the .cfg, save it in <code>Counter-Strike Global Offensive/game/csgo/cfg/</code> and run <code>exec {esc(slug)}</code> in the console.</p>
      {part_blocks}
      <p class="note">Convars that were removed, renamed, cheat-protected or don't exist in CS2 are left out.</p>
    </section>

    {category_sections_html(rec)}
    {launch_html}
    {video_tables_html(rec)}
    {raw_html}
  </main>

  <footer>
    <div class="wrap">
      <p>Settings data from <a href="https://settings.gg/players" target="_blank" rel="noopener">settings.gg</a> · Crosshair conversion by <a href="{esc(reference["url"])}" target="_blank" rel="noopener">{esc(reference["name"])}</a> (MIT) · Unofficial fan-made tool, not affiliated with Valve or settings.gg. CS2 and Counter-Strike are trademarks of Valve.</p>
    </div>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script type="application/json" id="player-data">{embed}</script>
  <script src="/assets/app.js"></script>
</body>
</html>
'''


def cmd_block_raw(text: str) -> str:
    return f'<div class="cmd" tabindex="0" role="group" aria-label="Config file, scrollable"><pre>{esc(text)}</pre></div>'


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
  <meta name="twitter:description" content="Copy any pro's CS2 config as console commands: crosshair (converted to the new system), sensitivity, viewmodel, HUD, radar.">
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
      <h1>Play like a pro<span class="dot">.</span> Copy, paste, play.</h1>
      <p>Full CS2 settings from {count} of the world's best players as ready-to-paste console commands, with each crosshair
         converted to the new crosshair system from the Sept 22, 2026 update. Pick a player, copy, paste into your console.</p>
      <div class="steps">
        <div class="step"><b><span class="num">1</span>Pick a pro</b>Search by nickname and open their profile.</div>
        <div class="step"><b><span class="num">2</span>Copy the config</b>Grab the crosshair, a single section, or the full config (in 2–3 parts).</div>
        <div class="step"><b><span class="num">3</span>Paste in CS2 console</b>Press <b>~</b> in CS2, paste, Enter. Or download the .cfg and <code>exec</code> it.</div>
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

    # converted crosshairs, written by `node scraper/crosshair.mjs` after scrape.py
    crosshair = json.loads((ROOT / "data" / "crosshair.json").read_text(encoding="utf-8"))
    missing = [p["slug"] for p in players if p["slug"] not in crosshair["players"]]
    if missing:
        raise SystemExit(f"data/crosshair.json lacks {len(missing)} player(s) ({', '.join(missing[:5])}): "
                         "run node scraper/crosshair.mjs first")

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
        xp = crosshair["players"][slug]
        d = ROOT / "p" / slug
        d.mkdir(parents=True, exist_ok=True)
        emit(d / "index.html", player_page(rec, xp, crosshair["reference"], top10_rank.get(slug)),
             f"{BASE}/p/{slug}/", "0.8")
        write_if_changed(ROOT / "cfg" / f"{slug}.cfg", player_cfg(rec, xp))
        n += 1
    print(f"p/ pages and cfg/ files: {n}")

    write_if_changed(ROOT / "player.html", redirect_stub())
    write_if_changed(ROOT / "404.html", not_found_page())
    write_if_changed(ROOT / "sitemap.xml", sitemap_xml(entries))
    write_if_changed(ROOT / "robots.txt", robots_txt())
    print("sitemap.xml robots.txt 404.html player.html")


if __name__ == "__main__":
    main()
