import { createInstance } from '@module-federation/runtime';
import type {
  AssetRequestContext,
  ModuleFederationRuntimePlugin,
} from '@module-federation/runtime';
import {
  assetRequestContextProducerPlugin,
  installAssetRequestContextChunkLoading,
  rewriteCssUrls,
} from '../src/assetRequestContext';
import { loadEntryWithRequest, loadScriptEntryWithRequest } from '../src/index';
import { initContainerEntry } from '../src/initContainerEntry';
import { loadModule } from '../src/blobLoad';
import type { WebpackRequire } from '../src/types';

const okResponse = (text: string) =>
  ({ ok: true, status: 200, text: () => Promise.resolve(text) }) as Response;
const errorResponse = (status: number) =>
  ({
    ok: false,
    status,
    statusText: 'Unauthorized',
    text: () => Promise.resolve(''),
  }) as Response;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createWebpackRequire(overrides: Partial<WebpackRequire> = {}) {
  const instance = {
    options: {} as Record<string, any>,
    initOptions: jest.fn((options: Record<string, any>) => {
      instance.options = { ...instance.options, ...options };
    }),
    initShareScopeMap: jest.fn(),
  };
  return {
    S: {},
    I: jest.fn(),
    federation: {
      instance,
      initOptions: { name: 'producer' },
    },
    ...overrides,
  } as unknown as WebpackRequire & {
    federation: { instance: typeof instance };
  };
}

// Stands in for the browser running an appended script: sets the container
// global and fires onload.
function mockScriptAppend(globalName: string, container: unknown) {
  return jest
    .spyOn(document.head, 'appendChild')
    .mockImplementation((node: any) => {
      if (node.tagName === 'SCRIPT') {
        (globalThis as any)[globalName] = container;
        Promise.resolve().then(() => node.onload());
      }
      return node;
    });
}

let blobCount = 0;
beforeEach(() => {
  blobCount = 0;
  URL.createObjectURL = jest.fn(() => `blob:test/${++blobCount}`);
  URL.revokeObjectURL = jest.fn();
  document.head.innerHTML = '';
  loadModule.clearCache();
});

describe('loadScriptEntryWithRequest', () => {
  it('runs the entry from a blob url that reports the real url as src', async () => {
    const entry = 'https://b.com/remoteEntry.js';
    const request = jest.fn().mockResolvedValue(okResponse('/* entry */'));
    const container = { init: jest.fn(), get: jest.fn() };
    const appendChild = mockScriptAppend('remote_script', container);
    try {
      await expect(
        loadScriptEntryWithRequest({
          entry,
          name: 'remote',
          globalName: 'remote_script',
          request,
        }),
      ).resolves.toBe(container);
      const script = appendChild.mock.calls[0][0] as HTMLScriptElement;
      expect(script.getAttribute('src')).toBe('blob:test/1');
      // webpack's publicPath "auto" reads document.currentScript.src
      expect(script.src).toBe(entry);
      expect(request).toHaveBeenCalledWith(entry, expect.any(Object));
    } finally {
      appendChild.mockRestore();
      delete (globalThis as any).remote_script;
    }
  });

  it('returns a container already registered on the global', async () => {
    const container = { init: jest.fn(), get: jest.fn() };
    (globalThis as any).remote_loaded = container;
    const request = jest.fn();
    try {
      await expect(
        loadScriptEntryWithRequest({
          entry: 'https://b.com/remoteEntry.js',
          name: 'remote',
          globalName: 'remote_loaded',
          request,
        }),
      ).resolves.toBe(container);
      expect(request).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as any).remote_loaded;
    }
  });

  it('reports a failed request as RUNTIME-008', async () => {
    const request = jest.fn().mockResolvedValue(errorResponse(401));
    await expect(
      loadScriptEntryWithRequest({
        entry: 'https://b.com/remoteEntry.js',
        name: 'remote',
        globalName: 'remote_missing',
        request,
      }),
    ).rejects.toThrow(/RUNTIME-008[\s\S]*BlobLoaderNetworkError: 401/);
  });
});

