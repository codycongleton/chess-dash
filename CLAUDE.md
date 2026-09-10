# chess-dash — Claude context

Personal chess.com performance dashboard for **kxrook** (player_id 146392869, GitHub: codycongleton). Static HTML/JS site backed by JSON files refreshed by a GitHub Actions cron. Deployed via GitHub Pages.

## Stack

- `index.html` + `dashboard.js` + `style.css` — vanilla, no build step.
- Chart.js 4.x via CDN; `chartjs-adapter-date-fns` for time axes; `@sgratzl/chartjs-chart-boxplot` for monthly distribution.
- `scripts/fetch_games.py` — pulls Chess.com public API, writes `data/games.json` and `data/ratings.json`. Pure stdlib (`urllib`); no deps.
- `.github/workflows/refresh.yml` — runs the fetch nightly (06:17 UTC), commits diffs, pushes. `workflow_dispatch` for manual.
- Local preview: `python3 -m http.server 8765` from project root, then `http://localhost:8765/`.

## Hard rules (must hold across all charts/aggregations)

- **Username is `kxrook`** — set as `USERNAME` constant in `scripts/fetch_games.py`. If you change the player, update both that constant *and* the page title in `index.html`.
- **Rated games only.** `process_game()` drops anything with `rated !== true` at ingestion. Don't add UI filters that depend on unrated data — it's not in the dataset.
- **Variant separation is non-negotiable.** Standard (`rules: "chess"`) and Chess960 (`rules: "chess960"`) never share a chart series. The variant toggle in the header drives `currentVariant`; charts are filtered by it before rendering.
- **Friendly time-class labels only.** Use `time_class` (rapid / blitz / bullet / daily) for display, never raw `time_control` (e.g. `"600"`).
- **Outcome granularity preserved.** The "Outcomes" chart breaks results down by `reason` (checkmate, resignation, timeout, stalemate, agreement, repetition, 50-move, insufficient, abandonment, …) — don't collapse to W/L/D in that chart. The summary cards may collapse.
- **Pre-Nov 2025 history is filtered out** at render time via `START_DATE_MS` in `dashboard.js`. The 9 sparse 2021/2023 games stay in `games.json` (so the data stays complete and we can roll back the filter trivially) but never reach the charts.
- **Bullet games are excluded from every chart and the weekly table** (their rating sits far below blitz/rapid/daily and warps shared Y axes). They remain in the Current ratings cards. The exclusion happens once via `chartGames` in `render()`; chart functions don't need to know.

## Data schemas

`data/games.json` — array of objects, sorted by `end_time` ascending:

```json
{
  "end_time": 1777146630,        // unix seconds
  "url": "https://...",          // dedup key
  "rules": "chess",              // "chess" | "chess960"
  "time_class": "rapid",         // rapid | blitz | bullet | daily
  "time_control": "900+10",
  "my_color": "black",
  "my_rating": 893,              // rating GOING INTO this game (pre-game)
  "opp_rating": 863,
  "opp_username": "...",
  "outcome": "win",              // win | loss | draw
  "reason": "resignation"        // see process_game() in fetch_games.py
}
```

`data/ratings.json` — current ratings + best-ever, by variant × time-class:

```json
{
  "fetched_at": 1777149595,
  "username": "kxrook",
  "ratings": {
    "chess":    { "daily":{...}, "rapid":{...}, "blitz":{...}, "bullet":{...} },
    "chess960": { "daily":{...}, "blitz":{...} }
  }
}
```

Each bucket has `current`, `best`, `last_played`, and `source` (`"stats"` for the chess.com stats endpoint, `"last_game"` for fallback).

## Chess.com API quirks (don't re-discover these)

- **Stats endpoint is sparse for chess960.** `pub/player/{user}/stats` only exposes `chess960_daily` — no separate keys for live (rapid/blitz/bullet) chess960 even though those games are rated and appear in archives. `write_ratings()` falls back to "rating from most recent game in that bucket" for missing buckets.
- **`my_rating` is pre-game, not post-game.** It's the rating the player took *into* that game, not their rating after. Computing rating-after-game requires looking at the next game in the same `(rules, time_class)` bucket. Important when computing weekly Δ rating — the function uses "first game of next week" as the proxy for "rating at end of this week".
- **Rating change can be 0 even after a win** if the opponent is far below you. That's chess.com's Glicko-derived behavior, not a bug.
- **Old monthly archives are immutable.** `fetch_games.py` re-fetches every archive on each run for simplicity, deduping by `url`. With ~500 games and ~10 archives, that's < 1s of API calls. If the volume grows large, optimize by skipping archives older than the most recent cached game's month.

## Dashboard sections

