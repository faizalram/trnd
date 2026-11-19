// Discovery run for TikTok Creative Center.
// Visits the pages in targets.json once, like a normal browser, and saves what each page
// loads so the real parser can be written against real data:
//   out/summary.md            readable overview of every page
//   out/NN-name/screenshot.jpg
//   out/NN-name/page.html
//   out/NN-name/links.json     Creative Center links found on the page
//   out/NN-name/controls.json  buttons, dropdowns and inputs (for filters like region/industry)
//   out/NN-name/responses/*.json  every JSON response the page received
// Nothing is written to a database. Cookies and auth headers are not saved.

import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve(process.env.OUT_DIR || "out");
const ALL_HOSTS = process.env.DISCOVER_ALL_HOSTS === "1"; // for local testing only
const MAX_BODY = 2_000_000;
const HOSTS = /(tiktok|byteoversea|bytedance|ibytedtos|ttwstatic|tiktokv|tiktokcdn)/i;

const targetsFile = process.env.TARGETS_FILE ? path.resolve(process.env.TARGETS_FILE) : new URL("./targets.json", import.meta.url);
const targets = JSON.parse(await fs.readFile(targetsFile, "utf8"));

const pad = (n, w = 2) => String(n).padStart(w, "0");
const tryJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const mask = (headers) =>
  Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, /^(cookie|authorization|x-tt-token)$/i.test(k) ? "[hidden]" : v]),
  );

async function clickByText(page, pattern, log, label) {
  const candidates = page.locator("button, [role=button], a, span, div").filter({ hasText: pattern });
  const count = Math.min(await candidates.count().catch(() => 0), 20);
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const text = ((await el.innerText().catch(() => "")) || "").trim();
    if (!pattern.test(text)) continue; // exact-ish match only, not big containers
    if (!(await el.isVisible().catch(() => false))) continue;
    try {
      await el.click({ timeout: 3000 });
      log.push(`clicked ${label}: "${text}"`);
      return true;
    } catch {
      // try the next one
    }
  }
  return false;
}

