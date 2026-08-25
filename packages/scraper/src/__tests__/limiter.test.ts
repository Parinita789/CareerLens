import { describe, it, expect } from 'vitest';
import { Limiter } from '../common/limiter';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('Limiter', () => {
  it('never exceeds max concurrent operations', async () => {
    const limiter = new Limiter(3);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 30 }, () =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await tick(Math.random() * 5);
          running--;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(limiter.inFlight).toBe(0);
  });

  it('holds the cap when work is submitted from several independent producers', async () => {
    // The reason this class exists: parallel job sources each submitting their
    // own batches must still share one global budget.
    const limiter = new Limiter(3);
    let running = 0;
    let peak = 0;

    const producer = () =>
      (async () => {
        for (let i = 0; i < 8; i++) {
          await limiter.run(async () => {
            running++;
            peak = Math.max(peak, running);
            await tick(2);
            running--;
          });
        }
      })();

    await Promise.all([producer(), producer(), producer(), producer()]);

    expect(peak).toBeLessThanOrEqual(3);
    expect(limiter.inFlight).toBe(0);
  });

  it('serializes fully at max = 1', async () => {
    const limiter = new Limiter(1);
    const order: string[] = [];

    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        limiter.run(async () => {
          order.push(`${id}:start`);
          await tick(3);
          order.push(`${id}:end`);
        }),
      ),
    );

    // Every start is immediately followed by its own end — no interleaving.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].split(':')[0]).toBe(order[i + 1].split(':')[0]);
    }
    expect(limiter.inFlight).toBe(0);
  });

  it('releases the slot when the operation throws', async () => {
    const limiter = new Limiter(1);

    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(limiter.inFlight).toBe(0);
    // A rejected op must not wedge the limiter for everyone behind it.
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates the resolved value', async () => {
    const limiter = new Limiter(2);
    await expect(limiter.run(async () => 42)).resolves.toBe(42);
  });

  it('rejects a nonsensical max', () => {
    expect(() => new Limiter(0)).toThrow();
  });
});
