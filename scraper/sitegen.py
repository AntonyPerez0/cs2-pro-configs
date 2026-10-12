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

import hashlib
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

# convars a CS2 config can set, with [min, max], from the game's convar dump
# (scraper/tools/cs2_convars.py). Anything else - removed, renamed, cheat-protected
# or never a CS2 convar (cl_drawhud, cl_radar_size, cl_mouselook, setting.defaultres,
# m_rawinput, ...) - is left out of every paste. The cl_crosshair* convars are
# replaced as a whole by the converted crosshair commands.
_CS2 = json.loads((Path(__file__).resolve().parent / "cs2_convars.json").read_text())
CS2_CONVARS = _CS2["convars"]
CS2_CHEAT = set(_CS2.get("cheat", []))
# CS:GO names CS2 renamed (old configs)
RENAMED = {"zoom_sensitivity_ratio_mouse": "zoom_sensitivity_ratio",
           # 1 = show the alive count instead of avatars, in both games
           "cl_hud_playercount_showcount": "cl_teamcounter_playercount_instead_of_avatars"}
# CS:GO cl_righthand 1 (right hand) is CS2 cl_prefer_lefthanded 0
INVERTED = {"cl_righthand": "cl_prefer_lefthanded"}

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


def asset_url(name: str) -> str:
    """/assets/<name>?v=<content hash>: a deploy that changes the file changes the URL, so
    browsers never pair new pages with a cached older app.js or style.css."""
    digest = hashlib.sha256((ROOT / "assets" / name).read_bytes()).hexdigest()[:10]
    return f"/assets/{name}?v={digest}"


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


def cs2_command(k, v):
    """(command, note) for one config convar as CS2 accepts it: renamed where CS2
    renamed it, clamped to CS2's range, or (None, note) when CS2 has no such convar
    or the value is unsafe. note is None when nothing changed."""
    sv = safe_value(v)
    if sv is None:
        return None, None
    name = RENAMED.get(k, k)
    note = f"{k} is called {name} in CS2" if name != k else None
    if k in INVERTED and sv in ("0", "1"):
        name, sv = INVERTED[k], "1" if sv == "0" else "0"
        note = f"{k} {v} is {name} {sv} in CS2 (the value is inverted)"
    if name not in CS2_CONVARS:
        if name in CS2_CHEAT:
            return None, f"{k} is cheat-protected in CS2, left out"
        if k.startswith("setting."):  # CS2's own video settings, saved by the game, not set by a config
            return None, f"{k} is a video setting, set in Settings → Video (see Video settings), left out"
        return None, f"{k} doesn't exist in CS2, left out"
    lo, hi = CS2_CONVARS[name]
    try:
        x = float(sv)
    except ValueError:
        if lo is not None or hi is not None:  # a numeric convar given e.g. "null"
            return None, f"{k} {v} isn't a valid value, left out"
        return f"{name} {sv}", note
    clamped = max(lo, x) if lo is not None else x
    clamped = min(hi, clamped) if hi is not None else clamped
    if clamped != x:
        sv = f"{clamped:g}"
        note = f"{k} {v} is outside CS2's range, set to {sv}"
    return f"{name} {sv}", note


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
            cmd, _note = cs2_command(k, v)
            if cmd is not None and not shadowed(k, rec.get("convars")):
                out[key].append(cmd)
    return out


def shadowed(k, convars) -> bool:
    """An old name whose CS2 name the config also sets: the CS2 one wins."""
    new = RENAMED.get(k) or INVERTED.get(k)
    return bool(new) and new in (convars or {})


def adaptation_notes(rec) -> list:
    """What cs2_command changed in a config (renamed, clamped, left out)."""
    notes = []
    convars = rec.get("convars") or {}
    for k, v in convars.items():
        if not k.startswith("cl_crosshair") and k != "cl_fixedcrosshairgap":  # crosshair: the converter's
            notes.append(f"{k} left out: the config also sets its CS2 name" if shadowed(k, convars)
                         else cs2_command(k, v)[1])
    return [n for n in notes if n]


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


# a crosshair's sizes, and the screen height they were authored at (set last: CS2 resets
# it whenever a size changes)
XHAIR_SIZE = ("cl_crosshair_length ", "cl_crosshair_thickness ", "cl_crosshair_gap ", "cl_crosshair_screen_height ")


def xhair_chunks(cmds, limit=LINE_LIMIT) -> list:
    """A crosshair paste as console lines. When it needs more than one, the sizes and the
    screen height share the last line, so no line sets sizes without their height."""
    if len("; ".join(cmds)) <= limit:
        return [list(cmds)]
    size = [c for c in cmds if c.startswith(XHAIR_SIZE)]
    parts = chunk([c for c in cmds if not c.startswith(XHAIR_SIZE)], limit)
    if len("; ".join(parts[-1] + size)) <= limit:
        parts[-1] = parts[-1] + size
    else:
        parts.append(size)
    return parts


