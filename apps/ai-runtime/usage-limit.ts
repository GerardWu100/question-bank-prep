import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface UsageLimits {
  /** Most model requests in any rolling 60 minutes; 0 turns this cap off. */
  perHour: number;
  /** Most model requests in any rolling 24 hours; 0 turns this cap off. */
  perDay: number;
}
export type UsageDecision = { allowed: true } | { allowed: false; window: 'hour' | 'day'; limit: number; retryAt: Date };

/**
 * Project-wide cap on model requests (Codex subscription or API key), so a leaked login
 * or a broken loop cannot drain the subscription or the API budget. One tutor reply is
 * one request plus one per tool round.
 *
 * State is a JSON file `{ "requests": [epochMs, ...] }` holding the request times of the
 * last 24 hours, oldest first, so a restart does not reset the count.
 */
export class ModelUsageLimit {
  private requests: number[] = [];

  constructor(private readonly limits: UsageLimits, private readonly stateFile?: string) {
    if (!stateFile) return;
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')).requests;
      if (Array.isArray(saved)) this.requests = saved.filter((time): time is number => Number.isFinite(time)).sort((a, b) => a - b);
    } catch { /* No file yet: start counting from zero. */ }
  }

  /** Count one request when both caps allow it; otherwise say which cap blocks it and until when. */
  take(now = Date.now()): UsageDecision {
    this.requests = this.requests.filter(time => time > now - DAY_MS);
    const lastHour = this.requests.filter(time => time > now - HOUR_MS);
    // The oldest request inside a full window is the one whose expiry frees the next slot.
    if (this.limits.perHour > 0 && lastHour.length >= this.limits.perHour)
      return { allowed: false, window: 'hour', limit: this.limits.perHour, retryAt: new Date(lastHour[lastHour.length - this.limits.perHour] + HOUR_MS) };
    if (this.limits.perDay > 0 && this.requests.length >= this.limits.perDay)
      return { allowed: false, window: 'day', limit: this.limits.perDay, retryAt: new Date(this.requests[this.requests.length - this.limits.perDay] + DAY_MS) };
    this.requests.push(now);
    this.save();
    return { allowed: true };
  }

  private save() {
    if (!this.stateFile) return;
    // Write a temporary file, then rename, so a crash never leaves half a JSON file.
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ requests: this.requests }));
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }
}