describe('loadEntryWithRequest', () => {
  it('imports the entry from a blob url built from the requested code', async () => {
    const entry = 'https://b.com/remoteEntry.mjs';
    const request = jest
      .fn()
      .mockResolvedValue(okResponse('export const init = () => {};'));
    const blobParts: string[] = [];
    const OriginalBlob = globalThis.Blob;
    globalThis.Blob = jest.fn((parts: string[]) => {
      blobParts.push(...parts);
      return {} as Blob;
    }) as unknown as typeof Blob;
    const container = { init: jest.fn(), get: jest.fn() };
    // jest cannot import blob urls; stand in for the browser's import().
    jest.doMock('blob:test/1', () => container, { virtual: true });
    try {
      await expect(
        loadEntryWithRequest({ entry, name: 'remote', request }),
      ).resolves.toMatchObject({ init: container.init, get: container.get });
      expect(request).toHaveBeenCalledWith(entry, expect.any(Object));
      expect(blobParts[0]).toBe('export const init = () => {};');
    } finally {
      globalThis.Blob = OriginalBlob;
      jest.dontMock('blob:test/1');
    }
  });

  it('reports a failed request as RUNTIME-008', async () => {
    const request = jest.fn().mockResolvedValue(errorResponse(401));
    await expect(
      loadEntryWithRequest({
        entry: 'https://b.com/remoteEntry.mjs',
        name: 'remote',
        request,
      }),
    ).rejects.toThrow(/RUNTIME-008[\s\S]*BlobLoaderNetworkError: 401/);
    expect(request).toHaveBeenCalledWith(
      'https://b.com/remoteEntry.mjs',
      expect.any(Object),
    );
  });
});

describe('user-written host plugin through the runtime', () => {
  it('recovers a failed entry request through loadEntryError and passes the context to container.init', async () => {
    const entry = 'https://b.com/flow/remoteEntry.js';
    const request = jest
      .fn()
      .mockResolvedValueOnce(errorResponse(401))
      .mockResolvedValue(okResponse('/* entry */'));
    const container = {
      init: jest.fn(),
      get: jest.fn(() => () => ({ value: 42 })),
    };
    const context: AssetRequestContext = { consumerId: 'host', request };
    // The host plugin from the runtime-api docs.
    const authPlugin: ModuleFederationRuntimePlugin = {
      name: 'auth-plugin',
      fetch(url, init) {
        return context.request!(url, init);
      },
      async loadEntry({ remoteInfo, remoteEntryExports }) {
        if (remoteEntryExports) return remoteEntryExports;
        if (remoteInfo.type === 'esm' || remoteInfo.type === 'module') {
          return loadEntryWithRequest({
            entry: remoteInfo.entry,
            name: remoteInfo.name,
            request: context.request!,
          });
        }
        return loadScriptEntryWithRequest({
          entry: remoteInfo.entry,
          name: remoteInfo.name,
          globalName: remoteInfo.entryGlobalName,
          request: context.request!,
        });
      },
      beforeInitContainer(args) {
        args.remoteEntryInitOptions.assetRequestContext ??= context;
        return args;
      },
    };
    // Same steps as the retry plugin: drop the failed loading promise, then
    // load the entry again.
    const loadEntryError = jest.fn(
      async ({ getRemoteEntry, globalLoading, uniqueKey, ...rest }) => {
        delete globalLoading[uniqueKey];
        return getRemoteEntry(rest);
      },
    );
    const recoveryPlugin: ModuleFederationRuntimePlugin = {
      name: 'recovery-plugin',
      loadEntryError,
    };
    const host = createInstance({
      name: 'flow_host',
      remotes: [{ name: 'flow_remote', entry }],
      plugins: [authPlugin, recoveryPlugin],
    });
    const appendChild = mockScriptAppend('flow_remote', container);
    try {
      await expect(host.loadRemote('flow_remote/thing')).resolves.toEqual({
        value: 42,
      });
      expect(loadEntryError).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(container.init.mock.calls[0][2].assetRequestContext).toBe(context);
    } finally {
      appendChild.mockRestore();
      delete (globalThis as any).flow_remote;
    }
  });
});