def console_parts(rec, xp) -> list:
    """The full config as [(label, commands)], every part one console line of at
    most LINE_LIMIT characters."""
    sections = section_commands(rec)
    parts = []
    for label, keys in PART_GROUPS:
        cmds = crosshair_commands(xp) if keys == ("crosshair",) else [c for k in keys for c in sections[k]]
        pieces = xhair_chunks(cmds) if keys == ("crosshair",) else chunk(cmds)
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


def avatar_img(path: str, size: int, lazy: bool = False, alt: str = "") -> str:
    return (f'<img class="avatar" src="/{esc(path)}" alt="{esc(alt)}" width="{size}" height="{size}"'
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
            hint = rec.get("dpi_hint")
            if hint and not mouse.get("DPI"):
                parts[-1] += (f'\n  <p class="note">Their DPI isn\'t documented with this sensitivity. The matcher below '
                              f'assumes <b>{esc(hint["dpi"])} DPI</b>, from <a href="{esc(hint["source"])}" target="_blank" '
                              f'rel="noopener nofollow">their setup.gg profile</a> ({esc(hint["date"])}, where they used '
                              f'sensitivity {esc(hint["sens"])}); change it if you know better.</p>')
            parts[-1] += '\n  <div id="dpi-slot"></div>'
        if key == "misc":
            parts[-1] += ('\n  <p class="note">Misc convars (fps caps, gamma, gameplay toggles) '
                          "captured from this player's config.</p>")
        parts[-1] += "\n</section>"
    return "\n".join(parts)


def video_tables_html(rec, launch_hint=True):
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
  <p class="note">CS2 doesn't allow these via console commands — set them in Settings → Video. For <b>stretched</b> scaling also configure your GPU driver panel{" (or use the resolution launch options below)" if launch_hint else ""}.</p>
</section>'''


def adapted_section_html(rec) -> str:
    """What changed to make the config work in CS2, so a value that differs from
    the original (a clamp, a rename, an inversion) is never silent."""
    notes = adaptation_notes(rec)
    if not notes:
        return ""
    items = "".join(f"<li>{esc(n)}</li>" for n in notes)
    body = (f'<ul class="xh-notes plain">{items}</ul>' if len(notes) <= 6 else
            f'<details class="raw"><summary>Show what changed</summary><ul class="xh-notes plain">{items}</ul></details>')
    return (f'<section class="section"><div class="section-head"><h2>Adapted for CS2 <span class="tag">{len(notes)}</span>'
            f'</h2></div>{body}</section>')


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


def crosshair_section_html(rec, xp, reference, source_note=None) -> str:
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
        "crosshair-source": f"authored at {height}p, the resolution the crosshair's source lists",
    }.get(xp.get("heightSource"), f"authored at {height}p (their resolution isn't listed)")
    if source_note:
        about = (f'<p class="note">{source_note} Converted to CS2\'s crosshair system since the Sept 22, 2026 update, '
                 f"{authored}; CS2 rescales it to your resolution.</p>\n"
                 f'          <p class="note">Valve published no conversion formula. This uses a community reconstruction '
                 f"({ref_link}) that hasn't been checked against in-game captures.</p>")
    elif kind_of(xp) == "copied":
        about = (f'<p class="note">settings.gg lists {esc(nick)}\'s crosshair in the format CS2 uses since the '
                 f"Sept 22, 2026 update, so it's copied as-is, {authored}; CS2 rescales it to your resolution.</p>")
    else:
        about = (f'<p class="note">Converted from the pre-patch crosshair settings.gg lists for {esc(nick)} to CS2\'s '
                 f"crosshair system since the Sept 22, 2026 update, {authored}; CS2 rescales it to your resolution. "
                 f"Many pros rebuilt their crosshair after the update, so this may not be what {esc(nick)} uses now{history}.</p>\n"
                 f'          <p class="note">Valve published no conversion formula. This uses a community reconstruction '
                 f"({ref_link}) that hasn't been checked against in-game captures.</p>")
    # the paste sets every setting that shapes this crosshair (crosshair.mjs complete())
    about += ('\n          <p class="note">The paste sets every setting that shapes this crosshair, including the '
              "iron-sight dot (CS2's defaults where their config has no value), so nothing from your current crosshair "
              "carries over.</p>")
    pieces = xhair_chunks(cmds)
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


def player_page(rec: dict, xp: dict, reference: dict, top10_rank=None, classic_entries=()) -> str:
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
    for key, cid, stood in classic_entries:
        links.append(f'<a href="/classic/{esc(key)}/{esc(cid)}/">{esc(stood)} (classic)</a>')

    avatar_html = avatar_img(rec["avatar"], 92) if rec.get("avatar") else letter_div(nick)
    download = f'<a class="btn ghost" href="/cfg/{esc(slug)}.cfg" download="{esc(slug)}.cfg">Download .cfg</a>'

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
    elif len(xhair_chunks(xh_cmds)) == 1:
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
  <link rel="stylesheet" href="{asset_url('style.css')}">
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

    {full_config_html(parts, f"/cfg/{slug}.cfg", slug)}

    {category_sections_html(rec)}
    {adapted_section_html(rec)}
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
  <script src="{asset_url('app.js')}"></script>
</body>
</html>
'''


def full_config_html(parts, cfg_href: str, cfg_name: str) -> str:
    part_blocks = "\n".join(f'''<div class="part">
        <div class="part-head"><span class="part-label">Part {i + 1} · {esc(label)}</span>
          <button type="button" class="btn small" data-copy="{esc("; ".join(cmds))}">Copy part {i + 1}</button>
          <span class="mydpi-slot" data-part="{i}"></span></div>
        {cmd_block(cmds)}
      </div>''' for i, (label, cmds) in enumerate(parts))
    return f'''<section class="section" id="full-config">
      <div class="section-head"><h2>Full config <span class="tag">{len(parts)} part{"s" if len(parts) != 1 else ""}</span></h2>
        <a class="btn ghost small" href="{esc(cfg_href)}" download="{esc(cfg_name)}.cfg">Download .cfg</a></div>
      <p class="note lead">The CS2 console can reject a pasted line longer than 510 characters, so the full config comes in parts: press <b>~</b> in CS2, paste part 1, press Enter, then do the same with the next part. Or download the .cfg, save it in <code>Counter-Strike Global Offensive/game/csgo/cfg/</code> and run <code>exec {esc(cfg_name)}</code> in the console.</p>
      {part_blocks}
      <p class="note">Convars CS2 renamed are renamed, values outside CS2's range are set to the nearest one it accepts, and convars CS2 doesn't have or that are cheat-protected are left out (see Adapted for CS2 below).</p>
    </section>'''


def cmd_block_raw(text: str) -> str:
    return f'<div class="cmd" tabindex="0" role="group" aria-label="Config file, scrollable"><pre>{esc(text)}</pre></div>'


# ---------------- classic: top 10 of 2011-2015, and famous lineups ----------------
# A group in classic.json is a year's ranking (players have a rank) or, with
# "kind": "roster", teams' lineups at a point in time ("when", e.g. January 2015).

def gkey(y) -> str:
    """A group's URL segment and anchor: the year, or its own key."""
    return str(y.get("key") or y["year"])


def is_roster(y) -> bool:
    return y.get("kind") == "roster"


def glabel(y) -> str:
    """Short name for chips and headings: "2013", "C9 & iBP · Jan 2015"."""
    return y.get("label") or str(y["year"])


def standing(y, p) -> str:
    """Where the player stood: "#3 HLTV Top 20 of 2013", "Cloud9, January 2015", or a
    player's own "standing" in a lineup they had left ("iBUYPOWER until November 2014")."""
    if is_roster(y):
        return p.get("standing") or f"{p.get('team')}, {y.get('when')}"
    return f"#{p['rank']} {y['short']}"


def in_lineup(y, p) -> bool:
    """A lineup group can also list a player who had left by then (own "standing")."""
    return is_roster(y) and not p.get("standing")


CS2_RELEASE = "2023-09-27"


def config_game(c) -> str:
    """What a classic config's settings are from: CS:GO, or CS2 before the Sept 2026
    crosshair update for a source dated after CS2 replaced CS:GO."""
    w = c.get("window") or []
    start = w[0] if len(w) == 2 else str(c.get("date") or "")
    return "pre-update CS2" if start >= CS2_RELEASE else "CS:GO"


def classic_key(y, p) -> str:
    return f"{gkey(y)}/{p['id']}"


def classic_rec(y, p, players_by_slug) -> dict:
    """A classic entry's dated config in the record shape the page helpers read."""
    c = p["config"]
    rec = {"slug": f"{p['id']}-{gkey(y)}", "nick": p["nick"], "real_name": p.get("real_name") or "",
           "dpi_hint": c.get("dpi_hint"),
           "convars": c.get("convars") or {},
           "tables": {"Mouse": c.get("mouse") or {}, "Video Settings": c.get("video") or {}}}
    current = players_by_slug.get(p.get("current_slug") or "")
    if p.get("photo"):
        rec["avatar"] = p["photo"]["src"]  # a photo from that time, see photo_credit_html
    elif current and current.get("avatar"):
        rec["avatar"] = current["avatar"]
    return rec


def photo_alt(p) -> str:
    ph = p.get("photo") or {}
    return f"{p['nick']}" + (f" at {ph['event']}" if ph.get("event") else "") + (f", {ph['date']}" if ph.get("date") else "")


def photo_credit_html(ph) -> str:
    """CC attribution: what, when, who, licence (linked), where (Commons page)."""
    lic = (f'<a href="{esc(ph["license_url"])}" target="_blank" rel="noopener nofollow">{esc(ph["license"])}</a>'
           if ph.get("license_url") else esc(ph.get("license") or ""))
    what = esc(ph.get("event") or "Photo")
    return (f'<a href="{esc(ph["page"])}" target="_blank" rel="noopener nofollow">{what}</a> · {esc(ph.get("date") or "undated")}'
            f' · by {esc(ph.get("author") or "unknown")} · {lic} · via Wikimedia Commons · cropped')


def classic_cfg(rec, xp, year_obj, p) -> str:
    c = p["config"]
    head = [
        f"// {p['nick']} - {standing(year_obj, p)}, {config_game(c)} config from {c['date']}",
        f"// {BASE}/classic/{gkey(year_obj)}/{p['id']}/",
        *(["// Converted for CS2: crosshair converted to the Sept 2026 crosshair system (community",
            "// reconstruction); convars CS2 renamed are renamed, ones it no longer has are left out."]
          if crosshair_commands(xp) else
          ["// Converted for CS2 (its crosshair can't be converted, see the page): convars CS2",
           "// renamed are renamed, ones it no longer has are left out."]
          if any(k.startswith("cl_crosshair") for k in c.get("convars") or {}) else
          ["// Converted for CS2 (no crosshair in this config): convars CS2 renamed are renamed,",
           "// ones it no longer has are left out."]),
        f"// Save as Counter-Strike Global Offensive/game/csgo/cfg/{rec['slug']}.cfg, then run: exec {rec['slug']}",
        "",
    ]
    return "\n".join(head + full_commands(rec, xp)) + "\n"


def source_links(urls) -> str:
    """Links grouped by site: one link per site, or "hltv.org 1, 2, 3" when a
    site has several, rather than repeating the host name."""
    hosts = {}
    for u in urls or []:
        hosts.setdefault(re.sub(r"^https?://(www\.)?", "", u).split("/")[0] or u, []).append(u)
    link = lambda u, text: f'<a href="{esc(u)}" target="_blank" rel="noopener nofollow">{esc(text)}</a>'
    return ", ".join(
        link(us[0], host) if len(us) == 1
        else f"{esc(host)} " + ", ".join(link(u, str(i)) for i, u in enumerate(us, 1))
        for host, us in hosts.items())


def classic_date_note(y, c, converted=None) -> str:
    """converted: whether the crosshair converted (None: the config has crosshair settings)."""
    year = y["year"]
    date = str(c.get("date") or "")
    cy = int(date[:4]) if date[:4].isdigit() else None
    if cy is None:
        return "undated"
    if converted is None:
        converted = any(k.startswith("cl_crosshair") for k in c.get("convars") or {})
    closest = " that can be converted" if converted else ""
    if is_roster(y):
        # does the config's date, or its window (whose end is exclusive), reach into the lineup's month?
        t = y.get("target") or ""
        w = c.get("window")
        if t and (date.startswith(t) or (w and len(w) == 2 and w[0] <= f"{t}-31" and w[1] > f"{t}-01")):
            return f"from {esc(date)}, the time of this lineup"
        return f"from {esc(date)}, the closest to {esc(y.get('when'))} we found{closest}"
    if cy == year:
        return f"from {esc(date)}, the year of the ranking"
    return f"from {esc(date)}, the closest to {year} we found{closest}"


def classic_other_dates(c) -> str:
    """", with the sensitivity from 2014-07 and the DPI and resolution from 2016-12"
    for the parts that come from a config with another date than the main one."""
    by_date = {}
    for pv in c.get("provenance") or []:
        if pv.get("date") and pv["date"] != c.get("date"):
            name = pv["what"].split(",")[0].split(" (")[0]
            by_date.setdefault(pv["date"], []).append(name if name.isupper() else name.lower())
    if not by_date:
        return ""
    return ", with " + " and ".join(f"the {' and '.join(names)} from {esc(d)}" for d, names in by_date.items())


def classic_page(year_obj, p, rec, xp, reference, players_by_slug) -> str:
    year = year_obj["year"]
    key, label, roster = gkey(year_obj), glabel(year_obj), is_roster(year_obj)
    c = p["config"]
    nick = p["nick"]
    real = p.get("real_name") or ""
    url = f"{BASE}/classic/{key}/{p['id']}/"
    parts = console_parts(rec, xp)
    xh_cmds = crosshair_commands(xp)
    mouse = c.get("mouse") or {}
    video = c.get("video") or {}
    dpi = mouse.get("DPI", "")
    sens = rec["convars"].get("sensitivity", "")
    try:
        edpi = int(float(dpi) * float(sens))
    except (TypeError, ValueError):
        edpi = None
    hint = c.get("dpi_hint") if not dpi else None
    embed = json_script({"dpi": dpi, "sens": sens, "parts": [cmds for _, cmds in parts],
                         **({"dpi_assumed": hint["dpi"]} if hint else {})})
    current = players_by_slug.get(p.get("current_slug") or "")

    chips = ([f'<span class="chip"><b>{esc(p.get("team"))}</b> {esc(standing(year_obj, p).removeprefix(p.get("team") or "").lstrip(", "))}</span>']
             if roster else [f'<span class="chip"><b>#{p["rank"]}</b> {esc(year_obj["short"])}</span>'])
    if p.get("prize"):
        chips.append(f'<span class="chip">{esc(p["prize"])} in 2012</span>')
    if p.get("team") and not roster:
        chips.append(f'<span class="chip">{esc(p["team"])}</span>')
    chips.append(f'<span class="chip">config {esc(c.get("date") or "undated")}</span>')
    if p.get("photo"):
        chips.append(f'<a class="chip" href="#sources" title="Where the photo comes from">photo {esc(p["photo"].get("date") or "undated")}</a>')
    if dpi:
        chips.append(f'<span class="chip"><b>{esc(dpi)}</b> DPI</span>')
    for k in ("Resolution", "Aspect Ratio", "Scaling Mode"):
        if video.get(k):
            chips.append(f'<span class="chip">{esc(video[k])}</span>')
    links = []
    if current:
        links.append(f'<a href="/p/{esc(current["slug"])}/">current settings</a>')
    links.append(f'<a href="/classic/#y{key}">' + ("both lineups" if roster else f"all of {year}") + "</a>")

    game = config_game(c)
    era = (f"{esc(nick)} played CS 1.6 in {year}, so these are their {game} settings "
           if p.get("game") == "CS 1.6" else f"These are {esc(nick)}'s {game} settings ")
    when = classic_date_note(year_obj, c, kind_of(xp) in ("converted", "copied"))
    if roster and not in_lineup(year_obj, p):
        intro = f"{esc(p['standing'])}." + (f" {esc(p['lineup_note'])}" if p.get("lineup_note") else "")
    elif roster:
        mates = [q["nick"] for q in year_obj["players"]
                 if q.get("team") == p.get("team") and q["id"] != p["id"] and in_lineup(year_obj, q)]
        team_note = (year_obj.get("team_notes") or {}).get(p.get("team"))
        intro = (f"{esc(p.get('team'))} in {esc(year_obj.get('when'))}" + (f" ({esc(team_note)})" if team_note else "")
                 + (f", with {esc(', '.join(mates[:-1]))} and {esc(mates[-1])}" if len(mates) > 1 else "") + ".")
    else:
        intro = f'#{p["rank"]} in {esc(year_obj["ranking"])}' + (f" ({esc(p['team'])})" if p.get("team") else "") + "."
    source_note = f'{era}{when} (see <a href="#sources">where these settings come from</a>).'
    prov_items = "".join(
        f'''<li><b>{esc(pv["what"])}</b> · {esc(pv["date"])} · confidence {esc(pv["confidence"])} · {source_links(pv.get("sources"))}
          <details><summary>How the date is known</summary><p class="note">{esc(pv["date_basis"])}</p></details></li>'''
        for pv in c.get("provenance") or [])
    if hint:
        prov_items += (f'<li><b>DPI (assumed)</b> · {esc(hint["date"])} · {source_links([hint["source"]])}'
                       f'<details><summary>Why it is assumed</summary><p class="note">No source lists a DPI with this '
                       f'sensitivity, so the DPI matcher assumes the {esc(hint["dpi"])} DPI of their setup.gg profile, '
                       f'which lists sensitivity {esc(hint["sens"])}; change it on the page if you know better.</p></details></li>')
    if p.get("photo"):
        prov_items += f'<li><b>Photo</b> · {photo_credit_html(p["photo"])}</li>'
    sources_html = (f'''<section class="section" id="sources">
      <div class="section-head"><h2>Where these settings come from</h2></div>
      <ul class="provenance">{prov_items}</ul>
      <p class="note">{"No source lists a DPI with this sensitivity, so the DPI matcher's DPI is assumed (see above)." if hint else "DPI is only taken from a source that lists the same sensitivity, so the eDPI matches the sensitivity shown."} The other parts can come from configs of different dates, as listed.</p>
    </section>''' if prov_items else "")
    confidence = c.get("confidence") or "medium"
    original = "\n".join(f"{k} {v}" for k, v in (c.get("convars") or {}).items())
    all_sources = list(dict.fromkeys(u for pv in c.get("provenance") or [] for u in pv.get("sources") or [])) or c.get("sources")
    original_html = (f'''<section class="section">
      <div class="section-head"><h2>Original config <span class="tag">{esc(game)}</span></h2></div>
      <details class="raw"><summary>Show the documented {esc(game)} settings</summary>{cmd_block_raw(original)}</details>
      <p class="note">The settings as documented ({source_links(all_sources)}), before converting. Several of these convars don't exist in CS2, so use the commands above.</p>
    </section>''' if original else "")
    notes_html = f'<p class="note">{esc(c["notes"])}</p>' if c.get("notes") else ""
    head_copy = (f'<button type="button" class="btn" data-copy="{esc("; ".join(xh_cmds))}">Copy crosshair</button>'
                 if xh_cmds and len(xhair_chunks(xh_cmds)) == 1 else
                 '<a class="btn" href="#crosshair">Crosshair ↓</a>' if xh_cmds else "")
    cfg_href = f"/cfg/classic/{rec['slug']}.cfg"
    title = (f"{nick} ({standing(year_obj, p)}) {'CS:GO ' if game == 'CS:GO' else ''}Config Converted for CS2" if roster else
             f"{nick} {year} CS:GO Config Converted for CS2 — #{p['rank']} {year_obj['short']}")
    has = ([f"crosshair converted to the new crosshair system"] if xh_cmds else []) + (
        [f"{dpi} DPI x {sens} sens ({edpi} eDPI)"] if edpi else [f"sensitivity {sens}"] if sens else []) + (
        ["viewmodel"] if section_commands(rec).get("viewmodel") else [])
    # "and more" only when the config has commands beyond the ones named
    named = len(xh_cmds) + (1 if sens else 0) + len(section_commands(rec).get("viewmodel") or [])
    more = len(full_commands(rec, xp)) > named
    desc = (f"{nick}'s {game} settings from {c.get('date')} ({standing(year_obj, p)}"
            + (f", {p['team']}" if p.get("team") and not roster else "") + ") converted for CS2"
            + (": " + ", ".join(has) + (" and more as console commands." if more else ".") if has else "."))
    avatar_html = (avatar_img(rec["avatar"], 92, alt=photo_alt(p) if p.get("photo") else "") if rec.get("avatar")
                   else letter_div(nick))
    image = f"{BASE}/{rec['avatar']}" if rec.get("avatar") else f"{BASE}/assets/og-default.png"
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}">
  <link rel="canonical" href="{url}">
  <meta name="theme-color" content="#0d1014">
  <meta property="og:site_name" content="CS2 Pro Configs">
  <meta property="og:title" content="{esc(nick)} {esc(year_obj.get("when") if roster else year)} — classic CS:GO config for CS2">
  <meta property="og:description" content="{esc(desc)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{image}">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="{FAVICON}">
  <link rel="stylesheet" href="{asset_url('style.css')}">
