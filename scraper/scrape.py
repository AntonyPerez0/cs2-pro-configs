#!/usr/bin/env python3
"""
Scrape CS2 pro settings from settings.gg into a static JSON/cfg dataset
for the cs2-pro-configs website.

Outputs (repo root):
  data/index.json            - player list for the grid/search
  data/players/<slug>.json   - full record per player
  data/avatars/<slug>.<ext>  - player avatar (extension from the image bytes)
  cfg/raw/<slug>.cfg         - full autoexec.cfg (verbatim from settings.gg, pre-patch format;
                               sitegen.py writes the converted cfg/<slug>.cfg)

Usage:
  python3 scrape.py [--limit N] [--workers 6] [--delay 0.12]
"""

import argparse
import io
import json
import random
import re
import sys
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE = "https://settings.gg"
UA = (
    "cs2-pro-configs/1.0 (+https://github.com/AntonyPerez0/cs2-pro-configs; "
    "public settings aggregator, python-requests)"
)

ROOT = Path(__file__).resolve().parent.parent

session_local = threading.local()


def get_session() -> requests.Session:
    if not hasattr(session_local, "s"):
        s = requests.Session()
        s.headers.update({"User-Agent": UA, "Accept-Language": "en"})
        session_local.s = s
    return session_local.s


class RateLimiter:
    """Global min-interval limiter with jitter, shared across threads."""

    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self):
        with self._lock:
            now = time.monotonic()
            wait = self._next - now
            if wait > 0:
                time.sleep(wait)
                now = time.monotonic()
            self._next = max(now, self._next) + self.min_interval


limiter = RateLimiter(0.12)


def fetch(url: str, tries: int = 4) -> requests.Response:
    last_exc = None
    for attempt in range(1, tries + 1):
        limiter.wait()
        try:
            r = get_session().get(url, timeout=30)
        except requests.RequestException as e:
            last_exc = e
            time.sleep(2 * attempt)
            continue
        if r.status_code == 200:
            # requests falls back to Latin-1 for text/html without a charset,
            # which turned "Nový" into "NovÃ½"; the site serves UTF-8
            if "charset" not in r.headers.get("content-type", "").lower():
                r.encoding = "utf-8"
            return r
        if r.status_code in (429, 502, 503):
            time.sleep(4 * attempt + random.random() * 2)
            continue
        if r.status_code in (403, 501) and "cloudflare" in r.headers.get("server", "").lower():
            # possible challenge - back off hard, retry slowly
            time.sleep(10 * attempt)
            continue
        if r.status_code == 404:
            return r
        last_exc = requests.RequestException(f"HTTP {r.status_code}")
        time.sleep(2 * attempt)
    raise last_exc or requests.RequestException("fetch failed")


# --------------------------------------------------------------------------
# index page -> player list
# --------------------------------------------------------------------------

def get_player_list():
    r = fetch(f"{BASE}/players")
    soup = BeautifulSoup(r.text, "lxml")
    players = []
    seen = set()
    for a in soup.find_all("a", href=re.compile(r"^/players/[a-z0-9_-]+$")):
        slug = a["href"].rsplit("/", 1)[1]
        if slug in seen:
            continue
        seen.add(slug)
        nick = a.find("h2")
        img = a.find("img")
        players.append(
            {
                "slug": slug,
                "nick": demojibake(nick.get_text(strip=True)) if nick else slug,
                "avatar_url": img["src"] if img and img.has_attr("src") else None,
            }
        )
    return players


# --------------------------------------------------------------------------
# profile page parsing
# --------------------------------------------------------------------------

def demojibake(s):
    """UTF-8 text that was decoded as Latin-1 ("NovÃ½") back to what it was
    ("Nový"). Anything else, real Latin-1 text like "é" included, is returned
    unchanged: it isn't valid UTF-8 once encoded back."""
    if not s:
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


CROSSHAIR_RE = re.compile(r"(CSGO-[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4})")
STEAMID_RE = re.compile(r"procrosshairs\.com/player/(\d+)/")
CONVAR_LINE_RE = re.compile(r'^"([^"]+)"\s*"([^"]*)"\s*$')
# convar keys only: "say hi;bind mouse1 quit" "1" parses but is not a convar -
# such keys join the ";"-joined paste block and would run as commands
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


