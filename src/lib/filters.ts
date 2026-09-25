export const FILTER_FIELDS = [
  "language",
  "audio",
  "subtitles",
  "genre",
  "contentRating",
  "score",
  "bitrate",
  "year",
  "resolution",
  "hdr",
  "container",
  "file",
  "plex",
  "playable",
  "stereo",
  "suspect",
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export const FILTER_OPS = ["includes", "excludes", "missing", "empty", "notEmpty", "eq", "neq", "gt", "gte", "lt", "lte"] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

export type FilterRule = {
  id: string;
  field: FilterField;
  op: FilterOp;
  value: string;
};

const FIELD_SET = new Set<string>(FILTER_FIELDS);
const OP_SET = new Set<string>(FILTER_OPS);

const LANGUAGE_FIELDS = new Set<FilterField>(["language", "audio", "subtitles"]);

export function fieldOps(field: FilterField): FilterOp[] {
  if (LANGUAGE_FIELDS.has(field)) return field === "subtitles" ? ["includes", "excludes", "missing"] : ["includes", "excludes"];
  if (field === "genre") return ["includes", "excludes", "empty", "notEmpty"];
  if (field === "contentRating" || field === "resolution" || field === "hdr" || field === "container") return ["eq", "neq", "empty", "notEmpty"];
  if (field === "score" || field === "bitrate" || field === "year") return ["gt", "gte", "lt", "lte", "eq", "empty", "notEmpty"];
  return ["eq"];
}

export function defaultRule(id: string, field: FilterField = "language"): FilterRule {
  const op = fieldOps(field)[0] ?? "eq";
  const value =
    field === "language" || field === "audio" || field === "subtitles"
      ? "English"
      : field === "contentRating"
        ? "PG"
        : field === "bitrate"
          ? "10"
          : field === "score"
            ? "7"
            : field === "year"
              ? "2000"
              : field === "resolution"
                ? "1080p"
                : field === "hdr"
                  ? "HDR10"
                  : field === "container"
                    ? "mkv"
                    : field === "file"
                    ? "missing"
                    : field === "plex"
                      ? "out"
                      : field === "playable"
                        ? "not-video"
                        : field === "stereo"
                          ? "yes"
                          : field === "suspect"
                            ? "either"
                            : "";
  return { id, field, op, value };
}

export function parseRules(raw: string | null): FilterRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: FilterRule[] = [];
  for (const item of parsed.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!FIELD_SET.has(String(record.field)) || !OP_SET.has(String(record.op))) continue;
    const field = record.field as FilterField;
    const op = record.op as FilterOp;
    if (!fieldOps(field).includes(op)) continue;
    const value = typeof record.value === "string" ? record.value.slice(0, 80) : "";
    const id = typeof record.id === "string" && record.id ? record.id.slice(0, 40) : `rule-${rules.length + 1}`;
    rules.push({ id, field, op, value });
  }
  return rules;
}

