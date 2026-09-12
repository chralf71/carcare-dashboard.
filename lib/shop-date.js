const TIMEZONE = 'America/Chicago';
const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
function chicagoDate(value = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(value).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9998-12-31' || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('Invalid reporting date');
  return value;
}
function postedDay(value) {
  if (typeof value !== 'string') throw new Error('Invalid posted date');
  // Accounting dates remain dates; timestamps must carry an explicit timezone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validateDate(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Ambiguous posted date');
  validateDate(value.slice(0, 10));
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (hour > 23 || minute > 59 || second > 59) throw new Error('Invalid posted time');
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid posted date');
  return chicagoDate(instant);
}
function broadRange(date) {
  validateDate(date);
  const midnight = Date.parse(`${date}T00:00:00Z`);
  // Broad UTC envelope contains the entire Chicago day across DST changes.
  return { postedDateStart: new Date(midnight - 86400000).toISOString(), postedDateEnd: new Date(midnight + 2 * 86400000).toISOString() };
}
module.exports = { TIMEZONE, chicagoDate, validateDate, postedDay, broadRange };
