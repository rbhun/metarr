"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  defaultRule,
  fieldOps,
  type FilterField,
  type FilterOp,
  type FilterRule,
} from "@/lib/filters";
import { CONTENT_RATING_OPTIONS, languageOptions } from "@/lib/media";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

const FIELD_LABEL: Record<FilterField, string> = {
  language: "Any language",
  audio: "Audio language",
  subtitles: "Subtitle language",
  genre: "Genre",
  contentRating: "Content rating",
  score: "Score",
  bitrate: "Bitrate",
  year: "Year",
  resolution: "Resolution",
  hdr: "HDR",
  container: "File type",
  file: "File",
  plex: "Plex",
  playable: "Playable",
  stereo: "3D",
  suspect: "Sample or short",
};

const OP_LABEL: Record<FilterOp, string> = {
  includes: "has",
  excludes: "does not have",
  missing: "missing on files",
  empty: "is empty",
  notEmpty: "is filled",
  eq: "is",
  neq: "is not",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};

const PRESETS: Array<{ label: string; rule: Omit<FilterRule, "id"> }> = [
  { label: "Missing", rule: { field: "file", op: "eq", value: "missing" } },
  { label: "Not in Plex", rule: { field: "plex", op: "eq", value: "out" } },
  { label: "Disc / not playable", rule: { field: "playable", op: "eq", value: "not-video" } },
  { label: "No English subs", rule: { field: "subtitles", op: "missing", value: "English" } },
  { label: "3D only", rule: { field: "stereo", op: "eq", value: "yes" } },
  { label: "Hungarian", rule: { field: "language", op: "includes", value: "Hungarian" } },
  { label: "Sample or short", rule: { field: "suspect", op: "eq", value: "either" } },
];

const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

const FILE_TYPES = ["mkv", "mp4", "m4v", "avi", "ts", "mov", "m2ts", "mpg", "webm", "wmv", "iso", "img"];

function unknownOption() {
  return <option value="unknown">Unknown</option>;
}

function needsValue(rule: FilterRule): boolean {
  return rule.op !== "empty" && rule.op !== "notEmpty";
}

