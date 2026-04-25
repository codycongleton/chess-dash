#!/usr/bin/env python3
"""Fetch chess.com games for kxrook and write data/games.json.

Filters to rated games only. Preserves variant (chess vs chess960),
time class (rapid/blitz/bullet/daily), my rating, opponent rating, and a
human-readable outcome (win/loss/draw + reason: checkmate, resign, timeout,
stalemate, agreement, repetition, 50-move, insufficient, abandoned, ...).
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

USERNAME = "kxrook"
USER_AGENT = "chess-dash (github.com/codycongleton/chess-dash)"
ARCHIVES_URL = f"https://api.chess.com/pub/player/{USERNAME}/games/archives"
STATS_URL = f"https://api.chess.com/pub/player/{USERNAME}/stats"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_FILE = DATA_DIR / "games.json"
RATINGS_FILE = DATA_DIR / "ratings.json"

# stats-endpoint key -> (variant, time_class)
STATS_KEY_MAP = {
    "chess_daily":     ("chess",    "daily"),
    "chess_rapid":     ("chess",    "rapid"),
    "chess_blitz":     ("chess",    "blitz"),
    "chess_bullet":    ("chess",    "bullet"),
    "chess960_daily":  ("chess960", "daily"),
}

# Maps Chess.com per-side `result` codes to the ending reason.
# https://www.chess.com/news/view/published-data-api#pubapi-endpoint-games
REASON = {
    "checkmated": "checkmate",
    "resigned": "resignation",
    "timeout": "timeout",
    "stalemate": "stalemate",
    "agreed": "agreement",
    "repetition": "repetition",
    "50move": "50-move rule",
    "insufficient": "insufficient material",
    "timevsinsufficient": "timeout vs insufficient",
    "abandoned": "abandonment",
    "kingofthehill": "king of the hill",
    "threecheck": "three checks",
    "lose": "loss",
    "win": "win",
}


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def process_game(g: dict) -> dict | None:
    if not g.get("rated", False):
        return None

    white, black = g["white"], g["black"]
    me_is_white = white["username"].lower() == USERNAME.lower()
    me, opp = (white, black) if me_is_white else (black, white)

    me_result, opp_result = me["result"], opp["result"]
    if me_result == "win":
        outcome = "win"
        reason = REASON.get(opp_result, opp_result)
    elif opp_result == "win":
        outcome = "loss"
        reason = REASON.get(me_result, me_result)
    else:
        outcome = "draw"
        reason = REASON.get(me_result, me_result)

    return {
        "end_time": g.get("end_time"),
        "url": g.get("url"),
        "rules": g.get("rules"),               # "chess" | "chess960"
        "time_class": g.get("time_class"),     # rapid|blitz|bullet|daily
        "time_control": g.get("time_control"),
        "my_color": "white" if me_is_white else "black",
        "my_rating": me.get("rating"),
        "opp_rating": opp.get("rating"),
        "opp_username": opp.get("username"),
        "outcome": outcome,
        "reason": reason,
    }


def load_existing() -> tuple[dict[str, dict], set[str]]:
    """Return (games_by_url, archive_months_already_complete).

    A "complete" archive month is any month strictly before the current
    archive month — those are immutable, so we don't refetch them.
    """
    if not DATA_FILE.exists():
        return {}, set()
    data = json.loads(DATA_FILE.read_text())
    by_url = {g["url"]: g for g in data if g.get("url")}
    return by_url, set()


def main() -> int:
    print(f"Fetching archives list for {USERNAME}...", flush=True)
    archives = fetch_json(ARCHIVES_URL)["archives"]
    print(f"  {len(archives)} monthly archives", flush=True)

    by_url, _ = load_existing()
    if by_url:
        print(f"  starting from {len(by_url)} cached games", flush=True)

    # Re-fetch every archive. Old archives are immutable so the work is small;
    # we dedupe by URL, so re-fetching doesn't duplicate.
    # (Optimisation: skip archives older than the most recent cached game's
    # month. Worth doing once data set grows large.)
    new_count = 0
    for i, archive_url in enumerate(archives, 1):
        month = "/".join(archive_url.rsplit("/", 2)[-2:])
        try:
            data = fetch_json(archive_url)
        except urllib.error.HTTPError as e:
            print(f"  [{i}/{len(archives)}] {month} -> HTTP {e.code}, skipping", flush=True)
            continue

        added = 0
        for g in data.get("games", []):
            processed = process_game(g)
            if processed is None:
                continue
            url = processed["url"]
            if url in by_url:
                # Update in case rating recompute or reason changed (rare).
                by_url[url] = processed
            else:
                by_url[url] = processed
                added += 1
        new_count += added
        print(f"  [{i}/{len(archives)}] {month} (+{added} new)", flush=True)
        time.sleep(0.1)  # be polite to the API

    games = sorted(by_url.values(), key=lambda g: g.get("end_time") or 0)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(games, separators=(",", ":")))
    size_kb = DATA_FILE.stat().st_size / 1024
    print(
        f"\nWrote {len(games)} rated games ({new_count} new this run, "
        f"{size_kb:.1f} KB) to {DATA_FILE}"
    )

    write_ratings(games)
    return 0


def write_ratings(games: list[dict]) -> None:
    """Combine the stats endpoint with most-recent-game fallback for live chess960."""
    print("\nFetching stats...", flush=True)
    try:
        stats = fetch_json(STATS_URL)
    except urllib.error.HTTPError as e:
        print(f"  stats fetch failed (HTTP {e.code}); skipping ratings.json")
        return

    ratings: dict[str, dict[str, dict]] = {"chess": {}, "chess960": {}}
    for key, (variant, tc) in STATS_KEY_MAP.items():
        bucket = stats.get(key)
        if not bucket or "last" not in bucket:
            continue
        ratings[variant][tc] = {
            "current": bucket["last"].get("rating"),
            "best": bucket.get("best", {}).get("rating"),
            "last_played": bucket["last"].get("date"),
            "source": "stats",
        }

    # Fallback for buckets the stats endpoint doesn't expose (live chess960).
    seen = {(g["rules"], g["time_class"]) for g in games}
    for variant, tc in seen:
        if tc in ratings.get(variant, {}):
            continue
        sub = [g for g in games if g["rules"] == variant and g["time_class"] == tc]
        if not sub:
            continue
        latest = max(sub, key=lambda g: g.get("end_time") or 0)
        ratings.setdefault(variant, {})[tc] = {
            "current": latest.get("my_rating"),
            "best": max((g["my_rating"] for g in sub if g.get("my_rating")), default=None),
            "last_played": latest.get("end_time"),
            "source": "last_game",
        }

    payload = {"fetched_at": int(time.time()), "username": USERNAME, "ratings": ratings}
    RATINGS_FILE.write_text(json.dumps(payload, indent=2))
    n = sum(len(v) for v in ratings.values())
    print(f"Wrote {n} rating buckets to {RATINGS_FILE}")


if __name__ == "__main__":
    sys.exit(main())
