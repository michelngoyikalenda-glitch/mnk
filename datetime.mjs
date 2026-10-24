export const APP_TIME_ZONE = "Africa/Lubumbashi";
export const APP_LOCALE = "fr-FR";

export function dateToISO(date = new Date()) {
  const parts = new Intl.DateTimeFormat(APP_LOCALE, {
    timeZone: APP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function formatDateTime(value, options = { dateStyle: "short", timeStyle: "short" }) {
  return new Intl.DateTimeFormat(APP_LOCALE, { ...options, timeZone: APP_TIME_ZONE }).format(new Date(value));
}

export function formatDate(isoDate, options = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat(APP_LOCALE, { ...options, timeZone: "UTC" })
    .format(new Date(`${isoDate}T00:00:00.000Z`));
}

export function shiftDate(isoDate, amount, unit = "day") {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (unit === "month") {
    const targetMonth = month - 1 + amount;
    const targetYear = year + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
    return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
  }
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}
