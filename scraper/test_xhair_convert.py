#!/usr/bin/env python3
"""Regression tests for the crosshair conversion (scraper/xhair_convert.py).

Expected values come from two sources:
- published post-patch pro settings (donk/m0NESY/s1mple -> length 2 /
  thickness 2 / gap 0) and the reference engine's corpus
- in-game behavior (thickness 0 renders nothing -> clamp to 1)

Exit code 1 on any failure. Runs in CI before sitegen.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xhair_convert import convert_crosshair, convert_geometry  # noqa: E402

FAILS = []
N = 0


def check(name, got, want):
    global N
    N += 1
    if got != want:
        FAILS.append(f"{name}: got {got!r}, want {want!r}")


def geo(size, th, gap):
    g = convert_geometry(size, th, gap)
    return (g["length"], g["thickness"], g["gap"])


def cmds(cv):
    c, _ = convert_crosshair(cv)
    return {k: v for k, v in c}


# ---- geometry (validated against the reference engine, build 2000914) ----
check("donk (1,1,-4) -> published 2/2/0", geo(1, 1, -4), (2, 2, 0))
check("gap -3 -> 2/2/1", geo(1, 1, -3), (2, 2, 1))
check("KSCERATO (2,1,-6) -> engine 4/1/0", geo(2, 1, -6), (4, 1, 0))
check("default (3.9,0.6,-2.2) -> 8/1/1", geo(3.9, 0.6, -2.2), (8, 1, 1))
check("big (30,2,0) -> 67/4/4", geo(30, 2, 0), (67, 4, 4))
check("jame dot design (0,0,-3) -> 0/0/0", geo(0, 0, -3), (0, 0, 0))

# ---- full conversion ----
base = {"cl_crosshairstyle": "4", "cl_crosshairsize": "1", "cl_crosshairthickness": "1",
        "cl_crosshairgap": "-4", "cl_crosshaircolor": "1", "cl_crosshairdot": "false",
        "cl_crosshair_t": "false", "cl_crosshair_drawoutline": "false",
        "cl_crosshair_recoil": "false", "cl_crosshairusealpha": "true",
        "cl_crosshairalpha": "255"}
d = cmds(base)
check("green preset -> legacy rgb",
      (d["cl_crosshaircolor_r"], d["cl_crosshaircolor_g"], d["cl_crosshaircolor_b"]),
      (50, 250, 50))
check("alpha enabled keeps value", d["cl_crosshaircolor_a"], 255)
check("true/false normalized to 0/1",
      (d["cl_crosshairdot"], d["cl_crosshair_t"], d["cl_crosshair_drawoutline"], d["cl_crosshair_recoil"]),
      (0, 0, 0, 0))
check("screen_height emitted last", list(d)[-1], "cl_crosshair_screen_height")

d = cmds({**base, "cl_crosshairusealpha": "false"})
check("alpha disabled -> 200", d["cl_crosshaircolor_a"], 200)

# woxic: legacy thickness 0 renders nothing in game -> clamped to 1
d = cmds({"cl_crosshairstyle": "4", "cl_crosshairsize": "3", "cl_crosshairthickness": "0",
          "cl_crosshairgap": "-1", "cl_crosshaircolor": "5", "cl_crosshairdot": "false",
          "cl_crosshairusealpha": "true", "cl_crosshairalpha": "200"})
check("woxic thickness clamp", d["cl_crosshair_thickness"], 1)
check("woxic length", d["cl_crosshair_length"], 6)

# jame: dot design, dot flag kept, thickness clamped
d = cmds({"cl_crosshairstyle": "4", "cl_crosshairsize": "0", "cl_crosshairthickness": "0",
          "cl_crosshairgap": "-3", "cl_crosshaircolor": "5", "cl_crosshairdot": "true",
          "cl_crosshairusealpha": "true", "cl_crosshairalpha": "255"})
check("jame dot on", d["cl_crosshairdot"], 1)
check("jame length 0", d["cl_crosshair_length"], 0)
check("jame thickness clamp", d["cl_crosshair_thickness"], 1)
check("jame gap", d["cl_crosshair_gap"], 0)

# ---- hardening helpers ----
from sitegen import json_script  # noqa: E402
s = json_script({"v": "a</script>b"})
check("json escapes </", "</script>" not in s, True)
check("escaped json parses identical", json.loads(s)["v"], "a</script>b")

from scrape import KEY_RE  # noqa: E402
check("key regex: convar ok, command string rejected",
      (bool(KEY_RE.match("sensitivity")), bool(KEY_RE.match("setting.defaultres")),
       bool(KEY_RE.match("say hi;bind mouse1 quit")), bool(KEY_RE.match(""))),
      (True, True, False, False))

if FAILS:
    print(f"{len(FAILS)} failure(s) of {N} checks:")
    for f in FAILS:
        print("  FAIL", f)
    sys.exit(1)
print(f"all {N} checks passed")