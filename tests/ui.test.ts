import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  countryNameForCode,
  localeFromPath,
  localizePath,
  providerLabel,
  stripLocale,
  subjectLabel,
} from "../src/i18n/index.ts";
import { onPageLeave } from "../src/lib/client-lifecycle.ts";

test("page cleanup runs once when Astro swaps the document", () => {
  const target = new EventTarget();
  let calls = 0;
  const cleanup = onPageLeave(target, () => {
    calls += 1;
  });

  target.dispatchEvent(new Event("astro:before-swap"));
  target.dispatchEvent(new Event("astro:before-swap"));
  cleanup();

  assert.equal(calls, 1);
});

test("page cleanup can run early and unregister from the swap event", () => {
  const target = new EventTarget();
  let calls = 0;
  const cleanup = onPageLeave(target, () => {
    calls += 1;
  });

  cleanup();
  target.dispatchEvent(new Event("astro:before-swap"));

  assert.equal(calls, 1);
});

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".astro") || entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("client source does not assign provider data to raw HTML sinks", () => {
  const sink = /\b(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(/;
  for (const path of sourceFiles("src")) {
    assert.doesNotMatch(readFileSync(path, "utf8"), sink, path);
  }
});

test("subjects page headings use rendered punctuation instead of literal entities", () => {
  const source = readFileSync("src/pages/subjects.astro", "utf8");
  assert.doesNotMatch(source, /&(?:mdash|rsquo);/);
  assert.match(source, /top schools—and narrow to a country you’d actually consider/);
});

test("specialist copy distinguishes qualifying subjects from placement rows", () => {
  const page = readFileSync("src/pages/subjects.astro", "utf8");
  const component = readFileSync("src/components/SpecialistExamples.astro", "utf8");

  assert.match(page, /placements are shown across \$\{outperformerSubjectCount\} subjects/);
  assert.match(page, /Each placement is one university’s result in one subject/);
  assert.match(
    component,
    /All \$\{subjects\.length\} qualifying subjects \(\$\{items\.length\} placements\)/,
  );
});

test("atlas destination picker uses the shared custom select", () => {
  const source = readFileSync("src/components/CountryDetail.astro", "utf8");
  assert.match(source, /import CustomSelect from ['"]\.\/CustomSelect\.astro['"]/);
  assert.match(source, /<CustomSelect data-country-picker/);
  assert.doesNotMatch(source, /<select data-country-picker/);
  assert.match(source, /picker\.dispatchEvent\(new Event\(['"]change['"]/);
});

test("custom select menus are not clipped by card containers", () => {
  const customSelect = readFileSync("src/components/CustomSelect.astro", "utf8");
  const specialists = readFileSync("src/components/SpecialistExamples.astro", "utf8");
  const nature = readFileSync("src/components/NatureLeaderboards.astro", "utf8");

  assert.match(customSelect, /\.custom-select\[data-open\]\s*\{[^}]*z-index:\s*90/s);
  assert.match(specialists, /\.specialist-browser\s*\{[^}]*overflow:\s*visible/s);
  assert.match(nature, /\.nature-browser\s*\{[^}]*overflow:\s*visible/s);
});

test("university comparison feature is removed", () => {
  assert.equal(existsSync("src/pages/compare.astro"), false);
  assert.equal(existsSync("src/lib/shortlist.ts"), false);

  const layout = readFileSync("src/layouts/BaseLayout.astro", "utf8");
  const home = readFileSync("src/pages/index.astro", "utf8");
  const finder = readFileSync("src/pages/finder.astro", "utf8");
  for (const [path, source] of [
    ["BaseLayout.astro", layout],
    ["index.astro", home],
    ["finder.astro", finder],
  ] as const) {
    assert.doesNotMatch(source, /\/compare\/|data-compare|lib\/shortlist/, path);
  }
});

test("finder is subject-first without redundant ranking controls", () => {
  const page = readFileSync("src/pages/finder.astro", "utf8");
  const component = readFileSync("src/components/UniversityFinder.astro", "utf8");

  assert.match(page, /<UniversityFinder/);
  assert.match(component, /data-view-button="subject"/);
  assert.match(component, /data-view-button="overall"/);
  assert.match(component, /data-subject-source/);
  assert.match(component, /data-subject-table/);
  assert.match(component, /fetch\(board\.detailPath/);
  assert.match(component, /Published rank order/);
  assert.doesNotMatch(component, /data-(?:provider|coverage|sort)(?:\s|=)/);
  assert.doesNotMatch(page, /Ranked by|Best coverage|Most rankings/);
});

test("edition years come from the data instead of hard-coded labels", () => {
  const trends = readFileSync("src/pages/trends.astro", "utf8");
  const layout = readFileSync("src/layouts/BaseLayout.astro", "utf8");
  const timeline = readFileSync("src/components/ProviderTimeline.astro", "utf8");
  const concentration = readFileSync("src/components/ConcentrationTrend.astro", "utf8");

  // The latest-editions movers section is wired into Trends and linked from the home strip.
  assert.match(trends, /<EditionMovers movers=\{insights\.editionMovers\}/);
  assert.match(trends, /id="latest-editions"/);
  assert.match(readFileSync("src/pages/index.astro", "utf8"), /href=\{href\('\/trends\/#latest-editions'\)\}/);

  assert.doesNotMatch(layout, /Signals \/ \d{4}/);
  assert.doesNotMatch(timeline, /start = \d{4}|end = \d{4}|<span>20\d\d<\/span>/);
  assert.doesNotMatch(trends, /2003 → 2025|Leiden 2025|edition\.year === 2003/);
  assert.doesNotMatch(concentration, /2003 to 2025/);
});

test("Google Analytics is validated, production-only, and configured by the deploy workflow", () => {
  const layout = readFileSync("src/layouts/BaseLayout.astro", "utf8");
  const workflow = readFileSync(".github/workflows/deploy-pages.yml", "utf8");

  assert.match(layout, /import\.meta\.env\.PUBLIC_GA_ID/);
  assert.match(layout, /\^G-\[A-Z0-9\]\+\$/);
  assert.match(layout, /import\.meta\.env\.PROD/);
  assert.match(layout, /https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=/);
  assert.match(layout, /gtag\('config','\$\{gaId\}'\)/);
  assert.match(workflow, /PUBLIC_GA_ID: \$\{\{ vars\.PUBLIC_GA_ID \}\}/);
});

test("locale paths map between the English root and the /zh/ mirror", () => {
  assert.equal(localeFromPath("/"), "en");
  assert.equal(localeFromPath("/zh/"), "zh");
  assert.equal(localeFromPath("/zh"), "zh");
  assert.equal(localeFromPath("/zhuhai/"), "en");
  assert.equal(localizePath("/", "zh"), "/zh/");
  assert.equal(localizePath("/trends/#latest-editions", "zh"), "/zh/trends/#latest-editions");
  assert.equal(localizePath("/zh/finder/?q=x", "en"), "/finder/?q=x");
  assert.equal(localizePath("/zh/finder/", "zh"), "/zh/finder/");
  assert.equal(localizePath("https://example.com/", "zh"), "https://example.com/");
  assert.equal(stripLocale("/zh/atlas/"), "/atlas/");
  assert.equal(stripLocale("/zh"), "/");
});

test("Chinese labels cover countries, providers, and publisher subject variants", () => {
  assert.equal(countryNameForCode("CN", "China", "zh"), "中国");
  assert.equal(countryNameForCode("HK", "Hong Kong", "zh"), "中国香港");
  assert.equal(countryNameForCode("US", "United States", "en"), "United States");
  assert.equal(countryNameForCode(null, "Northern Cyprus", "zh"), "北塞浦路斯");
  assert.equal(providerLabel("arwu", "ShanghaiRanking", "zh"), "软科");
  assert.equal(providerLabel("arwu", "ShanghaiRanking", "en"), "ShanghaiRanking");
  assert.equal(subjectLabel("Arts & humanities", "zh"), "艺术与人文");
  assert.equal(subjectLabel("Arts And Humanities", "zh"), subjectLabel("Arts Humanities", "zh"));
  assert.equal(subjectLabel("Computer Science Information Systems", "en"), "Computer Science Information Systems");

  // Every subject label the site renders has a Chinese name.
  const insights = JSON.parse(readFileSync("src/data/insights.json", "utf8"));
  const labels = new Set<string>([
    ...insights.subjectBoards.map((board: { label: string }) => board.label),
    ...insights.natureSubjects.map((subject: { label: string }) => subject.label),
    ...insights.qsSubjectOutperformers.map((item: { subjectLabel: string }) => item.subjectLabel),
  ]);
  const missing = [...labels].filter((label) => subjectLabel(label, "zh") === label);
  assert.deepEqual(missing, []);
});

test("every page has a Simplified Chinese mirror and a header language switch", () => {
  const english = readdirSync("src/pages").filter((name) => name.endsWith(".astro")).sort();
  const chinese = readdirSync("src/pages/zh").filter((name) => name.endsWith(".astro")).sort();
  assert.deepEqual(chinese, english);
  for (const name of chinese) {
    assert.match(readFileSync(join("src/pages/zh", name), "utf8"), new RegExp(`import Page from '\\.\\./${name.replace(".", "\\.")}'`));
  }

  const config = readFileSync("astro.config.mjs", "utf8");
  assert.match(config, /locales: \['en', 'zh'\]/);
  assert.match(config, /prefixDefaultLocale: false/);

  const layout = readFileSync("src/layouts/BaseLayout.astro", "utf8");
  assert.match(layout, /<html lang=\{lang\}>/);
  assert.match(layout, /class="locale-switch"/);
  assert.match(layout, /data-locale-link/);
  assert.match(layout, /hreflang="x-default"/);
});
