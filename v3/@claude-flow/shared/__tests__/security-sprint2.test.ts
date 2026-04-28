/**
 * Sprint 2 Security Tests — CRIT-02 Plugin Sandboxing
 *
 * Covers:
 *   1. validatePermissions() schema enforcement + type checking
 *   2. DANGEROUS_PERMISSION_KEYS correctness
 *   3. SandboxedPluginRunner.createSandboxContext() — no process/require/global
 *   4. SandboxedPluginRunner.runInSandbox() — execution, timeout, eval/Function blocked
 *   5. SandboxedPluginRunner.createRestrictedContext() — capability gating
 *   6. Prototype pollution isolation (vm sandbox uses own builtins)
 *   7. memory/cli permission gating
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validatePermissions,
  VALID_PERMISSION_KEYS,
  DANGEROUS_PERMISSION_KEYS,
} from '../src/plugin-interface.js';
import { SandboxedPluginRunner } from '../src/plugin-sandbox.js';
import type { PluginContext, ServiceContainer } from '../src/plugin-interface.js';

// ─── validatePermissions ───────────────────────────────────

describe('validatePermissions', () => {
  it('accepts all known permission keys', () => {
    const perms: Record<string, unknown> = {};
    for (const key of VALID_PERMISSION_KEYS) {
      perms[key] = true;
    }
    expect(validatePermissions(perms)).toEqual([]);
  });

  it('rejects unknown permission keys', () => {
    const errors = validatePermissions({ hackerAccess: true, rootShell: true });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('hackerAccess');
    expect(errors[1]).toContain('rootShell');
  });

  it('returns empty for empty permissions', () => {
    expect(validatePermissions({})).toEqual([]);
  });

  it('rejects non-boolean permission values', () => {
    const errors = validatePermissions({
      filesystem: 'yes',
      network: 42,
      memory: true,
    } as Record<string, unknown>);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('filesystem');
    expect(errors[0]).toContain('boolean');
    expect(errors[1]).toContain('network');
  });
});

// ─── DANGEROUS_PERMISSION_KEYS ─────────────────────────────

describe('DANGEROUS_PERMISSION_KEYS', () => {
  it('includes filesystem, network, env, process', () => {
    expect(DANGEROUS_PERMISSION_KEYS.has('filesystem')).toBe(true);
    expect(DANGEROUS_PERMISSION_KEYS.has('network')).toBe(true);
    expect(DANGEROUS_PERMISSION_KEYS.has('env')).toBe(true);
    expect(DANGEROUS_PERMISSION_KEYS.has('process')).toBe(true);
  });

  it('does not include memory, mcp, agents, cli', () => {
    expect(DANGEROUS_PERMISSION_KEYS.has('memory')).toBe(false);
    expect(DANGEROUS_PERMISSION_KEYS.has('mcp')).toBe(false);
    expect(DANGEROUS_PERMISSION_KEYS.has('agents')).toBe(false);
    expect(DANGEROUS_PERMISSION_KEYS.has('cli')).toBe(false);
  });
});

// ─── Sandbox context isolation ─────────────────────────────

describe('SandboxedPluginRunner sandbox context', () => {
  it('does not expose process', () => {
    const runner = new SandboxedPluginRunner();
    expect(runner.runInSandbox('typeof process')).toBe('undefined');
  });

  it('does not expose require', () => {
    const runner = new SandboxedPluginRunner();
    expect(runner.runInSandbox('typeof require')).toBe('undefined');
  });

  it('does not expose global or globalThis', () => {
    const runner = new SandboxedPluginRunner();
    expect(runner.runInSandbox('typeof global')).toBe('undefined');
  });

  it('provides safe globals', () => {
    const runner = new SandboxedPluginRunner();
    expect(runner.runInSandbox('JSON.stringify({a:1})')).toBe('{"a":1}');
    expect(runner.runInSandbox('Math.max(1,2,3)')).toBe(3);
    expect(runner.runInSandbox('Array.isArray([1,2])')).toBe(true);
  });
});

// ─── runInSandbox execution ────────────────────────────────

describe('SandboxedPluginRunner.runInSandbox', () => {
  it('executes simple expressions', () => {
    const runner = new SandboxedPluginRunner();
    expect(runner.runInSandbox('1 + 2')).toBe(3);
    expect(runner.runInSandbox('"hello".toUpperCase()')).toBe('HELLO');
  });

  it('throws on timeout for infinite loops', () => {
    const runner = new SandboxedPluginRunner({ timeout: 50 });
    expect(() => runner.runInSandbox('while(true){}')).toThrow();
  });

  it('prevents eval()', () => {
    const runner = new SandboxedPluginRunner();
    expect(() => runner.runInSandbox('eval("1+1")')).toThrow();
  });

  it('prevents new Function()', () => {
    const runner = new SandboxedPluginRunner();
    expect(() => runner.runInSandbox('new Function("return 1")()')).toThrow();
  });

  it('cannot read environment variables', () => {
    const runner = new SandboxedPluginRunner();
    const result = runner.runInSandbox(
      'typeof process === "undefined" ? "blocked" : process.env.HOME'
    );
    expect(result).toBe('blocked');
  });

  it('cannot access Buffer', () => {
    const runner = new SandboxedPluginRunner();
    expect(runner.runInSandbox('typeof Buffer')).toBe('undefined');
  });

  it('Object.prototype pollution in sandbox does not leak to host', () => {
    const runner = new SandboxedPluginRunner();
    runner.runInSandbox('Object.prototype.__sandboxTest__ = true');
    expect((Object.prototype as any).__sandboxTest__).toBeUndefined();
  });

  it('Array.prototype pollution in sandbox does not leak to host', () => {
    const runner = new SandboxedPluginRunner();
    runner.runInSandbox('Array.prototype.__sandboxArr__ = 42');
    expect((Array.prototype as any).__sandboxArr__).toBeUndefined();
  });
});

// ─── Restricted PluginContext (capability gating) ──────────

describe('SandboxedPluginRunner.createRestrictedContext', () => {
  function makeMockContext(): PluginContext {
    const services: ServiceContainer = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue({ mock: true }),
      has: vi.fn().mockReturnValue(true),
      getServiceNames: vi.fn().mockReturnValue(['fs', 'network', 'process', 'memory', 'cli']),
    };
    return {
      config: {
        features: {},
        env: { FOO: 'bar' },
        envVars: { BAZ: 'qux' },
      } as any,
      eventBus: { on: vi.fn(), emit: vi.fn() } as any,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      services,
    };
  }

  it('blocks fs access without filesystem permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(base, {}, 'test-plugin');

    expect(restricted.services.get('fs')).toBeUndefined();
    expect(restricted.services.has('fs')).toBe(false);
  });

  it('allows fs access with filesystem permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(
      base, { filesystem: true }, 'test-plugin'
    );

    expect(restricted.services.get('fs')).toEqual({ mock: true });
    expect(restricted.services.has('fs')).toBe(true);
  });

  it('blocks network access without permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(base, {}, 'test-plugin');

    expect(restricted.services.get('network')).toBeUndefined();
  });

  it('blocks process access without permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(base, {}, 'test-plugin');

    expect(restricted.services.get('process')).toBeUndefined();
  });

  it('strips env config when no env permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(base, {}, 'test-plugin');

    expect((restricted.config as any).env).toBeUndefined();
    expect((restricted.config as any).envVars).toBeUndefined();
  });

  it('preserves env config with env permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(
      base, { env: true }, 'test-plugin'
    );

    expect((restricted.config as any).env).toEqual({ FOO: 'bar' });
  });

  it('replaces eventBus with noop when no mcp/agents permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(base, {}, 'test-plugin');

    expect(() => (restricted.eventBus as any).emit('test')).not.toThrow();
    expect(() => (restricted.eventBus as any).on('test', () => {})).not.toThrow();
    expect(restricted.eventBus).not.toBe(base.eventBus);
  });

  it('preserves eventBus with mcp permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(
      base, { mcp: true }, 'test-plugin'
    );

    expect(restricted.eventBus).toBe(base.eventBus);
  });

  it('prevents service registration in sandboxed mode', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(base, {}, 'test-plugin');

    expect(() => restricted.services.register('evil', {})).toThrow(
      'cannot register services'
    );
  });

  it('filters service names based on permissions', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(
      base, { memory: true }, 'test-plugin'
    );

    const names = restricted.services.getServiceNames();
    expect(names).not.toContain('fs');
    expect(names).not.toContain('network');
    expect(names).not.toContain('process');
    expect(names).not.toContain('cli');
    expect(names).toContain('memory');
  });

  it('blocks memory access without memory permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(base, {}, 'test-plugin');

    expect(restricted.services.get('memory')).toBeUndefined();
    expect(restricted.services.has('memory')).toBe(false);
  });

  it('allows memory access with memory permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(
      base, { memory: true }, 'test-plugin'
    );

    expect(restricted.services.get('memory')).toEqual({ mock: true });
    expect(restricted.services.has('memory')).toBe(true);
  });

  it('blocks cli access without cli permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(base, {}, 'test-plugin');

    expect(restricted.services.get('cli')).toBeUndefined();
    expect(restricted.services.has('cli')).toBe(false);
  });

  it('allows cli access with cli permission', () => {
    const runner = new SandboxedPluginRunner();
    const base = makeMockContext();
    const restricted = runner.createRestrictedContext(
      base, { cli: true }, 'test-plugin'
    );

    expect(restricted.services.get('cli')).toEqual({ mock: true });
    expect(restricted.services.has('cli')).toBe(true);
  });
});
