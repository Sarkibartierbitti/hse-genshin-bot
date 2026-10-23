export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(value: number, timeZone: string): number[] {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    // Time zones come from operator configuration, not arbitrary user input.
    formatters.set(timeZone, formatter);
  }
  const values = formatter.formatToParts(value);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(
    (key) => Number(values.find((part) => part.type === key)?.value),
  );
}

function utcTime(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  // Date.UTC treats years 0–99 as 1900–1999, so set the full year explicitly.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** A strict wall-clock date. Invalid dates and daylight-saving gaps are rejected. */
export function parseDateTime(input: string, timeZone = 'Europe/Moscow'): number | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const [, dayText, monthText, yearText, hourText, minuteText] = match;
  const expected = [Number(yearText), Number(monthText), Number(dayText), Number(hourText), Number(minuteText), 0];
  const [year, month, day, hour, minute] = expected;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wallTime = utcTime(year, month, day, hour, minute);
  const calendar = new Date(wallTime);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return null;

  try {
    let candidate = wallTime;
    for (let attempt = 0; attempt < 4; attempt++) {
      const actual = parts(candidate, timeZone);
      if (actual.every((value, index) => value === expected[index])) return candidate;
      candidate += wallTime - utcTime(actual[0], actual[1], actual[2], actual[3], actual[4], actual[5]);
    }
    return null;
  } catch {
    return null;
  }
}

export function formatDateTime(value: number | null, timeZone = 'Europe/Moscow'): string {
  if (value === null || !Number.isFinite(value)) return 'не указано';
  try {
    const [year, month, day, hour, minute] = parts(value, timeZone);
    const pad = (number: number) => String(number).padStart(2, '0');
    return `${pad(day)}.${pad(month)}.${String(year).padStart(4, '0')} ${pad(hour)}:${pad(minute)}`;
  } catch {
    return 'не указано';
  }
}