</head>
<body data-page="player-static">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="logo" href="/">CS2<span class="dot">//</span>PROS <small>configs</small></a>
      <div class="spacer"></div>
      <a class="btn ghost small" href="/classic/">Classic</a>
      <a class="btn ghost small" href="/">All players</a>
    </div>
  </header>

  <main class="wrap" id="main">
    <nav aria-label="Breadcrumb"><a class="back" href="/classic/#y{key}">← Classic · {esc(label)}</a></nav>
    <div class="profile-head">
      {avatar_html}
      <div>
        <h1>{esc(nick)} <span class="h1-year">{esc(year_obj.get("h1") or year)}</span></h1>
        <div class="real">{esc(real)}</div>
        <div class="links">{"".join(links)}</div>
      </div>
    </div>
    <div class="chips profile-chips">{"".join(chips)}</div>
    <p class="note classic-note">{intro} {era}{when}{classic_other_dates(c)}. Source confidence: <b>{esc(confidence)}</b>.</p>
    {notes_html}
    <div class="head-actions">
      {head_copy}
      <a class="btn ghost" href="{cfg_href}" download="{esc(rec["slug"])}.cfg">Download .cfg</a>
      <a class="btn ghost" href="#full-config">Full config ↓</a>
    </div>
    {crosshair_section_html(rec, xp, reference, source_note=source_note)}
    {full_config_html(parts, cfg_href, rec["slug"])}
    {category_sections_html(rec)}
    {adapted_section_html(rec)}
    {video_tables_html(rec, launch_hint=False)}
    {sources_html}
    {original_html}
  </main>

  <footer>
    <div class="wrap">
      <p>{"Lineups" if roster else "Rankings"}: {esc(year_obj["ranking"])} ({source_links(year_obj.get("sources"))}) · Crosshair conversion by <a href="{esc(reference["url"])}" target="_blank" rel="noopener">{esc(reference["name"])}</a> (MIT) · Unofficial fan-made tool, not affiliated with Valve, HLTV or any player.</p>
    </div>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script type="application/json" id="player-data">{embed}</script>
  <script src="{asset_url('app.js')}"></script>
