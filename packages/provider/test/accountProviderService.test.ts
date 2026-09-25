import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountProviderService,
  ModelConfigRules,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderTemplateMap,
  createAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type AccountProviderResolver,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "../src/index.js";

class MutableConfigSource implements ProviderSource<ProviderConfigSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(private snapshot: ProviderConfigSnapshot) {}

  async read(): Promise<ProviderConfigSnapshot> {
    return this.snapshot;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replace(snapshot: ProviderConfigSnapshot): void {
    this.snapshot = snapshot;
  }

  emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

function createConfigSnapshot(revision: string): ProviderConfigSnapshot {
  return {
    revision,
    zcodeBuiltinRevision: "builtin-1",
    personalRevision: "personal-1",
    zcodeBuiltinProviders: ProviderConfigMap.empty(),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
  };
}

function createResolver(calls: string[]): AccountProviderResolver {
  return async ({ configRevision }) => {
    calls.push(configRevision);
    return {
      providers: ProviderConfigMap.empty(),
      states: {
        "account:zai": {
          availability: "available",
          entitled: true,
          current: true,
          effectiveAt: calls.length,
        },
      },
    };
  };
}

test("AccountProviderService ignores Personal config events but refreshes Built-in events", async () => {
  const configSource = new MutableConfigSource(createConfigSnapshot("config-1"));
  const calls: string[] = [];
  const service = new AccountProviderService({
    configSource,
    resolve: createResolver(calls),
  });

  try {
    const initial = await service.read();
    assert.equal(calls.length, 1);
    assert.equal(initial.revision.includes("account:"), true);

    configSource.emit("personal:updated");
    await service.read();
    assert.equal(calls.length, 1);

    const changed = new Promise<AccountProviderConfigSnapshot>((resolve) => {
      const dispose = service.onDidChange(() => {
        dispose();
        resolve(initial);
      });
    });
    configSource.emit("zcodeBuiltin:updated");
    await changed;
    assert.equal(calls.length, 2);

    await service.refresh("auth");
    assert.equal(calls.length, 3);
  } finally {
    service.dispose();
  }
});

test("Personal config events still refresh Provider Registry", async () => {
  const configSource = new MutableConfigSource(createConfigSnapshot("config-1"));
  const accountSource: ProviderSource<AccountProviderConfigSnapshot> = {
    async read() {
      return createAccountProviderConfigSnapshot("builtin-1", ProviderConfigMap.empty());
    },
    onDidChange() {
      return () => {};
    },
  };
  const service = new ProviderRegistryService({ configSource, accountSource });

  try {
    await service.start();
    assert.equal(service.getSnapshot()?.config.revision, "config-1");

    const changed = new Promise<ProviderConfigSnapshot>((resolve) => {
      const dispose = service.onDidChange((event) => {
        dispose();
        resolve(event.snapshot.config);
      });
    });
    configSource.replace(createConfigSnapshot("config-2"));
    configSource.emit("personal:updated");

    assert.equal((await changed).revision, "config-2");
  } finally {
    service.dispose();
  }
});
