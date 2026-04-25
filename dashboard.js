"use strict";

const START_DATE_MS = Date.UTC(2025, 10, 1); // Nov 1 2025 — drop sparse pre-Nov-2025 history
const TIME_CLASSES = ["bullet", "blitz", "rapid", "daily"];
const TIME_CLASS_COLORS = {
    bullet: "#bb9af7",
    blitz:  "#7aa2f7",
    rapid:  "#9ece6a",
    daily:  "#e0af68",
};
const REASON_ORDER = [
    "checkmate", "resignation", "timeout", "timeout vs insufficient",
    "stalemate", "repetition", "agreement", "50-move rule",
    "insufficient material", "abandonment",
];
const OUTCOME_COLORS = {
    win:  getCss("--win"),
    loss: getCss("--loss"),
    draw: getCss("--draw"),
};

function getCss(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

let allGames = [];
let ratingsData = null;
let currentVariant = "chess";
let charts = {};

async function init() {
    const [gamesRes, ratingsRes] = await Promise.all([
        fetch("data/games.json", { cache: "no-cache" }),
        fetch("data/ratings.json", { cache: "no-cache" }).catch(() => null),
    ]);
    const raw = await gamesRes.json();
    allGames = raw.filter(g => g.end_time * 1000 >= START_DATE_MS);
    if (ratingsRes && ratingsRes.ok) {
        ratingsData = await ratingsRes.json();
    }

    document.querySelectorAll(".variant-toggle button").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".variant-toggle button").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentVariant = btn.dataset.variant;
            render();
        });
    });

    setMeta();
    renderCurrentRatings();
    render();
}

function renderCurrentRatings() {
    const root = document.getElementById("ratings");
    root.innerHTML = "";
    const variants = [
        { rules: "chess",    label: "Standard" },
        { rules: "chess960", label: "Chess960" },
    ];
    const r = ratingsData?.ratings || {};
    for (const { rules, label } of variants) {
        for (const tc of TIME_CLASSES) {
            const sub = allGames.filter(g => g.rules === rules && g.time_class === tc);
            if (sub.length === 0) continue;

            const bucket = r[rules]?.[tc];
            const current = bucket?.current ?? sub[sub.length - 1].my_rating;
            const best = bucket?.best;
            const delta = current - sub[0].my_rating;
            const card = makeStat(`${label} · ${tc}`, current, delta);
            if (best != null) {
                const sub_ = document.createElement("div");
                sub_.className = "label sub";
                sub_.textContent = `best ${best}`;
                card.append(sub_);
            }
            root.append(card);
        }
    }
    if (root.children.length === 0) {
        root.innerHTML = `<div class="stat"><div class="label">No rated games yet</div></div>`;
    }
}

