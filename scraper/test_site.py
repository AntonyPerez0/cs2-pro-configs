#!/usr/bin/env python3
"""Checks on the generated site, valid for whatever the weekly scrape returns.

Run after crosshair.mjs and sitegen.py (CI does, before committing a data
refresh). Exit code 1 on any failure. The conversion itself is pinned on fixed
inputs by test_crosshair.mjs.
"""

import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from sitegen import (LINE_LIMIT, chunk, console_parts, crosshair_section_html, full_commands,  # noqa: E402
                     json_script, player_cfg, res_key, safe_value)
from scrape import KEY_RE, image_ext  # noqa: E402

FAILS = []
N = 0


def check(name, got, want):
    global N
    N += 1
    if got != want:
        FAILS.append(f"{name}: got {got!r}, want {want!r}")


# crosshair cvars of the current game (build 2000922, unchanged through 2000930);
# mirrors CURRENT_CVARS in crosshair.mjs
CURRENT_XHAIR = set(re.findall(r"'(cl_crosshair\w*)'", re.search(
    r"CURRENT_CVARS = \[(.*?)\];", (HERE / "crosshair.mjs").read_text(), re.S).group(1)))

index = json.loads((ROOT / "data" / "index.json").read_text())
xh = json.loads((ROOT / "data" / "crosshair.json").read_text())
P = xh["players"]
records = {p["slug"]: json.loads((ROOT / "data" / "players" / f"{p['slug']}.json").read_text())
           for p in index["players"]}


def cmds(slug):
    return dict(c.split(" ", 1) for c in P[slug]["commands"])


# ---- converter output covers every player and uses only current cvars ----
check("every player converted", sorted(set(records) - set(P)), [])
# a player the converter can't handle gets a "can't be converted" note; only a
# broken converter (crosshair.mjs's own 10% limit) should stop the refresh
errors = sorted(s for s, p in P.items() if p.get("error"))
if errors:
    print(f"converter errors (shown on their pages as can't be converted): {errors}")
check("converter errors within crosshair.mjs's 10% limit", len(errors) <= len(P) / 10, True)
converted = [s for s, p in P.items() if p.get("kind") == "converted"]
vendored = (HERE / "vendor" / "small-indie-crosshair-company" / "VENDORED.md").read_text()
check("pinned reference commit matches the vendored copy", xh["reference"]["commit"] in vendored, True)
check("only current crosshair cvars",
      sorted({c.split(" ")[0] for p in P.values() for c in p.get("commands", [])} - CURRENT_XHAIR), [])
bad_height = []
for slug in converted:
    rec = records[slug]
    m = re.fullmatch(r"\s*\d+\s*x\s*(\d+)\s*", (rec.get("tables", {}).get("Video Settings", {}).get("Resolution") or ""))
    want = int(m.group(1)) if m and int(m.group(1)) >= 240 else 1080
    if cmds(slug).get("cl_crosshair_screen_height") != str(want) or P[slug]["commands"][-1].split(" ")[0] != "cl_crosshair_screen_height":
        bad_height.append(slug)
check("authored at the pro's own height, screen_height last", bad_height[:5], [])

# ---- conversion rules, on every converted player ----
outline_mismatch = [s for s in converted if ("cl_crosshairoutline_a" in cmds(s)) != (cmds(s).get("cl_crosshair_drawoutline", "0") != "0")]
check("outline colour set exactly when an outline is drawn", outline_mismatch[:5], [])
additive = [s for s in converted if records[s]["convars"].get("cl_crosshairusealpha") == "false"
            # the converter deliberately redraws an outline-only shape as black bars at the old 200
            and not any(w["code"] == "outline-only-as-core" for w in P[s].get("warnings", []))]
check("usealpha off -> opacity 255", sorted({cmds(s)["cl_crosshaircolor_a"] for s in additive} - {"255"}), [])
check("split-pip cvars only for style 2",
      sorted(s for s in converted if cmds(s)["cl_crosshairstyle"] != "2" and any(c.startswith("cl_crosshair_dynamic_") for c in P[s]["commands"])), [])

# ---- console line limit: every part and copy string fits ----
too_long = []
for slug, rec in records.items():
    for label, part in console_parts(rec, P[slug]):
        if len("; ".join(part)) > LINE_LIMIT:
            too_long.append((slug, label))
check("every full-config part fits one console line", too_long[:5], [])
check("chunk splits at the limit", [len(c) for c in chunk(["x" * 200] * 5)], [2, 2, 1])
try:
    chunk(["x" * (LINE_LIMIT + 1)])
    check("an over-long single command is an error", False, True)
except ValueError:
    check("an over-long single command is an error", True, True)