</body>
</html>
'''


def classic_index_page(classic, players_by_slug) -> str:
    sections = []
    for y in classic["years"]:
        cards = {}  # one grid per team for a lineup group, one for a ranking
        for p in y["players"]:
            c = p.get("config")
            current = players_by_slug.get(p.get("current_slug") or "")
            avatar = (avatar_img(p["photo"]["src"], 72, lazy=True, alt=photo_alt(p)) if p.get("photo") else
                      avatar_img(current["avatar"], 72, lazy=True) if current and current.get("avatar")
                      else letter_div(p["nick"]))
            if c:
                href = f"/classic/{gkey(y)}/{p['id']}/"
                sub = f'<span class="classic-date">config {esc(c.get("date") or "undated")}</span>'
            else:
                href = f"/p/{current['slug']}/" if current else None
                sub = '<span class="classic-date none">no CS:GO config documented</span>'
            short_team = (y.get("badges") or {}).get(p.get("team"), p.get("team") or "")
            badge = (f'<span class="top10-rank">{esc(short_team)}</span>' if is_roster(y) else
                     f'<span class="top10-rank{" medal" if p["rank"] <= 3 else ""}">#{p["rank"]}</span>')
            inner = (f'{badge}{avatar}<span class="top10-nick">{esc(p["nick"])}</span>'
                     f'<span class="top10-team">{esc(p.get("standing") or p.get("team") or "")}</span>{sub}')
            cards.setdefault(p.get("team") if is_roster(y) else "", []).append(
                f'<li class="top10-card"><a href="{href}">{inner}</a></li>' if href
                else f'<li class="top10-card"><div class="card-static">{inner}</div></li>')
        grids = "".join((f'<h3 class="classic-team">{esc(team)}</h3>' if team else "")
                        + f'<ol class="top10-grid">{"".join(items)}</ol>' for team, items in cards.items())
        sections.append(f'''<section class="top10 classic-year" id="y{gkey(y)}" aria-labelledby="y{gkey(y)}-title">
  <div class="top10-head">
    <h2 id="y{gkey(y)}-title">{esc(y.get("title") or y["year"])}</h2>
    <span class="top10-list">{esc(y["when"] if is_roster(y) else y["ranking"])}</span>
    <span class="top10-src">{source_links(y.get("sources"))}</span>
  </div>
  {f'<p class="top10-note">{esc(y["note"])}</p>' if y.get("note") else ""}
  {grids}