function setMeta() {
    const last = allGames[allGames.length - 1];
    if (!last) return;
    const when = new Date(last.end_time * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    document.getElementById("meta").textContent = `${allGames.length} rated games · last played ${when}`;
}

function render() {
    const games = allGames.filter(g => g.rules === currentVariant);
    // Bullet is hidden in charts (rating range too far from blitz/rapid/daily
    // to be useful on shared axes) but kept in the Current ratings cards.
    const chartGames = games.filter(g => g.time_class !== "bullet");
    renderSummary(games);
    renderRating(chartGames);
    renderOpponent(chartGames);
    renderOutcome(chartGames);
    renderWinrate(chartGames);
    renderBoxplot(chartGames);
    renderWeekly(chartGames);
}

const BOXPLOT_WEEKS = 26;

function renderBoxplot(games) {
    // Tear down any prior per-time-class charts.
    for (const tc of TIME_CLASSES) destroyChart(`boxplot-${tc}`);

    const root = document.getElementById("boxplotGrid");
    root.innerHTML = "";

    if (games.length === 0) {
        root.innerHTML = `<p class="hint">No games for this variant.</p>`;
        return;
    }

    const thisMonday = startOfWeek(new Date());
    const weeks = [];
    for (let i = BOXPLOT_WEEKS - 1; i >= 0; i--) {
        const d = new Date(thisMonday);
        d.setDate(d.getDate() - i * 7);
        weeks.push(d);
    }
    const labels = weeks.map(d =>
        d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    );

    const presentTCs = TIME_CLASSES.filter(tc => games.some(g => g.time_class === tc));
    const variantLabel = currentVariant === "chess960" ? "Chess960" : "Standard";

    for (const tc of presentTCs) {
        const sub = games.filter(g => g.time_class === tc);

        const perWeek = weeks.map(wStart => {
            const wEndMs = wStart.getTime() + 7 * 24 * 60 * 60 * 1000;
            return sub
                .filter(g => {
                    const t = g.end_time * 1000;
                    return t >= wStart.getTime() && t < wEndMs;
                })
                .map(g => g.my_rating)
                .filter(r => typeof r === "number");
        });

        const cell = document.createElement("div");
        cell.className = "boxplot-cell";
        cell.innerHTML = `
            <h3>${variantLabel} · ${tc}</h3>
            <div class="chart-wrap"><canvas></canvas></div>
        `;
        root.appendChild(cell);

        const ctx = cell.querySelector("canvas");
        charts[`boxplot-${tc}`] = new Chart(ctx, {
            type: "boxplot",
            data: {
                labels,
                datasets: [{
                    label: tc,
                    data: perWeek,
                    backgroundColor: TIME_CLASS_COLORS[tc] + "55",
                    borderColor: TIME_CLASS_COLORS[tc],
                    borderWidth: 1.5,
                    outlierBackgroundColor: TIME_CLASS_COLORS[tc],
                    outlierRadius: 2,
                    itemRadius: 0,
                    medianColor: getCss("--text"),
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (item) => {
                                const v = item.parsed;
                                if (!v) return "";
                                return [
                                    `max: ${Math.round(v.max)}`,
                                    `Q3:  ${Math.round(v.q3)}`,
                                    `med: ${Math.round(v.median)}`,
                                    `Q1:  ${Math.round(v.q1)}`,
                                    `min: ${Math.round(v.min)}`,
                                    `n:   ${v.items?.length ?? "—"}`,
                                ];
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: {
                            color: getCss("--muted"),
                            maxRotation: 0,
                            autoSkip: true,
                            autoSkipPadding: 8,
                        },
                        grid: { color: getCss("--border") },
                    },
                    y: {
                        beginAtZero: false,
                        grace: "8%",
                        ticks: { color: getCss("--muted") },
                        grid: { color: getCss("--border") },
                        title: { display: true, text: "My rating", color: getCss("--muted") },
                    },
                },
            },
        });
    }
}

function startOfWeek(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    const day = out.getDay();              // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day; // shift to Monday
    out.setDate(out.getDate() + diff);
    return out;
}

function renderWeekly(games) {
    const root = document.getElementById("weeklyTable");
    if (!games.length) {
        root.innerHTML = `<p class="hint">No games for this variant.</p>`;
        return;
    }

    const thisMonday = startOfWeek(new Date());
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(thisMonday);
        d.setDate(d.getDate() - i * 7);
        weeks.push(d);
    }

    const presentTCs = TIME_CLASSES.filter(tc => games.some(g => g.time_class === tc));
    const variantLabel = currentVariant === "chess960" ? "Chess960" : "Standard";
    const ratingsForVariant = ratingsData?.ratings?.[currentVariant] || {};

    let html = `<div class="table-scroll"><table class="weekly"><thead><tr>
        <th class="row-label">Game type</th>
        <th class="metric">Metric</th>`;
    for (const w of weeks) {
        const label = w.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        html += `<th>${label}</th>`;
    }
    html += `</tr></thead><tbody>`;

    for (const tc of presentTCs) {
        const sub = games
            .filter(g => g.time_class === tc)
            .slice()
            .sort((a, b) => a.end_time - b.end_time);

        const perWeek = weeks.map(wStart => {
            const wEnd = new Date(wStart);
            wEnd.setDate(wEnd.getDate() + 7);
            const inWeek = sub.filter(g => {
                const t = g.end_time * 1000;
                return t >= wStart.getTime() && t < wEnd.getTime();
            });
            if (inWeek.length === 0) return { n: 0, winRate: null, change: null };
            const wins = inWeek.filter(g => g.outcome === "win").length;
            const winRate = (wins / inWeek.length) * 100;
            const startRating = inWeek[0].my_rating;
            // Rating after the last game in the week ≈ my_rating of next game in the
            // same time-class bucket. If none, use the current rating from stats.
            const next = sub.find(g => g.end_time * 1000 >= wEnd.getTime());
            const endRating = next ? next.my_rating
                                   : (ratingsForVariant[tc]?.current ?? inWeek[inWeek.length - 1].my_rating);
            return { n: inWeek.length, winRate, change: endRating - startRating };
        });

        const cell = (val, cls = "") => `<td class="${cls}">${val}</td>`;
        const label = `${variantLabel} ${tc}`;

        // Games
        html += `<tr class="row-first"><td rowspan="3" class="row-label">${label}</td>`;
        html += `<td class="metric">Games</td>`;
        for (const pw of perWeek) {
            html += pw.n === 0 ? cell("—", "empty") : cell(pw.n);
        }
        html += `</tr>`;

        // Win %
        html += `<tr><td class="metric">Win %</td>`;
        for (const pw of perWeek) {
            html += pw.winRate === null
                ? cell("—", "empty")
                : cell(`${pw.winRate.toFixed(0)}%`);
        }
        html += `</tr>`;

        // Δ Rating
        html += `<tr class="row-last"><td class="metric">Δ Rating</td>`;
        for (const pw of perWeek) {
            if (pw.change === null) { html += cell("—", "empty"); continue; }
            const cls = pw.change > 0 ? "pos" : pw.change < 0 ? "neg" : "";
            const txt = (pw.change > 0 ? "+" : "") + pw.change;
            html += cell(txt, cls);
        }
        html += `</tr>`;
    }

    html += `</tbody></table></div>`;
    root.innerHTML = html;
}

function renderSummary(games) {
    const root = document.getElementById("summary");
    root.innerHTML = "";

    if (games.length === 0) {
        root.innerHTML = `<div class="stat"><div class="label">No rated ${currentVariant} games</div></div>`;
        return;
    }

    const cards = [];
    cards.push(makeStat("Total games", games.length.toLocaleString()));
    const wins = games.filter(g => g.outcome === "win").length;
    const draws = games.filter(g => g.outcome === "draw").length;
    cards.push(makeStat("Win rate", `${(wins / games.length * 100).toFixed(1)}%`));
    cards.push(makeStat("Draw rate", `${(draws / games.length * 100).toFixed(1)}%`));
    const whiteWins = games.filter(g => g.my_color === "white" && g.outcome === "win").length;
    const whiteN = games.filter(g => g.my_color === "white").length;
    const blackWins = games.filter(g => g.my_color === "black" && g.outcome === "win").length;
    const blackN = games.filter(g => g.my_color === "black").length;
    if (whiteN) cards.push(makeStat("White win rate", `${(whiteWins / whiteN * 100).toFixed(1)}%`));
    if (blackN) cards.push(makeStat("Black win rate", `${(blackWins / blackN * 100).toFixed(1)}%`));

    root.append(...cards);
}

function makeStat(label, value, delta) {
    const el = document.createElement("div");
    el.className = "stat";
    let deltaHtml = "";
    if (typeof delta === "number") {
        const cls = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
        const sign = delta > 0 ? "+" : "";
        deltaHtml = ` <span class="delta ${cls}">${sign}${delta}</span>`;
    }
    el.innerHTML = `<div class="label">${label}</div><div class="value">${value}${deltaHtml}</div>`;
    return el;
}

function destroyChart(key) {
    if (charts[key]) {
        charts[key].destroy();
        delete charts[key];
    }
}

function renderRating(games) {
    destroyChart("rating");
    const ctx = document.getElementById("ratingChart");

    const datasets = TIME_CLASSES.map(tc => {
        const sub = games.filter(g => g.time_class === tc);
        return {
            label: tc,
            data: sub.map(g => ({ x: g.end_time * 1000, y: g.my_rating })),
            borderColor: TIME_CLASS_COLORS[tc],
            backgroundColor: TIME_CLASS_COLORS[tc],
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.2,
            spanGaps: true,
        };
    }).filter(d => d.data.length > 0);

    charts.rating = new Chart(ctx, {
        type: "line",
        data: { datasets },
        options: baseOptions({
            yTitle: "Rating",
            xTime: true,
        }),
    });
}

function renderOpponent(games) {
    destroyChart("opponent");
    const ctx = document.getElementById("opponentChart");

    const scatterDatasets = [];
    const lineDatasets = [];

    for (const tc of TIME_CLASSES) {
        const sub = games.filter(g => g.time_class === tc);
        if (sub.length === 0) continue;

        scatterDatasets.push({
            label: `${tc} (each game)`,
            data: sub.map(g => ({ x: g.end_time * 1000, y: g.opp_rating })),
            borderColor: TIME_CLASS_COLORS[tc] + "55",
            backgroundColor: TIME_CLASS_COLORS[tc] + "55",
            pointRadius: 2,
            showLine: false,
            type: "scatter",
        });

        // 20-game rolling average
        const window = 20;
        const rolling = [];
        for (let i = 0; i < sub.length; i++) {
            const start = Math.max(0, i - window + 1);
            const slice = sub.slice(start, i + 1);
            const avg = slice.reduce((s, g) => s + g.opp_rating, 0) / slice.length;
            rolling.push({ x: sub[i].end_time * 1000, y: avg });
        }
        lineDatasets.push({
            label: `${tc} (20-game avg)`,
            data: rolling,
            borderColor: TIME_CLASS_COLORS[tc],
            backgroundColor: TIME_CLASS_COLORS[tc],
            borderWidth: 2.5,
            pointRadius: 0,
            tension: 0.3,
            type: "line",
        });
    }

    charts.opponent = new Chart(ctx, {
        data: { datasets: [...scatterDatasets, ...lineDatasets] },
        options: baseOptions({
            yTitle: "Opponent rating",
            xTime: true,
        }),
    });
}

function renderOutcome(games) {
    destroyChart("outcome");
    const ctx = document.getElementById("outcomeChart");

    // Group: outcome -> reason -> count.
    const counts = { win: {}, loss: {}, draw: {} };
    for (const g of games) {
        counts[g.outcome][g.reason] = (counts[g.outcome][g.reason] || 0) + 1;
    }

    const reasonsPresent = REASON_ORDER.filter(r =>
        counts.win[r] || counts.loss[r] || counts.draw[r]
    );

    // One stacked bar per reason, segmented by outcome.
    const datasets = ["win", "loss", "draw"].map(o => ({
        label: o,
        data: reasonsPresent.map(r => counts[o][r] || 0),
        backgroundColor: OUTCOME_COLORS[o],
        borderWidth: 0,
    }));

    charts.outcome = new Chart(ctx, {
        type: "bar",
        data: { labels: reasonsPresent, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: getCss("--text") } },
                tooltip: { mode: "index", intersect: false },
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: { color: getCss("--muted") },
                    grid: { color: getCss("--border") },
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: { color: getCss("--muted") },
                    grid: { color: getCss("--border") },
                    title: { display: true, text: "Games", color: getCss("--muted") },
                },
            },
        },
    });
}