function likeToken(value: string): string | null {
  const cleaned = value.trim().replace(/["\\%_]/g, "");
  if (!cleaned) return null;
  return `%"${cleaned}"%`;
}

function jsonHas(column: string): string {
  return `${column} LIKE ? ESCAPE '\\'`;
}

function languagePresent(scope: "language" | "audio" | "subtitles"): string {
  const parts: string[] = [];
  const push = (column: string) => {
    parts.push(jsonHas(column));
    parts.push(`EXISTS (
      SELECT 1 FROM catalog_episodes e
      WHERE e.catalog_id = catalog_titles.id AND ${jsonHas(`e.${column}`)}
    )`);
  };
  if (scope === "audio" || scope === "language") push("audio_languages");
  if (scope === "subtitles" || scope === "language") {
    push("subtitle_languages");
    parts.push(jsonHas("subtitle_wanted"));
    parts.push(`EXISTS (
      SELECT 1 FROM catalog_episodes e
      WHERE e.catalog_id = catalog_titles.id AND ${jsonHas("e.subtitle_wanted")}
    )`);
  }
  return `(${parts.join(" OR ")})`;
}

function missingSubs(language: string): { sql: string; params: string[] } {
  const token = likeToken(language);
  if (!token) return { sql: "0", params: [] };
  return {
    sql: `(
      subtitle_wanted LIKE ? ESCAPE '\\'
      OR (kind = 'movie' AND has_file = 1 AND NOT subtitle_languages LIKE ? ESCAPE '\\')
      OR EXISTS (
        SELECT 1 FROM catalog_episodes e
        WHERE e.catalog_id = catalog_titles.id
          AND (
            (e.has_file = 1 AND NOT e.subtitle_languages LIKE ? ESCAPE '\\')
            OR e.subtitle_wanted LIKE ? ESCAPE '\\'
          )
      )
    )`,
    params: [token, token, token, token],
  };
}

function genreFilledSql(): string {
  return `(
    (genres IS NOT NULL AND genres != '' AND genres != '[]')
    OR EXISTS (
      SELECT 1 FROM enrichment e
      WHERE e.match_key = catalog_titles.match_key
        AND e.genres IS NOT NULL AND e.genres != '' AND e.genres != '[]'
    )
  )`;
}

function displayedContentRating(): string {
  return `UPPER(TRIM(COALESCE(
    NULLIF(catalog_titles.content_rating, ''),
    (SELECT NULLIF(e.content_rating, '') FROM enrichment e WHERE e.match_key = catalog_titles.match_key LIMIT 1)
  )))`;
}

function displayedScore(): string {
  return `COALESCE(
    catalog_titles.rating,
    (SELECT e.rating FROM enrichment e WHERE e.match_key = catalog_titles.match_key LIMIT 1)
  )`;
}

function numberValue(value: string): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function compare(column: string, op: FilterOp, value: number): { sql: string; params: number[] } | null {
  const symbol = op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : op === "lte" ? "<=" : op === "eq" ? "=" : null;
  if (!symbol) return null;
  return { sql: `${column} ${symbol} ?`, params: [value] };
}

const UNKNOWN = "unknown";

function isUnknown(value: string): boolean {
  return value.trim().toLowerCase() === UNKNOWN;
}

function blankLanguages(scope: "language" | "audio" | "subtitles"): string {
  const columns =
    scope === "audio" ? ["audio_languages"] : scope === "subtitles" ? ["subtitle_languages"] : ["audio_languages", "subtitle_languages"];
  const blank = (column: string) => `(${column} IS NULL OR ${column} = '' OR ${column} = '[]')`;
  const title = columns.map(blank).join(" AND ");
  const episode = columns.map((column) => `NOT ${blank(`e.${column}`)}`).join(" OR ");
  return `(${title} AND NOT EXISTS (
    SELECT 1 FROM catalog_episodes e
    WHERE e.catalog_id = catalog_titles.id AND (${episode})
  ))`;
}

export function ruleClause(rule: FilterRule): { sql: string; params: Array<string | number> } | null {
  if (isUnknown(rule.value) && rule.op !== "empty" && rule.op !== "notEmpty") {
    if (rule.field === "language" || rule.field === "audio" || rule.field === "subtitles") {
      const blank = blankLanguages(rule.field);
      if (rule.op === "includes" || rule.op === "eq" || rule.op === "missing") return { sql: blank, params: [] };
      if (rule.op === "excludes" || rule.op === "neq") return { sql: `NOT ${blank}`, params: [] };
    }
    if (rule.field === "genre") {
      const filled = genreFilledSql();
      if (rule.op === "includes" || rule.op === "eq") return { sql: `NOT ${filled}`, params: [] };
      if (rule.op === "excludes" || rule.op === "neq") return { sql: filled, params: [] };
    }
    if (rule.field === "contentRating") {
      const column = displayedContentRating();
      if (rule.op === "eq" || rule.op === "includes") return { sql: `${column} IS NULL`, params: [] };
      if (rule.op === "neq" || rule.op === "excludes") return { sql: `${column} IS NOT NULL`, params: [] };
    }
    if (rule.field === "resolution") {
      const blank = `(resolution IS NULL OR resolution = '')`;
      if (rule.op === "eq") return { sql: blank, params: [] };
      if (rule.op === "neq") return { sql: `NOT ${blank}`, params: [] };
    }
    if (rule.field === "hdr") {
      const blank = `(hdr IS NULL OR hdr = '')`;
      if (rule.op === "eq") return { sql: blank, params: [] };
      if (rule.op === "neq") return { sql: `NOT ${blank}`, params: [] };
    }
    if (rule.field === "container") {
      const blank = `(container IS NULL OR TRIM(container) = '')`;
      if (rule.op === "eq") return { sql: blank, params: [] };
      if (rule.op === "neq") return { sql: `NOT ${blank}`, params: [] };
    }
    if (rule.field === "score" || rule.field === "year" || rule.field === "bitrate") {
      const column = rule.field === "score" ? displayedScore() : rule.field === "year" ? "year" : "bitrate_kbps";
      return { sql: `${column} IS NULL`, params: [] };
    }
  }

  if (rule.field === "language" || rule.field === "audio" || rule.field === "subtitles") {
    if (rule.op === "missing" && rule.field === "subtitles") return missingSubs(rule.value);
    const token = likeToken(rule.value);
    if (!token) return null;
    const present = languagePresent(rule.field);
    const params = Array.from({ length: present.split("?").length - 1 }, () => token);
    if (rule.op === "includes") return { sql: present, params };
    if (rule.op === "excludes") return { sql: `NOT ${present}`, params };
    return null;
  }

  if (rule.field === "genre") {
    if (rule.op === "empty") return { sql: `NOT ${genreFilledSql()}`, params: [] };
    if (rule.op === "notEmpty") return { sql: genreFilledSql(), params: [] };
    const token = likeToken(rule.value);
    if (!token) return null;
    const present = `(${jsonHas("genres")} OR EXISTS (
      SELECT 1 FROM enrichment e
      WHERE e.match_key = catalog_titles.match_key AND ${jsonHas("e.genres")}
    ))`;
    if (rule.op === "includes") return { sql: present, params: [token, token] };
    if (rule.op === "excludes") return { sql: `NOT ${present}`, params: [token, token] };
    return null;
  }

  if (rule.field === "contentRating") {
    const column = displayedContentRating();
    if (rule.op === "empty") return { sql: `${column} IS NULL`, params: [] };
    if (rule.op === "notEmpty") return { sql: `${column} IS NOT NULL`, params: [] };
    const value = rule.value.trim().toUpperCase();
    if (!value) return null;
    if (rule.op === "eq") return { sql: `${column} = ?`, params: [value] };
    if (rule.op === "neq") return { sql: `(${column} IS NULL OR ${column} != ?)`, params: [value] };
    return null;
  }

  if (rule.field === "score" || rule.field === "year" || rule.field === "bitrate") {
    const column = rule.field === "score" ? displayedScore() : rule.field === "year" ? "year" : "bitrate_kbps";
    if (rule.op === "empty") return { sql: `${column} IS NULL`, params: [] };
    if (rule.op === "notEmpty") return { sql: `${column} IS NOT NULL`, params: [] };
    const numeric = numberValue(rule.value);
    if (numeric == null) return null;
    const compared = rule.field === "bitrate" ? numeric * 1000 : numeric;
    return compare(column, rule.op, compared);
  }

  if (rule.field === "resolution") {
    if (rule.op === "empty") return { sql: `(resolution IS NULL OR resolution = '')`, params: [] };
    if (rule.op === "notEmpty") return { sql: `(resolution IS NOT NULL AND resolution != '')`, params: [] };
    const value = rule.value.trim();
    if (!value) return null;
    if (rule.op === "eq") return { sql: `(resolution = ? OR (',' || IFNULL(version_resolutions, '') || ',') LIKE ?)`, params: [value, `%,${value},%`] };
    if (rule.op === "neq") {
      return {
        sql: `((resolution IS NULL OR resolution != ?) AND (',' || IFNULL(version_resolutions, '') || ',') NOT LIKE ?)`,
        params: [value, `%,${value},%`],
      };
    }
  }

  if (rule.field === "hdr") {
    if (rule.op === "empty") return { sql: `(hdr IS NULL OR hdr = '')`, params: [] };
    if (rule.op === "notEmpty") return { sql: `(hdr IS NOT NULL AND hdr != '')`, params: [] };
    const value = rule.value.trim().toLowerCase() === "sdr" ? "none" : rule.value.trim();
    if (!value) return null;
    if (rule.op === "eq") return { sql: `(hdr = ? OR (',' || IFNULL(version_hdrs, '') || ',') LIKE ?)`, params: [value, `%,${value},%`] };
    if (rule.op === "neq") {
      return {
        sql: `((hdr IS NULL OR hdr != ?) AND (',' || IFNULL(version_hdrs, '') || ',') NOT LIKE ?)`,
        params: [value, `%,${value},%`],
      };
    }
  }

  if (rule.field === "container") {
    if (rule.op === "empty") return { sql: `(container IS NULL OR TRIM(container) = '')`, params: [] };
    if (rule.op === "notEmpty") return { sql: `(container IS NOT NULL AND TRIM(container) != '')`, params: [] };
    const value = rule.value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!value) return null;
    const present = `(',' || REPLACE(LOWER(COALESCE(container, '')), ' ', '') || ',') LIKE ?`;
    if (rule.op === "eq") return { sql: present, params: [`%,${value},%`] };
    if (rule.op === "neq") return { sql: `NOT ${present}`, params: [`%,${value},%`] };
  }

  if (rule.field === "file" && rule.op === "eq") {
    if (rule.value === "missing") {
      return {
        sql: "((kind = 'movie' AND has_file = 0) OR (kind = 'series' AND (missing_episode_count > 0 OR has_file = 0)))",
        params: [],
      };
    }
    if (rule.value === "present") return { sql: "has_file = 1", params: [] };
  }

  if (rule.field === "plex" && rule.op === "eq") {
    if (rule.value === "in") return { sql: "in_plex = 1", params: [] };
    if (rule.value === "out") return { sql: "in_plex = 0", params: [] };
  }

  if (rule.field === "playable" && rule.op === "eq") {
    if (rule.value === "video") return { sql: "playable_label = 'video'", params: [] };
    if (rule.value === "not-video") return { sql: "playable_label != 'video'", params: [] };
    if (rule.value === "disc") {
      return { sql: "playable_label IN ('disc', 'dvd', 'bluray', 'iso', 'dvd-iso', 'bluray-iso')", params: [] };
    }
    if (rule.value === "dvd") return { sql: "playable_label IN ('dvd', 'dvd-iso')", params: [] };
    if (rule.value === "bluray") return { sql: "playable_label IN ('bluray', 'bluray-iso')", params: [] };
    if (rule.value === "iso") return { sql: "playable_label IN ('iso', 'dvd-iso', 'bluray-iso')", params: [] };
  }

  if (rule.field === "suspect" && rule.op === "eq") {
    const present = `(',' || IFNULL(version_flags, '') || ',')`;
    if (rule.value === "sample") return { sql: `${present} LIKE '%,sample,%'`, params: [] };
    if (rule.value === "short") return { sql: `${present} LIKE '%,short,%'`, params: [] };
    if (rule.value === "either") return { sql: `IFNULL(version_flags, '') != ''`, params: [] };
  }

  if (rule.field === "stereo" && rule.op === "eq") {
    if (rule.value === "yes") return { sql: "is_3d = 1", params: [] };
    if (rule.value === "no") return { sql: "is_3d = 0", params: [] };
  }

  return null;
}

export function rulesWhere(rules: FilterRule[]): { clauses: string[]; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  for (const rule of rules) {
    const clause = ruleClause(rule);
    if (!clause) continue;
    clauses.push(clause.sql);
    params.push(...clause.params);
  }
  return { clauses, params };
}