</section>''')
    years = [y["year"] for y in classic["years"] if not is_roster(y)]
    span = f"{min(years)}–{max(years)}"
    jump = " ".join(f'<a class="chip" href="#y{gkey(y)}">{esc(glabel(y))}</a>' for y in classic["years"])
    lineups = [f"{y['title']} in {y['when']}" for y in classic["years"] if is_roster(y)]
    plus = f", plus {' and '.join(lineups)}" if lineups else ""
    desc = (f"The top 10 Counter-Strike players of each year {span}{plus}, with their CS:GO settings converted for CS2: "
            "crosshair, sensitivity and viewmodel as copy-paste console commands.")
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classic CS:GO Pro Configs {span}, Converted for CS2 — Top 10 of Each Year</title>
  <meta name="description" content="{esc(desc)}">
  <link rel="canonical" href="{BASE}/classic/">
  <meta name="theme-color" content="#0d1014">
  <meta property="og:site_name" content="CS2 Pro Configs">
  <meta property="og:title" content="Classic pro configs {span}, converted for CS2">
  <meta property="og:description" content="{esc(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="{BASE}/classic/">
  <meta property="og:image" content="{BASE}/assets/og-default.png">
  <link rel="icon" href="{FAVICON}">
  <link rel="stylesheet" href="{asset_url('style.css')}">
</head>
<body data-page="plain">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="logo" href="/">CS2<span class="dot">//</span>PROS <small>configs</small></a>
      <div class="spacer"></div>
      <a class="btn ghost small" href="/">All players</a>
    </div>
  </header>
  <main class="wrap" id="main">
    <div class="hero">
      <h1>Classic configs<span class="dot">.</span> {span}</h1>
      <p>The top 10 players of each year from {span}{esc(plus)}, with their CS:GO settings converted for CS2: the crosshair converted to the
         new crosshair system, sensitivity, viewmodel and the rest as console commands. Each config is dated and sourced; when
         nothing from the exact time is documented (or it can't be converted), the closest one is used and its date shown.</p>
      <div class="chips classic-jump">{jump}</div>
      <p class="note">{esc(classic.get("about") or "")}</p>
    </div>
    {"".join(sections)}
    {classic_photo_credits_html(classic)}
  </main>
  <footer>
    <div class="wrap">
      <p>Crosshair conversion: community reconstruction (not checked against in-game captures). Unofficial fan-made tool, not affiliated with Valve, HLTV or any player.</p>
    </div>
  </footer>
</body>
</html>
'''