page_bad, cfg_bad = [], []
for slug, rec in records.items():
    page = (ROOT / "p" / slug / "index.html").read_text(encoding="utf-8")
    for value in re.findall(r'data-copy="([^"]*)"', page):
        if len(html.unescape(value)) > LINE_LIMIT:
            page_bad.append(slug)
    cfg = (ROOT / "cfg" / f"{slug}.cfg").read_text(encoding="utf-8")
    if ([l for l in cfg.splitlines() if l and not l.startswith("//")] != full_commands(rec, P[slug])
            or f"exec {slug}" not in cfg):
        cfg_bad.append(slug)
check("every copy button on every page fits one console line", sorted(set(page_bad))[:5], [])
check("downloadable .cfg is the converted config and names its exec command", cfg_bad[:5], [])

# a crosshair longer than one console line gets one copy button per piece
some = next(iter(records))
long_xp = {**P[some], "kind": "converted", "commands": [f"cl_crosshair_dynamic_splitdist {i:020d}" for i in range(20)]}
section = crosshair_section_html(records[some], long_xp, xh["reference"])
copies = [html.unescape(v) for v in re.findall(r'data-copy="([^"]*)"', section)]
check("long crosshair split into copy pieces that fit",
      (len(copies) > 1, all(len(c) <= LINE_LIMIT for c in copies), "; ".join(copies) == "; ".join(long_xp["commands"])),
      (True, True, True))

# ---- classic section (top 10 of 2011-2015), when present ----
classic_path = ROOT / "data" / "classic.json"
if classic_path.exists():
    from sitegen import classic_cfg, classic_rec  # noqa: E402
    classic = json.loads(classic_path.read_text())
    by_slug = {p["slug"]: p for p in index["players"]}
    XC = xh.get("classic", {})
    missing, bad_copy, bad_cfg, bad_link = [], [], [], []
    for y in classic["years"]:
        check(f"classic {y['year']}: 10 ranked players", sorted(p["rank"] for p in y["players"]), list(range(1, 11)))
        for p in y["players"]:
            if p.get("current_slug") and p["current_slug"] not in by_slug:
                bad_link.append(p["id"])
            if not p.get("config"):
                continue
            key = f"{y['year']}/{p['id']}"
            if key not in XC:
                missing.append(key)
                continue
            for field in ("date", "date_basis", "sources", "confidence"):
                if not p["config"].get(field):
                    missing.append(f"{key}:{field}")
            page = ROOT / "classic" / str(y["year"]) / p["id"] / "index.html"
            if not page.exists():
                missing.append(f"{key}:page")
                continue
            for value in re.findall(r'data-copy="([^"]*)"', page.read_text(encoding="utf-8")):
                if len(html.unescape(value)) > LINE_LIMIT:
                    bad_copy.append(key)
            rec = classic_rec(y["year"], p, by_slug)
            cfg = (ROOT / "cfg" / "classic" / f"{rec['slug']}.cfg").read_text(encoding="utf-8")
            if cfg != classic_cfg(rec, XC[key], y["year"], p):
                bad_cfg.append(key)
    check("classic: every config converted, dated, sourced and paged", missing[:5], [])
    check("classic: copy buttons fit one console line", sorted(set(bad_copy))[:5], [])
    check("classic: .cfg files are current", bad_cfg[:5], [])
    check("classic: links to current players resolve", bad_link[:5], [])
    pastes = [c for k, x in XC.items() for c in x.get("commands", [])]
    check("classic: only current crosshair cvars", sorted({c.split(" ")[0] for c in pastes} - CURRENT_XHAIR), [])

# ---- hardening helpers ----
s = json_script({"v": "a</script>b"})
check("json escapes </", "</script>" not in s, True)
check("escaped json parses identical", json.loads(s)["v"], "a</script>b")
check("key regex: convar ok, command string rejected",
      (bool(KEY_RE.match("sensitivity")), bool(KEY_RE.match("setting.defaultres")),
       bool(KEY_RE.match("say hi;bind mouse1 quit")), bool(KEY_RE.match(""))),
      (True, True, False, False))
check("safe_value drops injection, normalizes bools",
      (safe_value("7; quit"), safe_value('a"b'), safe_value("true"), safe_value("0.3")), (None, None, "1", "0.3"))
check("avatar type sniffing",
      (image_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 "), image_ext(b"\x89PNG\r\n\x1a\n...."),
       image_ext(b"\xff\xd8\xff\xe0"), image_ext(b"<html>")),
      ("webp", "png", "jpg", None))
check("resolution options sort by width then height",
      sorted(["1920x1080", "1280x960", "1280x720", "1280x1024", "800x600"], key=res_key),
      ["800x600", "1280x720", "1280x960", "1280x1024", "1920x1080"])

# ---- committed crosshair data matches the vendored converter ----
if shutil.which("node"):
    r = subprocess.run(["node", str(HERE / "crosshair.mjs"), "--check"], capture_output=True, text=True)
    check("data/crosshair.json is up to date", r.returncode, 0)

if FAILS:
    print(f"{len(FAILS)} failure(s) of {N} checks:")
    for f in FAILS:
        print("  FAIL", f)
    sys.exit(1)
print(f"all {N} checks passed")