0. **Losses banked** (very top) — progress toward `LOSS_GOAL` (500) total losses, on the theory that volume of losses drives improvement more than the occasional +10 Elo. Big total + progress bar + pace line (losses/week over the trailing `PACE_WINDOW_DAYS`, with a projected finish date), then one mini bar per game type, sorted descending and scaled to the largest type. **Ignores the variant toggle** (all variants stacked) and is rendered once at init. Bullet **is** included — a game count, not a rating.
0a. **Weekly loss target** — one bar per week over the last `TARGET_WEEKS` (26), measured from the `WEEKLY_LOSS_TARGET` (7) line instead of from zero, so the X axis *is* the target and bar direction reads as over / under. Y ticks step out from 0 (`stepSize: 5`, bounds excluded) and are offset back to real loss counts, so one always lands on the target. The target line itself is stroked by the local `targetLinePlugin` rather than styled as a gridline, so it holds up whatever ticks Chart.js generates for a given target. Green = target met, amber = short, faded = current week (still filling). Floor is pinned at 0 losses (`-WEEKLY_LOSS_TARGET`), ceiling is the best week's overshoot plus headroom. **Any game type** — all variants, all time classes, bullet included — and rendered once at init.
0b. **Average rating I lost to** — weekly mean `opp_rating` across losses, **rapid only** (`BEATEN_TIME_CLASS`), with the weekly mean of my own `my_rating` in those same games as a dashed second line; the gap between them is the point. Shares `TARGET_WEEKS` with the chart above so the X axes line up. Point radius scales with that week's loss count (tiny samples shouldn't look as solid as big ones). `spanGaps` is **off** — 12 of 26 weeks have no rapid losses, and bridging them would draw a trend across weeks with no games. Rapid is Standard-only in this dataset, so there's no variant to separate; rendered once at init.
1. **Current ratings** (top, always full set) — variant × time-class cards. Source: `ratings.json`.
2. **Variant-filtered summary** — total games, win/draw rate, white/black win rate.
2a. **Strikeline (Games per day)** — minimal sparkline of daily game count. Variant-filtered but **does not** drop bullet (it's a count of activity, not a rating chart). Reference scale shown in the header (max / avg per active day / total) and the X-axis bounds at the bottom.
2b. **Daily wins vs losses** — diverging daily bars, one row per (variant, time-class), sharing a single day domain (first game → today) so rows line up vertically. Wins go up from the zero line, losses down. **Ignores the variant toggle** (both variants stacked) and is rendered once at init. Y is symmetric and shared across all rows (`peak` = largest single-day win or loss count anywhere) so bar heights are comparable between game types. Bullet **is** included — the axis is a game count, not a rating, same reasoning as the strikeline. Draws aren't bar-encoded (only 19 of ~490 games); they appear in the tooltip and the row's `W · L · D` record.
3. **My rating over time** — line per time-class.
4. **Opponent rating over time** — scatter (per-game) + 20-game rolling average lines.
5. **Outcomes** — stacked bar of granular reasons.
6. **Win rate by time class** — horizontal stacked bar.
7. **Weekly rating distribution** — one boxplot chart per (variant, time-class), last `BOXPLOT_WEEKS` weeks (default 26). Min / Q1 / median / Q3 / max. **Ignores the variant toggle** — both Standard and Chess960 are shown stacked with section headers (`Standard` / `Chess960`). Rendered once at init, not on every variant flip.
8. **Weekly performance** — table, rolling 12 weeks Mon-start. Three rows per game type (games, win %, Δ rating). **Ignores the variant toggle** — both Standard and Chess960 are stacked with section divider rows. Rendered once at init.

## Common edits

- Add a new chart → register a `render*()` in `render()`, destroy with `destroyChart(key)` first, follow Chart.js patterns already used.
- Change the loss goal → `LOSS_GOAL` in `dashboard.js` (the `/ 500` label in `index.html` is hardcoded — update both).
- Change which time class the "lost to" chart covers → `BEATEN_TIME_CLASS` in `dashboard.js` (the `rapid` label in its header in `index.html` is hardcoded — update both).
- Change the weekly loss target or its window → `WEEKLY_LOSS_TARGET` / `TARGET_WEEKS` in `dashboard.js`. The card header reads the target from the constant (`#target-goal`); nothing in `index.html` hardcodes it.
- Change the loss-counter pace window → `PACE_WINDOW_DAYS` in `dashboard.js`.
- Add / reorder game-type rows → `GAME_TYPES` in `dashboard.js` (shared by the loss counter, the streak grid, and the diverge rows).
- Change rolling window for the weekly table → `for (let i = 11; i >= 0; i--)` in `renderWeekly`.
- Change rolling window for the weekly boxplots → `BOXPLOT_WEEKS` constant in `dashboard.js`.
- Change start-of-history filter → `START_DATE_MS` in `dashboard.js`.
- Adjust GitHub Action cron → `.github/workflows/refresh.yml` (cron is `17 6 * * *` = 06:17 UTC).