describe('assetRequestContextProducerPlugin', () => {
  // A producer whose runtime instance is real, so beforeInit and
  // formatOptions run as they do in a build.
  let producerCount = 0;
  function createProducer(overrides: Partial<WebpackRequire> = {}) {
    const name = `producer_${++producerCount}`;
    const webpackRequire = {
      S: {},
      I: jest.fn(),
      federation: { initOptions: { name } },
      ...overrides,
    } as unknown as WebpackRequire;
    const instance = createInstance({
      name,
      remotes: [],
      plugins: [assetRequestContextProducerPlugin(webpackRequire)],
    });
    webpackRequire.federation.instance = instance;
    return { webpackRequire, instance };
  }
  // The runtime options do not declare the field; formatOptions keeps it.
  const contextOf = (instance: { options: object }) =>
    (instance.options as { assetRequestContext?: AssetRequestContext })
      .assetRequestContext;
  const initContainer = (
    webpackRequire: WebpackRequire,
    assetRequestContext?: AssetRequestContext,
  ) =>
    initContainerEntry({
      webpackRequire,
      shareScope: {},
      shareScopeKey: 'default',
      remoteEntryInitOptions: {
        version: '1',
        shareScopeKeys: 'default',
        ...(assetRequestContext ? { assetRequestContext } : {}),
      },
    });

  it('does nothing when no context is passed', () => {
    const { webpackRequire, instance } = createProducer();
    expect(() => initContainer(webpackRequire)).not.toThrow();
    expect(contextOf(instance)).toBe(undefined);
    expect(webpackRequire.federation.hasAssetRequestContextChunkLoading).toBe(
      undefined,
    );
  });

  it('keeps the first consumer and refuses a different consumerId', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { webpackRequire, instance } = createProducer({
      f: {},
    } as Partial<WebpackRequire>);
    const first = { consumerId: 'a', request: jest.fn() };
    const second = { consumerId: 'b', request: jest.fn() };

    initContainer(webpackRequire, first);
    expect(contextOf(instance)).toBe(first);
    expect(webpackRequire.federation.hasAssetRequestContextChunkLoading).toBe(
      true,
    );

    initContainer(webpackRequire, second);
    expect(contextOf(instance)).toBe(first);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'keeps the assetRequestContext from consumer "a" and ignores the assetRequestContext from consumer "b"',
      ),
    );
    warn.mockRestore();
  });

  it('does not change the init options the consumer passed', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { webpackRequire } = createProducer();
    initContainer(webpackRequire, { consumerId: 'a', request: jest.fn() });
    const second = { consumerId: 'b', request: jest.fn() };
    const remoteEntryInitOptions = {
      version: '1',
      shareScopeKeys: 'default',
      assetRequestContext: second,
    };
    initContainerEntry({
      webpackRequire,
      shareScope: {},
      shareScopeKey: 'default',
      remoteEntryInitOptions,
    });
    expect(remoteEntryInitOptions.assetRequestContext).toBe(second);
    warn.mockRestore();
  });

  it('lets the same consumerId replace its context', () => {
    const { webpackRequire, instance } = createProducer();
    const first = { consumerId: 'a', request: jest.fn() };
    const refreshed = { consumerId: 'a', request: jest.fn() };
    initContainer(webpackRequire, first);
    initContainer(webpackRequire, refreshed);
    expect(contextOf(instance)).toBe(refreshed);
  });

  it('hands the context to a container without share scopes', () => {
    const { webpackRequire, instance } = createProducer({ S: undefined });
    const assetRequestContext = { consumerId: 'a', request: jest.fn() };
    expect(initContainer(webpackRequire, assetRequestContext)).toBe(undefined);
    expect(contextOf(instance)).toBe(assetRequestContext);
    expect(webpackRequire.I).not.toHaveBeenCalled();
    expect(webpackRequire.federation.hasAssetRequestContextChunkLoading).toBe(
      true,
    );
  });

  it('leaves a container without share scopes untouched without a context', () => {
    const webpackRequire = createWebpackRequire({ S: undefined });
    initContainer(webpackRequire);
    expect(
      webpackRequire.federation.instance.initOptions,
    ).not.toHaveBeenCalled();
  });
});

