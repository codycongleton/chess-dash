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
    renderActivity("activityDailyChart", "activityDaily", "daily");
    renderActivity("activityRapidChart", "activityRapid", "rapid");
    renderBoxplot();
    renderWeekly();
    render();
}

function renderActivity(canvasId, key, timeClass) {
    destroyChart(key);
    const ctx = document.getElementById(canvasId);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        days.push(d);
    }

    const sub = allGames.filter(g => g.rules === "chess" && g.time_class === timeClass);

    const perDay = days.map(d => {
        const start = d.getTime();
        const end = start + 24 * 60 * 60 * 1000;
        const inDay = sub.filter(g => {
            const t = g.end_time * 1000;
            return t >= start && t < end;
        });
        const wins = inDay.filter(g => g.outcome === "win").length;
        return { played: inDay.length, wins, other: inDay.length - wins };
    });

    const labels = days.map(d =>
        d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    );

    charts[key] = new Chart(ctx, {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Wins",
                    data: perDay.map(d => d.wins),
                    backgroundColor: getCss("--win"),
                    borderWidth: 0,
                },
                {
                    label: "Other",
                    data: perDay.map(d => d.other),
                    backgroundColor: getCss("--muted") + "55",
                    borderWidth: 0,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: getCss("--text") } },
                tooltip: {
                    mode: "index",
                    intersect: false,
                    callbacks: {
                        afterTitle: (items) => `played: ${perDay[items[0].dataIndex].played}`,
                    },
                },
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: { color: getCss("--muted"), maxRotation: 0, autoSkip: true, autoSkipPadding: 8 },
                    grid: { color: getCss("--border") },
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: { color: getCss("--muted"), precision: 0 },
                    grid: { color: getCss("--border") },
                    title: { display: true, text: "Games", color: getCss("--muted") },
                },
            },
        },
    });
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
    const fmt = (ts) => new Date(ts).toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
    });
    const lastGame = fmt(last.end_time * 1000);
    const parts = [`${allGames.length} rated games`, `last game ${lastGame}`];
    if (ratingsData?.fetched_at) {
        parts.push(`refreshed ${fmt(ratingsData.fetched_at * 1000)}`);
    }
    document.getElementById("meta").textContent = parts.join(" · ");
}

function render() {
    const games = allGames.filter(g => g.rules === currentVariant);
    // Bullet is hidden in charts (rating range too far from blitz/rapid/daily
    // to be useful on shared axes) but kept in the Current ratings cards.
    const chartGames = games.filter(g => g.time_class !== "bullet");
    renderSummary(games);
    renderStrikeline(games);     // counts only — bullet stays in
    renderRating(chartGames);
    renderOpponent(chartGames);
    renderOutcome(chartGames);
    renderWinrate(chartGames);
    // The weekly rating distribution and weekly performance table both
    // show all variants stacked — they ignore the variant toggle and are
    // rendered once at init time.
}

