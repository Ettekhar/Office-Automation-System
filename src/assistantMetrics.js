/** Persistent, privacy-light provider health metrics. No prompts, answers,
 * API keys, or user names are stored — only daily aggregate counters. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/assistant-metrics.json');
const empty = () => ({ version: 1, days: {} });
function read() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return empty(); } }
function write(value) { fs.writeFileSync(DATA_FILE, JSON.stringify(value, null, 2), 'utf8'); }
function dayKey() { return new Date().toISOString().slice(0, 10); }

export function recordProviderAnswer({ provider = 'unknown', position = 0, cached = false, inputChars = 0 } = {}) {
  const data = read(); const key = dayKey();
  const day = data.days[key] || { answers: 0, cached: 0, byProvider: {}, fallbackPosition4OrLater: 0, inputChars: 0 };
  day.answers += 1;
  day.cached += cached ? 1 : 0;
  day.inputChars += Math.max(0, Number(inputChars) || 0);
  // Positions 1–3 are the configured Gemini variants; position 4 onward is
  // where the real provider fallback begins in the standard chain.
  day.fallbackPosition4OrLater = (day.fallbackPosition4OrLater || 0) + (position >= 4 ? 1 : 0);
  day.byProvider[provider] = (day.byProvider[provider] || 0) + 1;
  data.days[key] = day;
  // Keep a compact 30-day trend.
  Object.keys(data.days).sort().slice(0, -30).forEach((old) => delete data.days[old]);
  write(data);
  return summarizeProviderMetrics(data);
}

export function summarizeProviderMetrics(data = read()) {
  const days = Object.entries(data.days || {}).sort(([a], [b]) => a.localeCompare(b));
  const totals = days.reduce((sum, [, day]) => ({
    answers: sum.answers + (day.answers || 0), cached: sum.cached + (day.cached || 0),
    fallbackPosition4OrLater: sum.fallbackPosition4OrLater + (day.fallbackPosition4OrLater || 0), inputChars: sum.inputChars + (day.inputChars || 0),
  }), { answers: 0, cached: 0, fallbackPosition4OrLater: 0, inputChars: 0 });
  return {
    windowDays: days.length,
    answers: totals.answers,
    cached: totals.cached,
    fallbackPosition4OrLater: totals.fallbackPosition4OrLater,
    fallbackPosition4OrLaterPercent: totals.answers ? Number((totals.fallbackPosition4OrLater / totals.answers * 100).toFixed(1)) : 0,
    averageInputChars: totals.answers ? Math.round(totals.inputChars / totals.answers) : 0,
    days: days.map(([date, day]) => ({ date, ...day })),
  };
}
