# TRND

Personal market-research app for Indonesian TikTok: daily trending hashtags and top videos from TikTok Creative Center, grouped into niches, with the creators behind them and a map of niche groups.

## Step 1: discovery run (now)

Before writing the real parser, this repo visits Creative Center once from GitHub Actions and saves what the pages load, so the parser can be built against real data. Nothing is stored in a database, and cookies or login headers are not saved.

1. Create an empty **private** GitHub repo called `trnd`, then push this folder:

   ```bash
   git init
   git add .
   git commit -m "Discovery collector"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/trnd.git
   git push -u origin main
   ```

2. On GitHub, open the repo > **Actions** tab > **Discover Creative Center** > **Run workflow** > Run workflow.
3. Wait about 3 minutes until the run shows a green check (a red X is fine too; the results still upload).
4. Open the run, scroll to **Artifacts**, and download **discovery** (a zip).
5. Upload that zip to the Claude chat.

`out/summary.md` inside the zip is a readable overview: which page loaded, which data calls it made, and whether choosing Indonesia worked.

### Run it on your laptop instead (optional)

Needs Node.js 20+:

```bash
cd collector
npm install
npx playwright install chromium
npm run discover
```

Results land in `collector/out`. Running from Indonesia also shows what Creative Center serves to an Indonesian visitor by default.

## Step 2 (after the discovery run)

Parser for the real data, daily schedule, Neon database, niche tagging with Qwen on Groq, and the Next.js app on Vercel.

## Ground rules

TikTok's terms don't allow automated collection. This repo is for personal research only: one visit per day, no redistribution of the data.
