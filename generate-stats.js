#!/usr/bin/env node
/**
 * generate-stats.js
 * Fetches GitHub stats via the official API and writes a stats.svg to the repo root.
 * Requires: GITHUB_TOKEN and GITHUB_USERNAME env vars (both provided free by GitHub Actions).
 */

const https = require("https");
const fs = require("fs");

const TOKEN = process.env.GITHUB_TOKEN;
const USERNAME = process.env.GITHUB_USERNAME;

if (!TOKEN || !USERNAME) {
  console.error("GITHUB_TOKEN and GITHUB_USERNAME must be set.");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ghFetch(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "github-stats-generator",
        Accept: "application/vnd.github+json",
      },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function ghGraphQL(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const options = {
      hostname: "api.github.com",
      path: "/graphql",
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "github-stats-generator",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Data Fetching ─────────────────────────────────────────────────────────────

async function fetchStats() {
  // Basic user info
  const user = await ghFetch(`/users/${USERNAME}`);

  // Contribution data via GraphQL (gives us total commits + streak-friendly data)
  const gql = await ghGraphQL(`
    query {
      user(login: "${USERNAME}") {
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalRepositoryContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
          nodes {
            stargazerCount
            forkCount
            primaryLanguage { name color }
          }
        }
      }
    }
  `);

  const contrib = gql.data.user.contributionsCollection;
  const repos = gql.data.user.repositories.nodes;
  const calendar = contrib.contributionCalendar;

  // Aggregate stars & forks
  const totalStars = repos.reduce((s, r) => s + r.stargazerCount, 0);
  const totalForks = repos.reduce((s, r) => s + r.forkCount, 0);

  // Top languages (by repo count)
  const langMap = {};
  for (const repo of repos) {
    if (repo.primaryLanguage) {
      const { name, color } = repo.primaryLanguage;
      langMap[name] = langMap[name] || { count: 0, color };
      langMap[name].count++;
    }
  }
  const topLangs = Object.entries(langMap)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  // Current streak
  const allDays = calendar.weeks.flatMap((w) => w.contributionDays).reverse();
  let streak = 0;
  for (const day of allDays) {
    if (day.contributionCount > 0) streak++;
    else break;
  }

  return {
    name: user.name || USERNAME,
    username: USERNAME,
    followers: user.followers,
    publicRepos: user.public_repos,
    totalStars,
    totalForks,
    totalCommits: contrib.totalCommitContributions,
    totalPRs: contrib.totalPullRequestContributions,
    totalIssues: contrib.totalIssueContributions,
    reposContributedTo: contrib.totalRepositoryContributions,
    streak,
    topLangs,
  };
}

// ── SVG Generation ────────────────────────────────────────────────────────────

function statRow(label, value, y) {
  return `
  <text x="25" y="${y}" class="label">${label}</text>
  <text x="295" y="${y}" class="value" text-anchor="end">${value.toLocaleString()}</text>
  <line x1="25" y1="${y + 6}" x2="295" y2="${y + 6}" class="divider"/>`;
}

function langBar(name, color, percent, y) {
  const BAR_W = 270;
  const filled = Math.round((percent / 100) * BAR_W);
  return `
  <rect x="25" y="${y}" width="${BAR_W}" height="6" rx="3" fill="#2a2a3a"/>
  <rect x="25" y="${y}" width="${filled}" height="6" rx="3" fill="${color || "#58a6ff"}"/>
  <text x="25" y="${y + 18}" class="lang-name">${name}</text>
  <text x="295" y="${y + 18}" class="lang-pct" text-anchor="end">${percent.toFixed(1)}%</text>`;
}

function buildSVG(s) {
  const LEFT_X = 0;
  const RIGHT_X = 320;
  const PANEL_W = 300;
  const TOTAL_W = LEFT_X + PANEL_W + RIGHT_X + PANEL_W; // 920

  const totalLangCount = s.topLangs.reduce((n, [, v]) => n + v.count, 0);
  const updated = new Date().toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });

  // Right panel: language bars
  const langBars =
    totalLangCount > 0
      ? s.topLangs
          .map(([name, { color, count }], i) =>
            langBar(name, color, (count / totalLangCount) * 100, 108 + i * 34)
          )
          .join("")
      : `<text x="${RIGHT_X + 25}" y="108" class="subtitle">No language data available yet.</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TOTAL_W}" height="310" viewBox="0 0 ${TOTAL_W} 310" role="img" aria-label="GitHub Stats for ${s.name}">
  <defs>
    <style>
      .card { fill: #0d1117; rx: 12; }
      .title { font: 600 15px 'Segoe UI', sans-serif; fill: #e6edf3; }
      .subtitle { font: 400 11px 'Segoe UI', sans-serif; fill: #7d8590; }
      .label { font: 400 12px 'Segoe UI', sans-serif; fill: #8b949e; }
      .value { font: 600 12px 'Segoe UI', sans-serif; fill: #e6edf3; }
      .divider { stroke: #21262d; stroke-width: 1; }
      .accent { fill: #238636; }
      .lang-name { font: 400 11px 'Segoe UI', sans-serif; fill: #8b949e; }
      .lang-pct  { font: 600 11px 'Segoe UI', sans-serif; fill: #e6edf3; }
      .streak-num { font: 700 28px 'Segoe UI', sans-serif; fill: #f78166; }
      .streak-lbl { font: 400 11px 'Segoe UI', sans-serif; fill: #7d8590; }
    </style>
  </defs>

  <!-- Left panel: Stats -->
  <rect x="${LEFT_X}" y="0" width="${PANEL_W}" height="310" rx="12" fill="#0d1117" stroke="#21262d" stroke-width="1"/>

  <!-- Header -->
  <text x="${LEFT_X + 25}" y="38" class="title">📊 ${s.name}'s GitHub Stats</text>
  <text x="${LEFT_X + 25}" y="56" class="subtitle">@${s.username} · Updated ${updated}</text>
  <line x1="${LEFT_X + 25}" y1="68" x2="${LEFT_X + 275}" y2="68" class="divider"/>

  <!-- Streak badge -->
  <rect x="${LEFT_X + 210}" y="22" width="68" height="36" rx="8" fill="#161b22" stroke="#21262d" stroke-width="1"/>
  <text x="${LEFT_X + 244}" y="38" class="streak-num" text-anchor="middle">${s.streak}</text>
  <text x="${LEFT_X + 244}" y="52" class="streak-lbl" text-anchor="middle">day streak</text>

  <!-- Stat rows -->
  ${statRow("⭐ Total Stars Earned", s.totalStars, 100)}
  ${statRow("🍴 Total Forks", s.totalForks, 126)}
  ${statRow("💻 Total Commits (this year)", s.totalCommits, 152)}
  ${statRow("🔀 Pull Requests", s.totalPRs, 178)}
  ${statRow("🐛 Issues Opened", s.totalIssues, 204)}
  ${statRow("🏗️ Repos Contributed To", s.reposContributedTo, 230)}
  ${statRow("👥 Followers", s.followers, 256)}
  ${statRow("📦 Public Repos", s.publicRepos, 282)}

  <!-- Right panel: Languages -->
  <rect x="${RIGHT_X}" y="0" width="${PANEL_W}" height="310" rx="12" fill="#0d1117" stroke="#21262d" stroke-width="1"/>
  <text x="${RIGHT_X + 25}" y="38" class="title">🛠️ Top Languages</text>
  <text x="${RIGHT_X + 25}" y="56" class="subtitle">by repository count</text>
  <line x1="${RIGHT_X + 25}" y1="68" x2="${RIGHT_X + 275}" y2="68" class="divider"/>

  <g transform="translate(${RIGHT_X}, 0)">
    ${langBars}
  </g>
</svg>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`Fetching stats for ${USERNAME}…`);
  const stats = await fetchStats();
  console.log("Stats fetched:", JSON.stringify(stats, null, 2));

  const svg = buildSVG(stats);
  fs.writeFileSync("stats.svg", svg, "utf8");
  console.log("✅ stats.svg written.");
})();