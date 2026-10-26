import { z } from "zod";

const MS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

const MAX_WINDOW_MS = 366 * MS.d;

const SHORTHAND_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i;

const ISO_RE =
  /^P(?!$)(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?!$)(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export class WindowError extends Error {
  statusCode = 422;
  code = "INVALID_WINDOW";
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

/**
 * Parse a window duration into milliseconds (#1187).
 * Accepts shorthand (`7d`, `12h`, `30m`) and ISO-8601 (`P7D`, `PT12H`).
 * Rejects windows longer than 366 days.
 */
export function parseWindow(raw: string): number {
  const value = raw.trim();
  if (!value) {
    throw new WindowError("Window must be a non-empty duration");
  }

  let ms: number | null = null;

  const shorthand = SHORTHAND_RE.exec(value);
  if (shorthand) {
    const amount = parseFloat(shorthand[1]);
    const unit = shorthand[2].toLowerCase() as keyof typeof MS;
    ms = amount * MS[unit];
  } else {
    const iso = ISO_RE.exec(value.toUpperCase());
    if (iso) {
      const [
        ,
        years = "0",
        months = "0",
        weeks = "0",
        days = "0",
        hours = "0",
        minutes = "0",
        seconds = "0",
      ] = iso;
      ms =
        parseFloat(years) * 365 * MS.d +
        parseFloat(months) * 30 * MS.d +
        parseFloat(weeks) * MS.w +
        parseFloat(days) * MS.d +
        parseFloat(hours) * MS.h +
        parseFloat(minutes) * MS.m +
        parseFloat(seconds) * MS.s;
    }
  }

  if (ms === null || !Number.isFinite(ms) || ms <= 0) {
    throw new WindowError(
      `Invalid window "${raw}": expected shorthand (7d, 12h) or ISO-8601 (P7D, PT12H)`,
    );
  }

  if (ms > MAX_WINDOW_MS) {
    throw new WindowError(`Window "${raw}" exceeds the maximum of 366 days`);
  }

  return ms;
}

/** Zod schema for a `window` query parameter backed by `parseWindow`. */
export const windowSchema = z.string().transform((raw, ctx) => {
  try {
    return parseWindow(raw);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : "Invalid window",
      params: { code: "INVALID_WINDOW", httpStatus: 422 },
    });
    return z.NEVER;
  }
});
