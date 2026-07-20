/** CWUR provider scraper. */
import { createRequire } from "node:module";

import { HEADERS, URLS } from "../constants.ts";
import { countryMatches } from "../country.ts";
import { ScraperClient, request } from "../http.ts";
import { ScraperError } from "../types.ts";
import type { RankRecord } from "../types.ts";
import { columnSlug } from "../text.ts";
import { optionDefaults, toInt, type ProviderOptions } from "./shared.ts";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom") as { parseHTML(html: string): { document: any } };

const CWUR_YEAR_PATHS: Record<number, string> = { 2012: "2012.php", 2013: "2013.php", 2014: "2014.php", 2015: "2015.php", 2016: "2016.php", 2017: "2017.php", 2018: "2018-19.php", 2019: "2019-20.php", 2020: "2020-21.php", 2021: "2021.php", 2022: "2022-23.php", 2023: "2023.php", 2024: "2024.php", 2025: "2025.php", 2026: "2026.php" };

/** Scrapes one CWUR overall ranking edition. */
export async function scrapeCwur(opts: ProviderOptions = {}): Promise<RankRecord[]> {
  const options = optionDefaults({ ...opts, year: opts.year ?? 2026 });
  const path = CWUR_YEAR_PATHS[options.year];
  if (path === undefined) throw new Error("CWUR editions are available from 2012 through 2026");
  const client = new ScraperClient({ headers: HEADERS.cwur, timeoutMs: 60_000 });
  const response = await request(client, `${URLS.cwurBase}/${path}`, { params: null, provider: "cwur", maxRetries: options.maxRetries, baseDelay: options.baseDelay });
  const { document } = parseHTML(response.text);
  let headers: string[] = [];
  let bodyRows: string[][] = [];
  for (const table of Array.from(document.querySelectorAll("table")) as any[]) {
    const rowEls = Array.from(table.querySelectorAll("tr")) as any[];
    const first = rowEls.find((row: any) => row.querySelectorAll("th,td").length > 0);
    if (!first) continue;
    headers = (Array.from(first.querySelectorAll("th,td")) as any[]).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim());
    if (new Set(headers).has("World Rank") && new Set(headers).has("Institution")) {
      bodyRows = rowEls.slice(rowEls.indexOf(first) + 1).map((row: any) => (Array.from(row.querySelectorAll("td")) as any[]).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())).filter((cells: string[]) => cells.length > 0);
      break;
    }
  }
  if (!headers.length || !bodyRows.length) throw new ScraperError(`CWUR returned no ranking table for ${options.year}`);
  const columns = headers.map((h) => ({ world_rank: "ranking_display", institution: "name", location: "country" }[columnSlug(h)] ?? columnSlug(h)));
  const rows: RankRecord[] = [];
  for (const cells of bodyRows) {
    const base: RankRecord = { edition: path.replace(/\.php$/, "") };
    for (let i = 0; i < columns.length; i += 1) {
      const col = columns[i] ?? `column_${i}`;
      const value = cells[i] ?? "";
      if (col === "ranking_display") {
        const match = value.match(/^\s*(\d+)/);
        base.ranking = match ? toInt(match[1]) : null;
        base.ranking_display = match ? match[1] : null;
      } else {
        base[col] = value;
      }
    }
    if (!options.country || countryMatches(options.country, base.country)) rows.push(base);
  }
  return rows;
}