def classic_photo_credits_html(classic) -> str:
    """Attribution for every photo the cards above use (each page also credits its own)."""
    seen, items = set(), []
    for y in classic["years"]:
        for p in y["players"]:
            ph = p.get("photo")
            if ph and (p["nick"], ph["page"]) not in seen:
                seen.add((p["nick"], ph["page"]))
                items.append(f"<li><b>{esc(p['nick'])}</b> · {photo_credit_html(ph)}</li>")
    if not items:
        return ""
    return (f'<section class="section classic-credits" id="photo-credits"><details><summary>Photo credits '
            f'<span class="tag">{len(items)}</span></summary><ul class="provenance">{"".join(items)}</ul>'
            '<p class="note">Freely licensed photos from Wikimedia Commons, cropped to fit; the photo closest to each entry\'s time is used.</p>'
            '</details></section>')


def classic_teaser_html(classic) -> str:
    if not classic:
        return ""
    years = [y["year"] for y in classic["years"] if not is_roster(y)]
    span = f"{min(years)}–{max(years)}"
    chips = " ".join(f'<a class="chip" href="/classic/#y{gkey(y)}">{esc(glabel(y))}</a>' for y in classic["years"])
    lineups = [f"{y['title']} in {y['when']}" for y in classic["years"] if is_roster(y)]
    plus = f", plus {' and '.join(lineups)}," if lineups else ","
    return f'''<section class="classic-teaser" aria-labelledby="classic-teaser-title">
  <div><h2 id="classic-teaser-title">Classic configs · {span}</h2>
  <p>The top 10 players of each year from {span}{esc(plus)} their CS:GO settings converted for CS2.</p></div>
  <div class="chips">{chips}</div>
  <a class="btn ghost small" href="/classic/">Browse classic configs →</a>
</section>'''


