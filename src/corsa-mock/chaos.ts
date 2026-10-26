import { createHash } from 'node:crypto';
import { Config, FailureMode } from './config';
import { uniqueName } from './operations';
import { ObjectStore } from './store';

export interface ChaosDecision {
  /**
   * Set when this request must fail.
   */
  mode?: FailureMode;
  /**
   * Which attempt this is for the operation and key. Only counted when a seed is set.
   */
  attempt?: number;
}

/**
 * Decides which requests fail.
 *
 * Without a seed, each request fails at random with the configured percentage.
 *
 * With a seed, the decision is a hash of (seed, operation, key, attempt number). The
 * same zaak then gets the same pattern of failures and successes on every test run,
 * and a retry is a new attempt, so it can succeed where the previous one failed.
 * Attempts are counted in the store, at one object per attempt.
 */
export class Chaos {
  constructor(
    private readonly config: Config['failure'],
    private readonly store: ObjectStore,
    private readonly random: () => number = Math.random,
  ) {}

  async decide(operation: string, key: string): Promise<ChaosDecision> {
    const { percentage, operations, modes, seed } = this.config;
    if (percentage <= 0 || (operations.length > 0 && !operations.includes(operation))) {
      return {};
    }

    if (!seed) {
      return this.random() * 100 < percentage
        ? { mode: modes[Math.floor(this.random() * modes.length)] }
        : {};
    }

    const attempt = await this.recordAttempt(operation, key);
    const hash = createHash('sha256').update(`${seed}\n${operation}\n${key}\n${attempt}`).digest();
    const roll = (hash.readUInt32BE(0) / 2 ** 32) * 100;
    return roll < percentage
      ? { mode: modes[hash.readUInt32BE(4) % modes.length], attempt }
      : { attempt };
  }

  private async recordAttempt(operation: string, key: string): Promise<number> {
    const prefix = `chaos/attempts/${operation}/${encodeURIComponent(key || '_')}/`;
    await this.store.put(prefix + uniqueName(), '');
    return (await this.store.list(prefix)).length;
  }
}