describe('producer chunk loading', () => {
  it('calls webpack script loader unchanged without a request', () => {
    const loadScript = jest.fn();
    const webpackRequire = createWebpackRequire({ l: loadScript });
    installAssetRequestContextChunkLoading(webpackRequire);
    const done = jest.fn();
    webpackRequire.l!('https://b.com/chunk.js', done, 'chunk', 'c1');
    expect(loadScript).toHaveBeenCalledWith(
      'https://b.com/chunk.js',
      done,
      'chunk',
      'c1',
    );
  });

  it('fetches script chunks through request and runs them from a blob url', async () => {
    const loadScript = jest.fn();
    const webpackRequire = createWebpackRequire({ l: loadScript });
    const request = jest.fn().mockResolvedValue(okResponse('/* chunk */'));
    webpackRequire.federation.instance.options['assetRequestContext'] = {
      request,
    };
    installAssetRequestContextChunkLoading(webpackRequire);
    const done = jest.fn();
    webpackRequire.l!('https://b.com/chunk.js', done, 'chunk', 'c1');
    await flush();

    expect(request).toHaveBeenCalledWith(
      'https://b.com/chunk.js',
      expect.any(Object),
    );
    expect(loadScript).toHaveBeenCalledWith(
      'blob:test/1',
      expect.any(Function),
      'chunk',
      'c1',
    );
    loadScript.mock.calls[0][1]({ type: 'load', target: { src: 'blob:x' } });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
    expect(done).toHaveBeenCalledWith({
      type: 'load',
      target: { src: 'https://b.com/chunk.js' },
    });
  });

  it('reports a failed chunk request to done as an error event', async () => {
    const loadScript = jest.fn();
    const webpackRequire = createWebpackRequire({ l: loadScript });
    const request = jest.fn().mockResolvedValue(errorResponse(401));
    webpackRequire.federation.instance.options['assetRequestContext'] = {
      request,
    };
    installAssetRequestContextChunkLoading(webpackRequire);
    const done = jest.fn();
    webpackRequire.l!('https://b.com/chunk.js', done, 'chunk', 'c1');
    await flush();
    expect(loadScript).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith({
      type: 'error',
      target: { src: 'https://b.com/chunk.js' },
    });
  });

  // Mirrors the createStylesheet part of the mini-css-extract-plugin runtime.
  function createMiniCssHandler(fullhref: string) {
    return jest.fn((_chunkId: string | number, promises: Promise<any>[]) => {
      promises.push(
        new Promise<void>((resolve, reject) => {
          const linkTag = document.createElement('link');
          linkTag.rel = 'stylesheet';
          linkTag.onload = () => resolve();
          linkTag.onerror = () => reject(new Error('CSS_CHUNK_LOAD_FAILED'));
          linkTag.href = fullhref;
          document.head.appendChild(linkTag);
        }),
      );
    });
  }

  it('appends css chunk links unchanged without a request', () => {
    const handler = createMiniCssHandler('https://b.com/css/a.css');
    const webpackRequire = createWebpackRequire({
      f: { miniCss: handler },
    } as Partial<WebpackRequire>);
    installAssetRequestContextChunkLoading(webpackRequire);
    webpackRequire.f!['miniCss']('a', []);
    const link = document.head.querySelector('link')!;
    expect(link.getAttribute('href')).toBe('https://b.com/css/a.css');
    expect(
      Object.prototype.hasOwnProperty.call(document.head, 'appendChild'),
    ).toBe(false);
  });

  it('fetches css chunks through request before attaching the link', async () => {
    const handler = createMiniCssHandler('https://b.com/css/a.css');
    const webpackRequire = createWebpackRequire({
      f: { miniCss: handler },
    } as Partial<WebpackRequire>);
    const request = jest
      .fn()
      .mockResolvedValue(okResponse('.a{background:url(../img/a.png)}'));
    webpackRequire.federation.instance.options['assetRequestContext'] = {
      request,
    };
    installAssetRequestContextChunkLoading(webpackRequire);
    const blobParts: string[] = [];
    const OriginalBlob = globalThis.Blob;
    globalThis.Blob = jest.fn((parts: string[]) => {
      blobParts.push(...parts);
      return {} as Blob;
    }) as unknown as typeof Blob;

    try {
      const promises: Promise<any>[] = [];
      webpackRequire.f!['miniCss']('a', promises);
      // Held back until the request resolves; appendChild is restored.
      expect(document.head.querySelector('link')).toBe(null);
      expect(
        Object.prototype.hasOwnProperty.call(document.head, 'appendChild'),
      ).toBe(false);
      await flush();

      const link = document.head.querySelector('link')!;
      expect(request).toHaveBeenCalledWith(
        'https://b.com/css/a.css',
        expect.any(Object),
      );
      expect(link.getAttribute('href')).toBe('blob:test/1');
      expect(link.getAttribute('data-href')).toBe('https://b.com/css/a.css');
      expect(blobParts[0]).toBe('.a{background:url(https://b.com/img/a.png)}');
      link.onload!(new Event('load'));
      await expect(promises[0]).resolves.toBe(undefined);
    } finally {
      globalThis.Blob = OriginalBlob;
    }
  });

  it('fails the css chunk when the request fails', async () => {
    const handler = createMiniCssHandler('https://b.com/css/a.css');
    const webpackRequire = createWebpackRequire({
      f: { miniCss: handler },
    } as Partial<WebpackRequire>);
    const request = jest.fn().mockResolvedValue(errorResponse(401));
    webpackRequire.federation.instance.options['assetRequestContext'] = {
      request,
    };
    installAssetRequestContextChunkLoading(webpackRequire);
    const promises: Promise<any>[] = [];
    webpackRequire.f!['miniCss']('a', promises);
    await expect(promises[0]).rejects.toThrow('CSS_CHUNK_LOAD_FAILED');
    expect(document.head.querySelector('link')).toBe(null);
  });
});