def parse_profile(html: str, slug: str) -> dict:
    soup = BeautifulSoup(html, "lxml")

    rec = {"slug": slug}
    h1 = soup.find("h1")
    rec["nick"] = demojibake(h1.get_text(strip=True)) if h1 else slug

    rec["real_name"] = None
    hdr = h1.find_parent("div") if h1 else None
    if hdr:
        d = hdr.find("div", class_=re.compile(r"text-zinc-500"))
        if d:
            rec["real_name"] = demojibake(d.get_text(strip=True))

    m = CROSSHAIR_RE.search(html)
    rec["crosshair_code"] = m.group(1) if m else None

    m = STEAMID_RE.search(html)
    rec["steamid64"] = m.group(1) if m else None

    # launch options: find heading then sibling paragraph
    rec["launch_options"] = None
    for h3 in soup.find_all("h3"):
        if h3.get_text(strip=True).lower() == "launch options":
            p = h3.find_next("p")
            if p:
                txt = p.get_text(strip=True)
                rec["launch_options"] = None if txt == "-" else txt
            break

    # tables (mouse / video settings / advanced video)
    rec["tables"] = {}
    for table in soup.find_all("table"):
        cap = table.find("caption")
        if not cap:
            continue
        name = cap.get_text(strip=True)
        rows = {}
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) >= 2:
                k = tds[0].get_text(strip=True)
                v = tds[1].get_text(strip=True)
                if k:
                    rows[k] = v
        if rows:
            rec["tables"][name] = rows

    return rec


# --------------------------------------------------------------------------
# config zip parsing
# --------------------------------------------------------------------------

def parse_config_zip(content: bytes) -> dict:
    """Return {convar: value} from the autoexec.cfg inside config.zip."""
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        name = next(n for n in z.namelist() if n.endswith(".cfg"))
        text = z.read(name).decode("utf-8", errors="replace")
    convars = {}
    for line in text.splitlines():
        line = line.strip()
        m = CONVAR_LINE_RE.match(line)
        if m and KEY_RE.match(m.group(1)):
            convars[m.group(1)] = m.group(2)
    return convars, text


# --------------------------------------------------------------------------
# scrape one player
# --------------------------------------------------------------------------

def scrape_player(entry: dict) -> dict:
    slug = entry["slug"]
    rec = dict(entry)

    pr = fetch(f"{BASE}/players/{slug}")
    if pr.status_code != 200:
        raise RuntimeError(f"profile HTTP {pr.status_code}")
    rec.update(parse_profile(pr.text, slug))

    # a missing or unreadable config fails the player, so main() keeps last
    # week's record instead of replacing it with an empty one
    cr = fetch(f"{BASE}/api/download/{slug}")
    if cr.status_code != 200:
        raise RuntimeError(f"config HTTP {cr.status_code}")
    try:
        convars, raw_cfg = parse_config_zip(cr.content)
    except Exception as e:
        raise RuntimeError(f"config unreadable: {e}") from e
    rec["convars"] = convars
    rec["raw_cfg"] = raw_cfg

    # avatar (downloaded once; kept on later runs)
    existing = avatar_file(slug)
    if existing:
        rec["avatar"] = existing.relative_to(ROOT).as_posix()
    elif entry.get("avatar_url"):
        try:
            ar = fetch(entry["avatar_url"])
            ext = image_ext(ar.content) if ar.status_code == 200 else None
            if ext:
                path = ROOT / "data" / "avatars" / f"{slug}.{ext}"
                path.write_bytes(ar.content)
                rec["avatar"] = path.relative_to(ROOT).as_posix()
        except Exception:
            pass

    return rec


AVATAR_EXTS = ("webp", "png", "jpg")


def image_ext(b: bytes):
    """File extension matching the image bytes (settings.gg serves WebP), so
    the file is served with the right Content-Type. None if not an image."""
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:3] == b"\xff\xd8\xff":
        return "jpg"
    return None


def avatar_file(slug: str):
    for ext in AVATAR_EXTS:
        p = ROOT / "data" / "avatars" / f"{slug}.{ext}"
        if p.exists():
            return p
    return None


