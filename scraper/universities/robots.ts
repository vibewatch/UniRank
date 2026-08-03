export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

export interface RobotsPolicy {
  sourceUrl: string;
  state: "available" | "unavailable" | "unreachable";
  httpStatus: number | null;
  groups: RobotsGroup[];
  sitemaps: string[];
}

interface MutableGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

const MAX_CRAWL_DELAY_SECONDS = 300;

function directive(line: string): [string, string] | null {
  const comment = line.indexOf("#");
  const uncommented = (comment === -1 ? line : line.slice(0, comment)).trim();
  if (!uncommented) return null;
  const separator = uncommented.indexOf(":");
  if (separator === -1) return null;
  return [
    uncommented.slice(0, separator).trim().toLowerCase(),
    uncommented.slice(separator + 1).trim(),
  ];
}

export function parseRobotsTxt(
  text: string,
  sourceUrl: string,
  httpStatus: number = 200,
): RobotsPolicy {
  const groups: MutableGroup[] = [];
  const sitemaps: string[] = [];
  let current: MutableGroup | null = null;
  let acceptingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      current = null;
      acceptingAgents = false;
      continue;
    }
    const parsed = directive(rawLine);
    if (!parsed) continue;
    const [name, value] = parsed;

    if (name === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    if (name === "user-agent") {
      if (!current || !acceptingAgents) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      acceptingAgents = true;
      continue;
    }

    if (!current || current.agents.length === 0) continue;
    acceptingAgents = false;
    if ((name === "allow" || name === "disallow") && value) {
      current.rules.push({ allow: name === "allow", path: value });
    } else if (name === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelayMs = Math.min(seconds, MAX_CRAWL_DELAY_SECONDS) * 1000;
      }
    }
  }

  return {
    sourceUrl,
    state: "available",
    httpStatus,
    groups: groups.filter((group) => group.agents.length > 0),
    sitemaps: [...new Set(sitemaps)],
  };
}

export function unavailableRobotsPolicy(
  sourceUrl: string,
  state: "unavailable" | "unreachable",
  httpStatus: number | null,
): RobotsPolicy {
  return {
    sourceUrl,
    state,
    httpStatus,
    groups: state === "unreachable"
      ? [{ agents: ["*"], rules: [{ allow: false, path: "/" }], crawlDelayMs: null }]
      : [],
    sitemaps: [],
  };
}

function matchingGroups(policy: RobotsPolicy, userAgent: string): RobotsGroup[] {
  const product = userAgent.split(/[\s/]/, 1)[0]!.toLowerCase();
  const scored = policy.groups.flatMap((group) =>
    group.agents.map((agent) => ({
      group,
      score: agent === "*" ? 0 : (product === agent ? agent.length : -1),
    })),
  ).filter((entry) => entry.score >= 0);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((entry) => entry.score));
  return [...new Set(scored.filter((entry) => entry.score === best).map((entry) => entry.group))];
}

function escapePattern(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedOctets(value: string): string {
  let encoded = "";
  for (const character of value) {
    encoded += character.codePointAt(0)! > 0x7f ? encodeURIComponent(character) : character;
  }
  return encoded.replace(/%([0-9a-f]{2})/gi, (match, hexadecimal: string) => {
    const character = String.fromCharCode(Number.parseInt(hexadecimal, 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : match.toUpperCase();
  });
}

function ruleMatches(path: string, rulePath: string): boolean {
  const normalizedRule = normalizedOctets(rulePath);
  const normalizedPath = normalizedOctets(path);
  const anchored = normalizedRule.endsWith("$");
  const body = anchored ? normalizedRule.slice(0, -1) : normalizedRule;
  const pattern = escapePattern(body).replace(/\*/g, ".*");
  try {
    return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(normalizedPath);
  } catch {
    return false;
  }
}

export function robotsAllows(policy: RobotsPolicy, userAgent: string, targetUrl: string): boolean {
  const groups = matchingGroups(policy, userAgent);
  if (!groups.length) return true;
  const url = new URL(targetUrl);
  const path = `${url.pathname}${url.search}`;
  const matches = groups.flatMap((group) => group.rules)
    .filter((rule) => ruleMatches(path, rule.path))
    .map((rule) => ({
      rule,
      specificity: rule.path.replace(/[*$]/g, "").length,
    }));
  if (!matches.length) return true;
  matches.sort((a, b) =>
    b.specificity - a.specificity || Number(b.rule.allow) - Number(a.rule.allow),
  );
  return matches[0]!.rule.allow;
}

export function robotsCrawlDelayMs(policy: RobotsPolicy, userAgent: string): number | null {
  const delays = matchingGroups(policy, userAgent)
    .map((group) => group.crawlDelayMs)
    .filter((value): value is number => value !== null);
  return delays.length ? Math.max(...delays) : null;
}
