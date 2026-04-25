---
name: refresh-games
description: Fetch the latest chess.com games and ratings for kxrook, updating data/games.json and data/ratings.json. Use when the user wants fresh data locally before pushing or previewing — for example "pull new games", "refresh data", "update games.json", "sync chess.com data".
---

Run the fetch script from the project root:

```sh
python3 scripts/fetch_games.py
```

It is idempotent — re-fetches every monthly archive, dedupes by game URL, and writes:

- `data/games.json` (full rated game history, filtered to `rated === true`)
- `data/ratings.json` (current ratings per variant × time-class, with best-ever)

After it finishes, report:
- Total games and "+N new this run" count
- Whether `data/games.json` or `data/ratings.json` actually changed (use `git diff --stat data/`)

If the user wants the changes deployed, commit and push:

```sh
git add data/
git commit -m "data: refresh games.json"
git push
```

Don't push without asking — the GitHub Action already runs nightly, so a manual push is only needed if the user wants to see new data on the live site immediately.
