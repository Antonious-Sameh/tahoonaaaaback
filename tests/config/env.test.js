import { describe, it, expect, vi, afterEach } from 'vitest';

const configSpy = vi.fn();
vi.mock('dotenv', () => ({ default: { config: configSpy } }));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('env loading', () => {
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    configSpy.mockClear();
    vi.resetModules();
  });

  it('never reads the real .env under tests (keeps the live database out of reach)', async () => {
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    await import('../../src/config/env.js');
    expect(configSpy).not.toHaveBeenCalled();
  });

  it('still reads .env when the shop actually runs', async () => {
    process.env.NODE_ENV = 'development';
    vi.resetModules();
    await import('../../src/config/env.js');
    expect(configSpy).toHaveBeenCalledTimes(1);
  });
});
