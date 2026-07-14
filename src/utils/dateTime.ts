const DEFAULT_WCAST_TIME_ZONE = "Africa/Lagos";
const WCAST_TIME_ZONE_LABEL = "WCAST";

function resolveDisplayTimeZone(): string {
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return systemZone || DEFAULT_WCAST_TIME_ZONE;
}

function isWcastTimeZone(timeZone: string): boolean {
  return timeZone === DEFAULT_WCAST_TIME_ZONE;
}

export function getDisplayTimeZoneLabel(): string {
  const zone = resolveDisplayTimeZone();
  return isWcastTimeZone(zone) ? WCAST_TIME_ZONE_LABEL : "Local";
}

export function getDisplayTimeZoneName(): string {
  return resolveDisplayTimeZone();
}

function normalizeDateInput(value: Date | string | number): Date | string | number {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  const hasExplicitTimeZone = /(?:Z|[+\-]\d{2}:?\d{2})$/i.test(trimmed);
  const isIsoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(?:\.\d{1,6})?)?$/.test(trimmed);
  if (isIsoDateTime && !hasExplicitTimeZone) {
    return `${trimmed}Z`;
  }

  return value;
}

function resolveDate(value: Date | string | number): Date | null {
  const normalized = normalizeDateInput(value);
  const parsed = normalized instanceof Date ? normalized : new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function formatParts(value: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Intl.DateTimeFormat("en-GB", {
    timeZone: resolveDisplayTimeZone(),
    ...options,
  })
    .formatToParts(value)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});
}

export function formatDateDMY(value: Date | string | number): string {
  const parsed = resolveDate(value);
  if (!parsed) {
    return "N/A";
  }

  const parts = formatParts(parsed, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const day = parts.day || "--";
  const month = parts.month || "--";
  const year = parts.year || "----";
  return `${day}/${month}/${year}`;
}

export function formatDateTimeDMY(value: Date | string | number): string {
  const parsed = resolveDate(value);
  if (!parsed) {
    return "N/A";
  }

  const datePart = formatDateDMY(parsed);
  const parts = formatParts(parsed, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const hours = parts.hour || "--";
  const minutes = parts.minute || "--";
  const timePart = `${hours}:${minutes}`;

  return `${datePart} ${timePart}`;
}

export function formatTimeHM(value: Date | string | number): string {
  const parsed = resolveDate(value);
  if (!parsed) {
    return "N/A";
  }

  const parts = formatParts(parsed, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `${parts.hour || "--"}:${parts.minute || "--"}`;
}

export function formatDateReport(value: Date | string | number): string {
  const parsed = resolveDate(value);
  if (!parsed) {
    return "N/A";
  }

  const parts = formatParts(parsed, {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const day = parts.day || "--";
  const monthName = parts.month || "N/A";
  const year = parts.year || "----";
  return `${day} ${monthName}, ${year}`;
}