function renderStrikeline(games) {
    destroyChart("strike");
    const ctx = document.getElementById("strikeChart");
    if (!games.length) {
        ["strike-max", "strike-avg", "strike-total", "strike-start", "strike-end"]
            .forEach(id => (document.getElementById(id).textContent = "—"));
        return;
    }

    // Day buckets keyed by local YYYY-MM-DD.
    const counts = new Map();
    for (const g of games) {
        const d = new Date(g.end_time * 1000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    const earliest = new Date(games[0].end_time * 1000);
    earliest.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const series = [];
    const cur = new Date(earliest);
    while (cur <= today) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        series.push({ x: cur.getTime(), y: counts.get(key) || 0 });
        cur.setDate(cur.getDate() + 1);
    }

    const maxN = Math.max(...series.map(p => p.y));
    const total = games.length;
    const activeDays = counts.size;
    const avgActive = (total / activeDays).toFixed(1);

    const fmtShort = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    document.getElementById("strike-max").textContent = maxN;
    document.getElementById("strike-avg").textContent = avgActive;
    document.getElementById("strike-total").textContent = total.toLocaleString();
    document.getElementById("strike-start").textContent = fmtShort(earliest);
    document.getElementById("strike-end").textContent = fmtShort(today);

    const accent = getCss("--accent");

    charts.strike = new Chart(ctx, {
        type: "line",
        data: {
            datasets: [{
                data: series,
                borderColor: accent,
                borderWidth: 1.25,
                pointRadius: 0,
                pointHoverRadius: 3,
                tension: 0,
                fill: { target: "origin" },
                backgroundColor: accent + "22",
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "nearest", intersect: false, axis: "x" },
            plugins: {
                legend: { display: false },
                tooltip: {
                    displayColors: false,
                    callbacks: {
                        title: (items) =>
                            new Date(items[0].parsed.x).toLocaleDateString(undefined, {
                                weekday: "short", month: "short", day: "numeric",
                            }),
                        label: (item) =>
                            `${item.parsed.y} game${item.parsed.y === 1 ? "" : "s"}`,
                    },
                },
            },
            layout: { padding: 0 },
            scales: {
                x: { type: "time", display: false },
                y: { display: false, beginAtZero: true, suggestedMax: Math.max(maxN, 1) },
            },
        },
    });
}

const BOXPLOT_WEEKS = 26;
const BOXPLOT_VARIANTS = [
    { rules: "chess",    label: "Standard" },
    { rules: "chess960", label: "Chess960" },
];

function renderBoxplot() {
    // Tear down any prior per-(variant,time-class) charts.
    for (const { rules } of BOXPLOT_VARIANTS) {
        for (const tc of TIME_CLASSES) destroyChart(`boxplot-${rules}-${tc}`);
    }

    const root = document.getElementById("boxplotGrid");
    root.innerHTML = "";

    // Show both variants stacked. Bullet excluded (rating axis warps).
    const data = allGames.filter(g => g.time_class !== "bullet");
    if (!data.length) {
        root.innerHTML = `<p class="hint">No games yet.</p>`;
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

    for (const { rules, label: variantLabel } of BOXPLOT_VARIANTS) {
        const variantGames = data.filter(g => g.rules === rules);
        const presentTCs = TIME_CLASSES.filter(tc => variantGames.some(g => g.time_class === tc));
        if (!presentTCs.length) continue;

        const header = document.createElement("div");
        header.className = "boxplot-section-header";
        header.textContent = variantLabel;
        root.appendChild(header);

        for (const tc of presentTCs) {
            const sub = variantGames.filter(g => g.time_class === tc);

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
            charts[`boxplot-${rules}-${tc}`] = new Chart(ctx, {
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
}

function startOfWeek(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    const day = out.getDay();              // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day; // shift to Monday
    out.setDate(out.getDate() + diff);
    return out;
}

function renderWeekly() {
    const root = document.getElementById("weeklyTable");
    const data = allGames.filter(g => g.time_class !== "bullet");
    if (!data.length) {
        root.innerHTML = `<p class="hint">No games yet.</p>`;
        return;
    }

    const thisMonday = startOfWeek(new Date());
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(thisMonday);
        d.setDate(d.getDate() - i * 7);
        weeks.push(d);
    }

    let html = `<div class="table-scroll"><table class="weekly"><thead><tr>
        <th class="row-label">Game type</th>
        <th class="metric">Metric</th>`;
    for (const w of weeks) {
        const label = w.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        html += `<th>${label}</th>`;
    }
    html += `</tr></thead><tbody>`;

    const cell = (val, cls = "") => `<td class="${cls}">${val}</td>`;
    const colspan = weeks.length + 2;
    let firstSection = true;

    for (const { rules, label: variantLabel } of BOXPLOT_VARIANTS) {
        const variantGames = data.filter(g => g.rules === rules);
        const presentTCs = TIME_CLASSES.filter(tc => variantGames.some(g => g.time_class === tc));
        if (!presentTCs.length) continue;

        const ratingsForVariant = ratingsData?.ratings?.[rules] || {};
        const sectionClass = firstSection ? "section-row first" : "section-row";
        html += `<tr class="${sectionClass}"><td colspan="${colspan}">${variantLabel}</td></tr>`;
        firstSection = false;

        for (const tc of presentTCs) {
            const sub = variantGames
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
                const next = sub.find(g => g.end_time * 1000 >= wEnd.getTime());
                const endRating = next ? next.my_rating
                                       : (ratingsForVariant[tc]?.current ?? inWeek[inWeek.length - 1].my_rating);
                return { n: inWeek.length, winRate, change: endRating - startRating };
            });

            html += `<tr class="row-first"><td rowspan="3" class="row-label">${tc}</td>`;
            html += `<td class="metric">Games</td>`;
            for (const pw of perWeek) {
                html += pw.n === 0 ? cell("—", "empty") : cell(pw.n);
            }
            html += `</tr>`;

            html += `<tr><td class="metric">Win %</td>`;
            for (const pw of perWeek) {
                html += pw.winRate === null
                    ? cell("—", "empty")
                    : cell(`${pw.winRate.toFixed(0)}%`);
            }
            html += `</tr>`;

            html += `<tr class="row-last"><td class="metric">Δ Rating</td>`;
            for (const pw of perWeek) {
                if (pw.change === null) { html += cell("—", "empty"); continue; }
                const cls = pw.change > 0 ? "pos" : pw.change < 0 ? "neg" : "";
                const txt = (pw.change > 0 ? "+" : "") + pw.change;
                html += cell(txt, cls);
            }
            html += `</tr>`;
        }
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
