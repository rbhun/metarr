export function clampHour(value: unknown, fallback: number): number {
  const hour = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return fallback;
  return hour;
}

/** The window runs from the start hour until the end hour. An earlier end hour crosses midnight. */
export function inDetectWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** Identity of the current window, so the library scan runs once each time the window opens. */
export function windowKey(now: Date, start: number, end: number): string | null {
  if (!inDetectWindow(now.getHours(), start, end)) return null;
  const opened = new Date(now);
  opened.setMinutes(0, 0, 0);
  opened.setHours(start);
  if (opened.getTime() > now.getTime()) opened.setDate(opened.getDate() - 1);
  const month = String(opened.getMonth() + 1).padStart(2, "0");
  const day = String(opened.getDate()).padStart(2, "0");
  return `${opened.getFullYear()}-${month}-${day}T${String(start).padStart(2, "0")}`;
}
