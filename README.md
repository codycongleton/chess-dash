# chess-dash

A static dashboard of [kxrook](https://www.chess.com/member/kxrook)'s chess.com performance over time.

Live: <https://codycongleton.github.io/chess-dash/>

## How it works

- `scripts/fetch_games.py` pulls every monthly archive from the Chess.com public API, filters to **rated** games only, and writes a normalized `data/games.json` with variant (chess vs chess960), time class (rapid/blitz/bullet/daily), my rating, opponent rating, outcome (win/loss/draw), and ending reason (checkmate, resignation, timeout, stalemate, agreement, ...).
- `index.html` + `dashboard.js` render charts via Chart.js — no build step, no backend.
- `.github/workflows/refresh.yml` re-runs the fetch nightly and commits if `games.json` changed. GitHub Pages serves the static site.

## Local preview

```sh
python3 scripts/fetch_games.py        # populates data/games.json
python3 -m http.server 8765            # then open http://localhost:8765
```