describe('rewriteCssUrls', () => {
  const href = 'https://b.com/static/css/main.css';

  it('makes relative url() and @import references absolute', () => {
    expect(
      rewriteCssUrls(
        `@import "./base.css";.a{src:url('../font/a.woff2')}.b{background:url(img.png)}`,
        href,
      ),
    ).toBe(
      `@import "https://b.com/static/css/base.css";.a{src:url('https://b.com/static/font/a.woff2')}.b{background:url(https://b.com/static/css/img.png)}`,
    );
  });

  it('leaves absolute, data and fragment references alone', () => {
    const css =
      '.a{background:url(data:image/png;base64,AAA)}.b{background:url(https://c.com/x.png)}.c{fill:url(#g)}.d{background:url(//c.com/y.png)}';
    expect(rewriteCssUrls(css, href)).toBe(css);
  });
});

describe('init', () => {
  it('registers only the producer plugin, after the user plugins', () => {
    const { init } = require('../src/init');
    const runtimeInit = jest.fn();
    const userPlugin = { name: 'user-plugin' };
    init({
      webpackRequire: {
        federation: {
          runtime: { init: runtimeInit },
          initOptions: { name: 'host', plugins: [userPlugin] },
          bundlerRuntime: {},
        },
      },
    });
    const { plugins } = runtimeInit.mock.calls[0][0];
    expect(plugins[0]).toBe(userPlugin);
    expect(plugins[plugins.length - 1].name).toBe(
      'asset-request-context-producer-plugin',
    );
    expect(
      plugins.filter((plugin: { name: string }) =>
        plugin.name.startsWith('asset-request-context'),
      ),
    ).toHaveLength(1);
  });
});
