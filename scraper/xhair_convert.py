#!/usr/bin/env python3
"""
Crosshair conversion: pre-Rush-Hour CS2 crosshair convars -> post-Sept-22-2026
convars, using the community reference model (small-indie-crosshair-company,
build 2000914) with its shipped defaults: structural inverse DEFAULT_PHI
(authored:trunc:thickness), all heights frozen at 1080.

Ported from lib/legacy.js, lib/quant/structural.js (DEFAULT_PHI path) and
lib/native-settings.js of that project; validated differentially against the
original JS engine on its 138-record corpus plus randomized inputs.
"""

import struct


# ---- f32 helpers (the JS model uses Math.fround at each step) ----

def fround(x):
    return struct.unpack("f", struct.pack("f", x))[0]


def trunc(x):
    return int(x)  # Python int() truncates toward zero like JS Math.trunc


def legacy_geometry(size, thickness, gap, height=1080):
    """Model legacy-static-kz-f32-v1 (lib/legacy.js)."""
    scale = fround(height / 480)
    length = trunc(fround(scale * fround(size)))
    width = max(1, trunc(fround(scale * fround(thickness))))
    gap_offset = trunc(fround(fround(gap) + fround(4)))
    near = (width // 2) + gap_offset
    return {"length": length, "width": width, "gapOffset": gap_offset, "near": near}


# ---- structural inverse, DEFAULT_PHI, ratios all 1 (1080/1080/1080) ----

def _best_integer(maxv, ideal, loss_fn):
    best = None  # (loss, tie, value)
    for v in range(0, maxv + 1):
        err = loss_fn(v)
        tie = abs(v - ideal)
        if best is None or err < best[0] or (err == best[0] and tie < best[1]):
            best = (err, tie, v)
    return {"value": best[2], "loss": best[0], "tie": best[1]}


def _solve_gap(near_t, far_t, width, has_length):
    # gapBase = thickness-half, gapScale = same-as-length (rG = 1), trunc
    base = width // 2
    center = (near_t + far_t - 1) / 2  # farDelta = 1 -> center == near_t
    ideal = (center - base) if has_length else 0

    def loss(v):
        if not has_length:
            return 0.0
        near = base + v
        return (near - near_t) ** 2 + (near + 1 - far_t) ** 2

    return _best_integer(128, ideal, loss)


def _invert_joint(target_width, near_t, far_t, has_length, preserve_zero):
    values = [0] if preserve_zero else range(0, 32)
    best = None
    for vt in values:
        width = max(1, vt)
        g = _solve_gap(near_t, far_t, width, has_length)
        ideal_t = 0 if preserve_zero else target_width
        t_loss = (width - target_width) ** 2
        t_tie = abs(vt - ideal_t)
        total = t_loss + g["loss"]
        pref = t_tie + g["tie"]
        if best is None or total < best[0] or (total == best[0] and pref < best[1]):
            best = (total, pref, vt, g["value"])
    return best[2], best[3]  # thickness, gap


def convert_geometry(size, thickness, gap):
    leg = legacy_geometry(size, thickness, gap, 1080)
    near_t, far_t = leg["near"], leg["near"] + 1
    length_new = max(0, min(255, trunc(leg["length"])))
    t_new, g_new = _invert_joint(leg["width"], near_t, far_t,
                                 leg["length"] > 0, thickness == 0)
    return {"length": length_new, "thickness": t_new, "gap": g_new,
            "authoredHeight": 1080, "gapClamped": leg["gapOffset"] < 0,
            "target": leg}


# ---- full convar conversion (mirrors the reference exporter) ----

PRESET_RGB = [
    (250, 50, 50),    # 0 red
    (50, 250, 50),    # 1 green
    (250, 250, 50),   # 2 yellow
    (50, 50, 250),    # 3 blue
    (50, 250, 250),   # 4 cyan
]


def _f(cv, k, d=None):
    try:
        return float(cv[k])
    except (KeyError, TypeError, ValueError):
        return d


def _b(v):
    return str(v).strip().lower() in ("1", "true")


def convert_crosshair(cv):
    """cv: dict of old convar name -> string value.

    Returns (commands, warnings): commands is a list of (name, value) tuples
    in emission order (screen_height last), warnings a list of strings.
    """
    commands = []
    warnings = []

    style = int(_f(cv, "cl_crosshairstyle", 4))
    commands.append(("cl_crosshairstyle", style))
    if style != 4:
        warnings.append(
            f"Style {style} was renumbered by the Sept 2026 patch (4 = Static Cross). "
            "Non-static styles may need a manual pick in Settings -> Crosshair/Scopes.")

    has_size = "cl_crosshairsize" in cv
    has_th = "cl_crosshairthickness" in cv
    has_gap = "cl_crosshairgap" in cv
    legacy_dot_on = _b(cv.get("cl_crosshairdot", "false"))
    forced_dot = False
    if has_size or has_th or has_gap:
        geo = convert_geometry(
            _f(cv, "cl_crosshairsize", 0.0),
            _f(cv, "cl_crosshairthickness", 0.0),
            _f(cv, "cl_crosshairgap", 0.0))
        if has_size:
            commands.append(("cl_crosshair_length", geo["length"]))
        if has_th:
            # New system renders thickness 0 as NOTHING (confirmed in-game:
            # woxic bars, Jame dot). Legacy thickness 0 rendered as 1px, so
            # clamp to >= 1 - the thinnest visible new-system setting.
            t_new = max(1, geo["thickness"])
            commands.append(("cl_crosshair_thickness", t_new))
        if has_gap:
            if geo["gapClamped"]:
                warnings.append(
                    "Old gap put the lines past the center - the new gap can't go below 0, "
                    "so the closest possible look is used.")
            commands.append(("cl_crosshair_gap", geo["gap"]))
        if geo["length"] == 0 and not legacy_dot_on:
            forced_dot = True
            warnings.append(
                "Dot-only crosshair: the arms are zero-length, so the center dot is enabled "
                "(a zero-length crosshair without a dot renders nothing in the new system).")

    for k in ("cl_crosshairdot", "cl_crosshair_t",
              "cl_crosshair_drawoutline", "cl_crosshair_recoil"):
        if k == "cl_crosshairdot":
            commands.append((k, 1 if (forced_dot or legacy_dot_on) else 0))
        elif k in cv:
            commands.append((k, 1 if _b(cv[k]) else 0))

    # color: legacy presets resolve to their mapped RGB; 5 = custom RGB
    if "cl_crosshaircolor" in cv:
        idx = int(_f(cv, "cl_crosshaircolor", 5))
        if idx == 5:
            rgb = tuple(int(max(0, min(255, round(_f(cv, f"cl_crosshaircolor_{c}", 255)))))
                        for c in "rgb")
        elif 0 <= idx <= 4:
            rgb = PRESET_RGB[idx]
        else:
            rgb = None
    elif "cl_crosshaircolor_r" in cv:
        rgb = tuple(int(max(0, min(255, round(_f(cv, f"cl_crosshaircolor_{c}", 255)))))
                    for c in "rgb")
    else:
        rgb = None
    if rgb is not None:
        commands.append(("cl_crosshaircolor_r", rgb[0]))
        commands.append(("cl_crosshaircolor_g", rgb[1]))
        commands.append(("cl_crosshaircolor_b", rgb[2]))

    # alpha: usealpha enabled -> its value; disabled -> 200 (reference reconstruction)
    if "cl_crosshairalpha" in cv or "cl_crosshairusealpha" in cv:
        enabled = _b(cv.get("cl_crosshairusealpha", "false"))
        alpha = int(max(0, min(255, round(_f(cv, "cl_crosshairalpha", 200))))) if enabled else 200
        commands.append(("cl_crosshaircolor_a", alpha))
        if not enabled:
            warnings.append(
                "Old config had the alpha slider disabled; opacity is reconstructed as 200 "
                "(the new system changed how alpha works).")

    for k, v in cv.items():
        if k.startswith("cl_crosshair_dynamic_") or k == "cl_crosshair_sniper_width":
            commands.append((k, v))

    commands.append(("cl_crosshair_screen_height", 1080))
    return commands, warnings
