#!/usr/bin/env python3
"""
Best-effort weekly refresh of data/top10.json from HLTV's stats leaderboard.

HLTV sits behind aggressive Cloudflare protection and usually blocks
datacenter IPs (GitHub Actions runners included) with a 403. When that
happens this script exits 0 WITHOUT touching data/top10.json, so the
curated list (seeded from HLTV's official Top 20 of 2025) stays in place
until HLTV is reachable or the file is updated by hand.

On success it keeps the same JSON schema (listName notes the live source).
"""

import calendar
import json
from datetime import date, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
TOP10 = ROOT / "data" / "top10.json"
INDEX = ROOT / "data" / "index.json"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


def fetch(url: str):
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=25)
    except requests.RequestException:
        return None
    if r.status_code != 200 or "Just a moment" in r.text[:2000]:
        return None
    return r.content


def months_ago(d: date, months: int) -> date:
    m, y = d.month - months, d.year
    if m <= 0:
        m += 12
        y -= 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def hltv_top10() -> list | None:
    """Top 10 by rating over the last 3 months from HLTV's stats leaderboard."""
    end = date.today()
    url = (
        "https://www.hltv.org/stats/players?minMapCount=50"
        f"&startDate={months_ago(end, 3).isoformat()}&endDate={end.isoformat()}"
    )
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=25)
    except requests.RequestException:
        return None
    if r.status_code != 200 or "Just a moment" in r.text[:2000]:
        return None
    soup = BeautifulSoup(r.text, "lxml")
    table = soup.find("table", class_="stats-table")
    if not table:
        return None
    out = []
    for tr in table.find_all("tr"):
        a = tr.find("a", href=lambda h: h and "/stats/players/" in h)
        if not a:
            continue
        nick = a.get_text(strip=True)
        parts = a["href"].strip("/").split("/")
        player_id = parts[2] if len(parts) > 3 else ""
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        out.append({
            "rank": len(out) + 1,
            "nick": nick,
            "team": None,
            "slug": None,
            "hltv": f"https://www.hltv.org/stats/players/{player_id}/{nick.lower()}",
            "rating": cells[-1] if cells else None,
        })
        if len(out) >= 10:
            break
    return out or None


def main() -> None:
    players = hltv_top10()
    if not players:
        print("HLTV unreachable/blocked - keeping existing top10.json")
        return
    try:
        index = json.loads(INDEX.read_text())
        nick_to_slug = {p["nick"].lower(): p["slug"] for p in index["players"]}
        slug_by_lnick = {p["slug"].lower(): p["slug"] for p in index["players"]}
    except Exception:
        nick_to_slug, slug_by_lnick = {}, {}
    for t in players:
        t["slug"] = nick_to_slug.get(t["nick"].lower()) or (
            t["nick"].lower() if t["nick"].lower() in slug_by_lnick else None)
    today = date.today().isoformat()
    out = {
        "title": "HLTV Top 10 players",
        "listName": "HLTV stats leaderboard, last 3 months",
        "asOf": today,
        "retrieved": today,
        "sourceUrl": "https://www.hltv.org/stats/players?minMapCount=50",
        "note": "Auto-refreshed from HLTV's stats leaderboard (last 3 months by rating). HLTV publishes no official live player ranking.",
        "players": players,
    }
    TOP10.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(f"top10.json refreshed with {len(players)} players from HLTV")


if __name__ == "__main__":
    main()