def previous_record(slug: str):
    """Last committed record for a player, used when this run's scrape of
    them fails, so a transient error doesn't drop them from the site."""
    try:
        return json.loads((ROOT / "data" / "players" / f"{slug}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def edpi(rec: dict):
    mouse = rec.get("tables", {}).get("Mouse", {})
    dpi = mouse.get("DPI")
    sens = mouse.get("Mouse Sensitivity")
    try:
        return int(float(dpi) * float(sens))
    except (TypeError, ValueError):
        return None


def res_label(rec: dict) -> str | None:
    v = rec.get("tables", {}).get("Video Settings", {}).get("Resolution")
    if v and "x" in v and v.split("x")[0].strip().isdigit():
        return v
    cv = rec.get("convars", {})
    w, h = cv.get("setting.defaultres"), cv.get("setting.defaultresheight")
    if w and h and str(w).strip().isdigit() and str(h).strip().isdigit():
        return f"{w}x{h}"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="scrape only first N players")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--delay", type=float, default=0.12, help="min seconds between requests")
    args = ap.parse_args()

    global limiter
    limiter = RateLimiter(args.delay)

    print("[1/3] fetching player index ...", flush=True)
    players = get_player_list()
    print(f"      {len(players)} players found", flush=True)
    if args.limit:
        players = players[: args.limit]
    else:
        # a markup change on settings.gg can silently return a fraction of
        # the list; refuse to overwrite the dataset with it
        try:
            prev_count = json.loads((ROOT / "data" / "index.json").read_text())["meta"]["count"]
        except (OSError, ValueError, KeyError):
            prev_count = 0
        if len(players) < prev_count * 0.8:
            print(f"      only {len(players)} players vs {prev_count} last run - aborting", flush=True)
            sys.exit(1)

    results, failures = {}, []
    done = 0
    print(f"[2/3] scraping {len(players)} profiles ({args.workers} workers) ...", flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(scrape_player, p): p["slug"] for p in players}
        for fut in as_completed(futs):
            slug = futs[fut]
            try:
                results[slug] = fut.result()
            except Exception as e:
                failures.append((slug, str(e)))
                prev = previous_record(slug)
                if prev:
                    results[slug] = prev  # its cfg/raw/<slug>.cfg is left as-is
            done += 1
            if done % 25 == 0 or done == len(players):
                print(f"      {done}/{len(players)} done ({len(failures)} failed)", flush=True)

    # source order (settings.gg lists most recently updated first) - this is
    # the site's "Recently updated" sort; completion order is random
    results = [results[p["slug"]] for p in players if p["slug"] in results]

    (ROOT / "data" / "players").mkdir(parents=True, exist_ok=True)
    (ROOT / "cfg" / "raw").mkdir(parents=True, exist_ok=True)

    index = []
    for rec in results:
        slug = rec["slug"]
        cv = rec.get("convars") or {}
        index.append(
            {
                "slug": slug,
                "nick": rec.get("nick") or slug,
                "real_name": rec.get("real_name"),
                "crosshair_code": rec.get("crosshair_code"),
                "dpi": (rec.get("tables", {}).get("Mouse", {}).get("DPI")),
                "sens": (rec.get("tables", {}).get("Mouse", {}).get("Mouse Sensitivity")),
                "edpi": edpi(rec),
                "res": res_label(rec),
                "avatar": rec.get("avatar"),
            }
        )
        slim = {k: v for k, v in rec.items() if k != "raw_cfg"}
        (ROOT / "data" / "players" / f"{slug}.json").write_text(
            json.dumps(slim, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        if rec.get("raw_cfg"):
            (ROOT / "cfg" / "raw" / f"{slug}.cfg").write_text(rec["raw_cfg"], encoding="utf-8")

    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    meta = {"generated": stamp, "source": "https://settings.gg/players", "count": len(results)}
    (ROOT / "data" / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (ROOT / "data" / "index.json").write_text(
        json.dumps({"meta": meta, "players": index}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"[3/3] wrote {len(results)} players -> data/, cfg/raw/", flush=True)
    if failures:
        print(f"      failures ({len(failures)}):", flush=True)
        for slug, err in failures[:20]:
            print(f"        {slug}: {err}", flush=True)
        sys.exit(1 if len(failures) > len(players) // 4 else 0)


if __name__ == "__main__":
    main()