function ValueControl({ rule, onChange }: { rule: FilterRule; onChange: (value: string) => void }) {
  if (!needsValue(rule)) return null;
  if (rule.field === "language" || rule.field === "audio" || rule.field === "subtitles") {
    return (
      <select className={selectClass} aria-label="Language" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        {languageOptions().map((language) => (
          <option key={language} value={language}>
            {language}
          </option>
        ))}
        {unknownOption()}
      </select>
    );
  }
  if (rule.field === "contentRating") {
    return (
      <select className={selectClass} aria-label="Content rating" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        {CONTENT_RATING_OPTIONS.map((rating) => (
          <option key={rating} value={rating}>
            {rating}
          </option>
        ))}
        {unknownOption()}
      </select>
    );
  }
  if (rule.field === "resolution") {
    return (
      <select className={selectClass} aria-label="Resolution" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        {["480p", "576p", "720p", "1080p", "2160p"].map((resolution) => (
          <option key={resolution} value={resolution}>
            {resolution}
          </option>
        ))}
        {unknownOption()}
      </select>
    );
  }
  if (rule.field === "hdr") {
    return (
      <select className={selectClass} aria-label="HDR" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        {["Dolby Vision", "HDR10+", "HDR10", "HLG"].map((hdr) => (
          <option key={hdr} value={hdr}>
            {hdr}
          </option>
        ))}
        <option value="sdr">SDR</option>
        {unknownOption()}
      </select>
    );
  }
  if (rule.field === "container") {
    return (
      <select className={selectClass} aria-label="File type" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        {FILE_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
        {unknownOption()}
      </select>
    );
  }
  if (rule.field === "file") {
    return (
      <select className={selectClass} aria-label="File" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        <option value="missing">missing</option>
        <option value="present">on disk</option>
      </select>
    );
  }
  if (rule.field === "plex") {
    return (
      <select className={selectClass} aria-label="Plex" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        <option value="in">in Plex</option>
        <option value="out">not in Plex</option>
      </select>
    );
  }
  if (rule.field === "playable") {
    return (
      <select className={selectClass} aria-label="Playable" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        <option value="video">video file</option>
        <option value="dvd">DVD</option>
        <option value="bluray">Blu-ray</option>
        <option value="iso">ISO</option>
        <option value="disc">any disc</option>
        <option value="not-video">disc or missing</option>
      </select>
    );
  }
  if (rule.field === "suspect") {
    return (
      <select className={selectClass} aria-label="Sample or short" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        <option value="either">sample or short</option>
        <option value="sample">named sample</option>
        <option value="short">suspiciously short</option>
      </select>
    );
  }
  if (rule.field === "stereo") {
    return (
      <select className={selectClass} aria-label="3D" value={rule.value} onChange={(event) => onChange(event.target.value)}>
        <option value="yes">3D</option>
        <option value="no">2D</option>
      </select>
    );
  }
  const numeric = rule.field === "score" || rule.field === "bitrate" || rule.field === "year";
  const unknown = rule.value === "unknown";
  return (
    <div className="flex items-center gap-1.5">
      <select
        className={selectClass}
        aria-label={`${FIELD_LABEL[rule.field]} value`}
        value={unknown ? "unknown" : "set"}
        onChange={(event) => onChange(event.target.value === "unknown" ? "unknown" : rule.field === "genre" ? "" : rule.field === "bitrate" ? "10" : rule.field === "score" ? "7" : "2000")}
      >
        <option value="set">{rule.field === "genre" ? "Named" : "A number"}</option>
        {unknownOption()}
      </select>
      {unknown ? null : (
        <Input
          className="w-24"
          aria-label={FIELD_LABEL[rule.field]}
          inputMode={numeric ? "decimal" : "text"}
          value={rule.value}
          placeholder={rule.field === "genre" ? "Drama" : rule.field === "bitrate" ? "10" : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {!unknown && rule.field === "bitrate" ? <span className="text-xs text-muted-foreground">Mbps</span> : null}
      {!unknown && rule.field === "score" ? <span className="text-xs text-muted-foreground">/ 10</span> : null}
    </div>
  );
}

export function LibraryFilters({
  rules,
  onChange,
}: {
  rules: FilterRule[];
  onChange: (rules: FilterRule[]) => void;
}) {
  function update(id: string, patch: Partial<FilterRule>) {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  }

  function changeField(id: string, field: FilterField) {
    const next = defaultRule(id, field);
    update(id, next);
  }

  function add(partial?: Omit<FilterRule, "id">) {
    const id = `f-${Date.now().toString(36)}-${rules.length}`;
    const rule = partial ? { ...partial, id } : defaultRule(id, "language");
    if (partial) rule.op = fieldOps(partial.field).includes(partial.op) ? partial.op : fieldOps(partial.field)[0];
    onChange([...rules, rule]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((preset) => {
          const on = rules.some((rule) => rule.field === preset.rule.field && rule.op === preset.rule.op && rule.value === preset.rule.value);
          return (
            <Button
              key={preset.label}
              size="sm"
              variant={on ? "default" : "outline"}
              aria-pressed={on}
              onClick={() => {
                if (on) onChange(rules.filter((rule) => !(rule.field === preset.rule.field && rule.op === preset.rule.op && rule.value === preset.rule.value)));
                else add(preset.rule);
              }}
            >
              {preset.label}
            </Button>
          );
        })}
        <Button size="sm" variant="outline" onClick={() => add()}>
          Add filter
        </Button>
        {rules.length ? (
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>
            Clear
          </Button>
        ) : null}
      </div>
      {rules.length ? (
        <div className="flex flex-col gap-1.5">
          {rules.map((rule) => (
            <div key={rule.id} className="flex flex-wrap items-center gap-1.5">
              <select
                className={selectClass}
                aria-label="Filter field"
                value={rule.field}
                onChange={(event) => changeField(rule.id, event.target.value as FilterField)}
              >
                {(Object.keys(FIELD_LABEL) as FilterField[]).map((field) => (
                  <option key={field} value={field}>
                    {FIELD_LABEL[field]}
                  </option>
                ))}
              </select>
              <select
                className={cn(selectClass, "max-w-44")}
                aria-label="Filter match"
                value={rule.op}
                onChange={(event) => update(rule.id, { op: event.target.value as FilterOp })}
              >
                {fieldOps(rule.field).map((op) => (
                  <option key={op} value={op}>
                    {OP_LABEL[op]}
                  </option>
                ))}
              </select>
              <ValueControl rule={rule} onChange={(value) => update(rule.id, { value })} />
              <Button size="icon-sm" variant="ghost" aria-label="Remove filter" onClick={() => onChange(rules.filter((item) => item.id !== rule.id))}>
                <X />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Add a filter to match a language, an empty genre, a content rating such as PG, or a bitrate above a number of Mbps.
        </p>
      )}
    </div>
  );
}