function renderWinrate(games) {
    destroyChart("winrate");
    const ctx = document.getElementById("winrateChart");

    const buckets = TIME_CLASSES.filter(tc => games.some(g => g.time_class === tc));
    const data = buckets.map(tc => {
        const sub = games.filter(g => g.time_class === tc);
        const w = sub.filter(g => g.outcome === "win").length;
        const l = sub.filter(g => g.outcome === "loss").length;
        const d = sub.filter(g => g.outcome === "draw").length;
        return { tc, w, l, d, n: sub.length };
    });

    charts.winrate = new Chart(ctx, {
        type: "bar",
        data: {
            labels: data.map(d => `${d.tc} (n=${d.n})`),
            datasets: [
                { label: "win",  data: data.map(d => d.w / d.n * 100), backgroundColor: OUTCOME_COLORS.win,  borderWidth: 0 },
                { label: "draw", data: data.map(d => d.d / d.n * 100), backgroundColor: OUTCOME_COLORS.draw, borderWidth: 0 },
                { label: "loss", data: data.map(d => d.l / d.n * 100), backgroundColor: OUTCOME_COLORS.loss, borderWidth: 0 },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: "y",
            plugins: {
                legend: { labels: { color: getCss("--text") } },
                tooltip: {
                    callbacks: {
                        label: (c) => `${c.dataset.label}: ${c.parsed.x.toFixed(1)}%`,
                    },
                },
            },
            scales: {
                x: {
                    stacked: true,
                    min: 0, max: 100,
                    ticks: { color: getCss("--muted"), callback: v => `${v}%` },
                    grid: { color: getCss("--border") },
                },
                y: {
                    stacked: true,
                    ticks: { color: getCss("--muted") },
                    grid: { color: getCss("--border") },
                },
            },
        },
    });
}

function baseOptions({ yTitle, xTime }) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
            legend: { labels: { color: getCss("--text") } },
            tooltip: {
                callbacks: {
                    title: (items) => {
                        if (!items.length) return "";
                        const t = items[0].parsed.x;
                        return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
                    },
                },
            },
        },
        scales: {
            x: xTime ? {
                type: "time",
                time: { unit: "month" },
                ticks: { color: getCss("--muted") },
                grid: { color: getCss("--border") },
            } : {
                ticks: { color: getCss("--muted") },
                grid: { color: getCss("--border") },
            },
            y: {
                beginAtZero: false,
                grace: "5%",
                ticks: { color: getCss("--muted") },
                grid: { color: getCss("--border") },
                title: { display: !!yTitle, text: yTitle, color: getCss("--muted") },
            },
        },
    };
}

init();
