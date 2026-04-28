/**
 * CRIT-02: Plugin Sandbox Runner
 *
 * Tier 1 — Capability-gated PluginContext based on declared permissions.
 * Tier 2 — vm.createContext() sandbox for executing untrusted code strings.
 *
 * Official/verified plugins run in-process with full context.
 * Community/unverified plugins receive a restricted context that hides
 * services they didn't declare in their permissions manifest.
 */

import vm from 'node:vm';
import type {
  PluginContext,
  PluginPermissions,
  ServiceContainer,
  PluginConfig,
} from './plugin-interface.js';
import type { IEventBus } from './core/interfaces/event.interface.js';

export interface SandboxConfig {
  timeout?: number;
}

const DEFAULT_SANDBOX_CONFIG: Required<SandboxConfig> = {
  timeout: 5000,
};

export class SandboxedPluginRunner {
  private config: Required<SandboxConfig>;

  constructor(config?: SandboxConfig) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  createSandboxContext(): vm.Context {
    // Only add non-ECMAScript globals. ECMAScript builtins (Object, Array,
    // Promise, Map, Set, JSON, Math, Date, RegExp, Symbol, parseInt, etc.)
    // are provided automatically by the V8 context as sandbox-local copies.
    // Passing the host's Object/Array would let sandbox code pollute the
    // host's prototypes — so we deliberately omit them.
    const sandbox: Record<string, unknown> = {
      console: Object.freeze({
        log: (...args: unknown[]) => console.log('[sandbox]', ...args),
        warn: (...args: unknown[]) => console.warn('[sandbox]', ...args),
        error: (...args: unknown[]) => console.error('[sandbox]', ...args),
        info: (...args: unknown[]) => console.info('[sandbox]', ...args),
      }),
    };

    return vm.createContext(sandbox, {
      name: 'plugin-sandbox',
      codeGeneration: { strings: false, wasm: false },
    });
  }

  runInSandbox(code: string, context?: vm.Context): unknown {
    const ctx = context ?? this.createSandboxContext();
    const script = new vm.Script(code, { filename: 'plugin-sandbox.js' });
    return script.runInContext(ctx, { timeout: this.config.timeout });
  }

  createRestrictedContext(
    baseContext: PluginContext,
    permissions: PluginPermissions,
    pluginName: string,
  ): PluginContext {
    const logger = baseContext.logger;

    const restrictedServices: ServiceContainer = {
      register<T>(_name: string, _service: T): void {
        throw new Error(`Plugin '${pluginName}' cannot register services in sandboxed mode`);
      },
      get<T>(name: string): T | undefined {
        if (!isServiceAllowed(name, permissions)) {
          logger.warn(`Plugin '${pluginName}' denied ${name} access — no permission`);
          return undefined;
        }
        return baseContext.services.get<T>(name);
      },
      has(name: string): boolean {
        if (!isServiceAllowed(name, permissions)) return false;
        return baseContext.services.has(name);
      },
      getServiceNames(): string[] {
        return baseContext.services.getServiceNames().filter(
          n => isServiceAllowed(n, permissions),
        );
      },
    };

    const restrictedConfig: PluginConfig = { ...baseContext.config };
    if (!permissions.env) {
      delete restrictedConfig['env'];
      delete restrictedConfig['envVars'];
    }

    const eventBus = (permissions.mcp || permissions.agents)
      ? baseContext.eventBus
      : createNoopEventBus();

    return {
      config: restrictedConfig,
      eventBus,
      logger: baseContext.logger,
      services: restrictedServices,
    };
  }
}

const SERVICE_PERMISSION_MAP: Record<string, keyof PluginPermissions> = {
  fs: 'filesystem',
  network: 'network',
  process: 'process',
  memory: 'memory',
  cli: 'cli',
};

function isServiceAllowed(name: string, permissions: PluginPermissions): boolean {
  const requiredPerm = SERVICE_PERMISSION_MAP[name];
  if (requiredPerm && !permissions[requiredPerm]) return false;
  return true;
}

function createNoopEventBus(): IEventBus {
  return new Proxy({} as IEventBus, {
    get: () => () => {},
  });
}