def index_page(players, top10_data, generated, classic=None) -> str:
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
  <link rel="stylesheet" href="{asset_url('style.css')}">
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
    {classic_teaser_html(classic)}

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
  <script src="{asset_url('app.js')}"></script>
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
  <link rel="stylesheet" href="{asset_url('style.css')}">
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
    index = json.loads((ROOT / "data" / "index.json").read_text(encoding="utf-8"))
    players = index["players"]
    generated = index["meta"]["generated"]

    try:
        top10_data = json.loads((ROOT / "data" / "top10.json").read_text(encoding="utf-8"))
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

    try:
        classic = json.loads((ROOT / "data" / "classic.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        classic = None

    # current player -> their classic entries, for links from /p/<slug>/
    classic_of = {}
    for y in (classic or {}).get("years", []):
        for p in y["players"]:
            if p.get("config") and p.get("current_slug"):
                classic_of.setdefault(p["current_slug"], []).append((gkey(y), p["id"], standing(y, p)))

    emit(ROOT / "index.html", index_page(players, top10_data, generated, classic), f"{BASE}/", "1.0")
    print("index.html")

    n = 0
    for p in players:
        slug = p["slug"]
        f = ROOT / "data" / "players" / f"{slug}.json"
        if not f.exists():
            continue
        rec = json.loads(f.read_text(encoding="utf-8"))
        xp = crosshair["players"][slug]
        d = ROOT / "p" / slug
        d.mkdir(parents=True, exist_ok=True)
        emit(d / "index.html", player_page(rec, xp, crosshair["reference"], top10_rank.get(slug), classic_of.get(slug, ())),
             f"{BASE}/p/{slug}/", "0.8")
        write_if_changed(ROOT / "cfg" / f"{slug}.cfg", player_cfg(rec, xp))
        n += 1
    print(f"p/ pages and cfg/ files: {n}")

    if classic:
        players_by_slug = {p["slug"]: p for p in players}
        (ROOT / "classic").mkdir(exist_ok=True)
        (ROOT / "cfg" / "classic").mkdir(parents=True, exist_ok=True)
        emit(ROOT / "classic" / "index.html", classic_index_page(classic, players_by_slug), f"{BASE}/classic/", "0.9")
        m = 0
        for y in classic["years"]:
            for p in y["players"]:
                if not p.get("config"):
                    continue
                xp = crosshair.get("classic", {}).get(classic_key(y, p))
                if xp is None:
                    raise SystemExit(f"data/crosshair.json lacks classic {classic_key(y, p)}: "
                                     "run node scraper/crosshair.mjs first")
                rec = classic_rec(y, p, players_by_slug)
                d = ROOT / "classic" / gkey(y) / p["id"]
                d.mkdir(parents=True, exist_ok=True)
                emit(d / "index.html", classic_page(y, p, rec, xp, crosshair["reference"], players_by_slug),
                     f"{BASE}/classic/{gkey(y)}/{p['id']}/", "0.7")
                write_if_changed(ROOT / "cfg" / "classic" / f"{rec['slug']}.cfg", classic_cfg(rec, xp, y, p))
                m += 1
        print(f"classic pages: {m}")

    write_if_changed(ROOT / "player.html", redirect_stub())
    write_if_changed(ROOT / "404.html", not_found_page())
    write_if_changed(ROOT / "sitemap.xml", sitemap_xml(entries))
    write_if_changed(ROOT / "robots.txt", robots_txt())
    print("sitemap.xml robots.txt 404.html player.html")


if __name__ == "__main__":
    main()