/** Best effort: open a region/country picker and choose the region. Logs what it tried. */
async function trySetRegion(page, region, log) {
  const pickers = [
    page.getByPlaceholder(/region|country|negara|wilayah/i),
    page.getByRole("combobox"),
    page.locator("[class*=region i], [class*=country i]"),
  ];
  for (const picker of pickers) {
    const n = Math.min(await picker.count().catch(() => 0), 5);
    for (let i = 0; i < n; i++) {
      const el = picker.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      try {
        await el.click({ timeout: 3000 });
        await page.keyboard.type(region, { delay: 40 }).catch(() => {});
        await page.waitForTimeout(1200);
        const option = page.getByText(new RegExp(`^\\s*${region}\\s*$`, "i")).first();
        if (await option.isVisible().catch(() => false)) {
          await option.click({ timeout: 3000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          log.push(`region picker #${i} -> chose "${region}"`);
          return true;
        }
        await page.keyboard.press("Escape").catch(() => {});
      } catch {
        // keep trying other pickers
      }
    }
  }
  log.push(`region: could not find a picker for "${region}" (the URL parameter may still have worked)`);
  return false;
}

async function autoScroll(page) {
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 1400).catch(() => {});
    await page.waitForTimeout(600);
  }
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const context = await browser.newContext({
  locale: "en-US",
  timezoneId: "Asia/Jakarta",
  viewport: { width: 1440, height: 1000 },
});

const summary = [];

for (const [i, t] of targets.entries()) {
  const dir = path.join(OUT, `${pad(i + 1)}-${t.name}`);
  await fs.mkdir(path.join(dir, "responses"), { recursive: true });
  const page = await context.newPage();
  const responses = [];
  const pending = [];
  const log = [];
  let n = 0;

  page.on("response", (res) => {
    pending.push(
      (async () => {
        try {
          const url = res.url();
          const host = new URL(url).hostname;
          const type = res.headers()["content-type"] || "";
          if (!/json/i.test(type)) return;
          if (!ALL_HOSTS && !HOSTS.test(host)) return;
          const text = await res.text();
          const req = res.request();
          const file = `${pad(++n, 3)}.json`;
          await fs.writeFile(
            path.join(dir, "responses", file),
            JSON.stringify(
              {
                url,
                status: res.status(),
                method: req.method(),
                requestHeaders: mask(req.headers()),
                postData: req.postData()?.slice(0, 5000) ?? null,
                truncated: text.length > MAX_BODY,
                body: tryJson(text.slice(0, MAX_BODY)),
              },
              null,
              2,
            ),
          );
          responses.push({ file, method: req.method(), status: res.status(), url, kb: Math.round(text.length / 1024) });
        } catch {
          // response body not available (redirect, aborted): skip
        }
      })(),
    );
  });

  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => log.push("networkidle timed out"));
    await clickByText(page, /^(accept all|accept|allow all|accept cookies|terima semua|got it)$/i, log, "cookie banner");
    if (t.region) await trySetRegion(page, t.region, log);
    for (let k = 0; k < (t.loadMore ?? 0); k++) {
      const clicked = await clickByText(page, /^(view more|load more|see more|lihat lebih banyak|lihat selengkapnya)$/i, log, `load more #${k + 1}`);
      if (!clicked) {
        log.push(`no "view more" button found (round ${k + 1})`);
        break;
      }
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await autoScroll(page);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  } catch (e) {
    // first line only, without terminal color codes
    log.push(`error: ${String(e.message).replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0]}`);
  }

  await Promise.allSettled(pending);
  const finalUrl = page.url();
  const title = await page.title().catch(() => "");
  await page
    .screenshot({ path: path.join(dir, "screenshot.jpg"), fullPage: true, type: "jpeg", quality: 60 })
    .catch((e) => log.push(`screenshot failed: ${e.message}`));
  await fs.writeFile(path.join(dir, "page.html"), await page.content().catch(() => ""));

  const links = await page
    .$$eval("a[href]", (as) => [...new Set(as.map((a) => a.href))])
    .catch(() => []);
  await fs.writeFile(
    path.join(dir, "links.json"),
    JSON.stringify(links.filter((h) => /creativecenter|creative-center/i.test(h)), null, 2),
  );

  const controls = await page
    .$$eval("button, [role=button], [role=combobox], [role=tab], [role=option], input, select", (els) =>
      els.slice(0, 400).map((e) => ({
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute("role"),
        text: (e.innerText || e.value || e.getAttribute("placeholder") || e.getAttribute("aria-label") || "").trim().slice(0, 100),
        className: typeof e.className === "string" ? e.className.slice(0, 120) : "",
      })),
    )
    .catch(() => []);
  await fs.writeFile(path.join(dir, "controls.json"), JSON.stringify(controls.filter((c) => c.text), null, 2));

  summary.push({ name: t.name, requested: t.url, finalUrl, title, log, responses: responses.sort((a, b) => a.file.localeCompare(b.file)) });
  console.log(`${t.name}: "${title}" -> ${finalUrl} (${responses.length} JSON responses)`);
  await page.close();
}

await browser.close();

const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.host + x.pathname + x.search).slice(0, 180);
  } catch {
    return u.slice(0, 180);
  }
};

const md = [
  "# Creative Center discovery run",
  "",
  `Run at ${new Date().toISOString()}`,
  "",
  ...summary.flatMap((s, i) => [
    `## ${pad(i + 1)}-${s.name}`,
    "",
    `- Requested: ${s.requested}`,
    `- Landed on: ${s.finalUrl}`,
    `- Title: ${s.title || "(none)"}`,
    ...s.log.map((l) => `- Log: ${l}`),
    "",
    `JSON responses (${s.responses.length}):`,
    "",
    ...s.responses.map((r) => `- ${r.file} ${r.method} ${r.status} ${r.kb} KB ${shortUrl(r.url)}`),
    "",
  ]),
].join("\n");

await fs.writeFile(path.join(OUT, "summary.md"), md);
await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nSaved to ${OUT}`);
