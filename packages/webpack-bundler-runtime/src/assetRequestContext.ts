import { warn } from '@module-federation/sdk';
import {
  RUNTIME_001,
  RUNTIME_008,
  runtimeDescMap,
} from '@module-federation/error-codes';
import type {
  AssetRequestContext,
  ModuleFederationRuntimePlugin,
} from '@module-federation/runtime';
import type {
  RemoteEntryExports,
  RemoteEntryInitOptions,
  UserOptions,
} from '@module-federation/runtime/types';
import helpers from '@module-federation/runtime/helpers';
import { fetchText, loadEsmEntryWithFetch } from './blobLoad';
import { error } from './logger';
import type { WebpackRequire, WebpackLoadScriptEvent } from './types';

type AssetRequest = NonNullable<AssetRequestContext['request']>;

function isBrowser(): boolean {
  return typeof document !== 'undefined';
}

function createBlobUrl(code: string, type: string): string {
  return URL.createObjectURL(new Blob([code], { type }));
}

// Load a classic script through `request` and run it from a blob url.
// webpack's publicPath "auto" reads `document.currentScript.src`, so the
// script element reports the real url there instead of the blob url.
export function loadScriptWithFetch(
  url: string,
  request: AssetRequest,
): Promise<void> {
  return fetchText(url, { customFetch: request }).then(
    (code) =>
      new Promise<void>((resolve, reject) => {
        const blobUrl = createBlobUrl(code, 'application/javascript');
        const script = document.createElement('script');
        Object.defineProperty(script, 'src', {
          configurable: true,
          get: () => url,
        });
        script.setAttribute('src', blobUrl);
        const onScriptComplete = (type: 'load' | 'error') => {
          script.onload = null;
          script.onerror = null;
          script.parentNode && script.parentNode.removeChild(script);
          URL.revokeObjectURL(blobUrl);
          if (type === 'load') {
            resolve();
          } else {
            reject(
              new Error(
                `ScriptNetworkError: Failed to run script "${url}" loaded through assetRequestContext.request`,
              ),
            );
          }
        };
        script.onload = () => onScriptComplete('load');
        script.onerror = () => onScriptComplete('error');
        document.head.appendChild(script);
      }),
  );
}

// Load a `module`/`esm` remote entry through `request` and return the
// container's exports. For use in a host runtime plugin's `loadEntry` hook.
// Load failures are thrown as RUNTIME-008 so loadEntryError can recover.
export function loadEntryWithRequest({
  entry,
  name,
  request,
}: {
  entry: string;
  name: string;
  request: AssetRequest;
}): Promise<RemoteEntryExports> {
  return loadEsmEntryWithFetch({ entry, name, customFetch: request });
}

// Load a script remote entry (`var`, `global`, ...) through `request` and
// return the container's exports, read from `globalName` (pass
// `remoteInfo.entryGlobalName`). For use in a host runtime plugin's
// `loadEntry` hook. Same flow as loadEntryScript in runtime-core: reuse an
// already registered container, otherwise load the entry and read the
// container from its global. Load failures are thrown as RUNTIME-008 so
// loadEntryError can recover.
export async function loadScriptEntryWithRequest({
  entry,
  name,
  globalName,
  request,
}: {
  entry: string;
  name: string;
  globalName: string;
  request: AssetRequest;
}): Promise<RemoteEntryExports> {
  const { entryExports: remoteEntryExports } =
    helpers.global.getRemoteEntryExports(name, globalName);
  if (remoteEntryExports) {
    return remoteEntryExports;
  }

  try {
    await loadScriptWithFetch(entry, request);
  } catch (loadError) {
    error(
      RUNTIME_008,
      runtimeDescMap,
      { remoteName: name, resourceUrl: entry },
      loadError instanceof Error ? loadError.message : String(loadError),
    );
  }

  const { remoteEntryKey, entryExports } = helpers.global.getRemoteEntryExports(
    name,
    globalName,
  );
  if (!entryExports) {
    error(RUNTIME_001, runtimeDescMap, {
      remoteName: name,
      remoteEntryUrl: entry,
      remoteEntryKey,
    });
  }
  return entryExports;
}

// Producer side. initContainerEntry hands the `remoteEntryInitOptions` of a
// consumer's `container.init` to instance.initOptions, so the consumer's
// context arrives here as `userOptions.assetRequestContext`. The first
// consumerId keeps the container; the same consumerId may replace its context
// (for example to swap the request function after a token refresh). A context
// from a different consumerId is dropped with a warning.
export function assetRequestContextProducerPlugin(
  webpackRequire: WebpackRequire,
): ModuleFederationRuntimePlugin {
  return {
    name: 'asset-request-context-producer-plugin',
    beforeInit(args) {
      const { userOptions, options } = args;
      const assetRequestContext = userOptions.assetRequestContext;
      if (!assetRequestContext) {
        return args;
      }
      const current = options.assetRequestContext;
      if (current && current.consumerId !== assetRequestContext.consumerId) {
        warn(
          `Container "${options.name}" keeps the assetRequestContext from consumer "${current.consumerId}" and ignores the assetRequestContext from consumer "${assetRequestContext.consumerId}".`,
        );
        // formatOptions builds the new options from this userOptions object,
        // not from the one returned here, so the field is removed in place.
        delete userOptions.assetRequestContext;
        return args;
      }
      // During the instance's own setup `federation.instance` is not set yet.
      // Only a context handed over by a consumer's container.init changes how
      // the container's chunks are loaded.
      if (assetRequestContext.request && webpackRequire.federation?.instance) {
        installAssetRequestContextChunkLoading(webpackRequire);
      }
      return args;
    },
  };
}

// A container without share scopes (no `__webpack_require__.S`) returns from
// initContainerEntry before it calls initOptions, so beforeInit never sees the
// consumer's context. Pass it to initOptions here; without a context this
// does nothing.
export function initAssetRequestContext(
  webpackRequire: WebpackRequire,
  remoteEntryInitOptions?: RemoteEntryInitOptions,
): void {
  const { instance, initOptions } = webpackRequire.federation || {};
  const assetRequestContext = remoteEntryInitOptions?.assetRequestContext;
  if (!assetRequestContext || !instance || !initOptions) {
    return;
  }
  const userOptions: UserOptions = {
    name: initOptions.name,
    remotes: [],
    assetRequestContext,
  };
  instance.initOptions(userOptions);
}

function getAssetRequest(webpackRequire: WebpackRequire): AssetRequest | void {
  if (!isBrowser()) {
    return;
  }
  return webpackRequire.federation.instance?.options.assetRequestContext
    ?.request;
}

// Make relative url() and @import references absolute, since the stylesheet
// is applied from a blob url and would otherwise resolve them against it.
export function rewriteCssUrls(css: string, href: string): string {
  const resolve = (spec: string) =>
    /^([a-z][a-z\d+.-]*:|\/\/|#)/i.test(spec) ? spec : new URL(spec, href).href;
  return css
    .replace(
      /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
      (_m, quote: string, spec: string) =>
        `url(${quote}${resolve(spec.trim())}${quote})`,
    )
    .replace(
      /@import\s+(['"])([^'"]+)\1/g,
      (_m, quote: string, spec: string) =>
        `@import ${quote}${resolve(spec)}${quote}`,
    );
}

function isStylesheetLink(node: Node): node is HTMLLinkElement {
  return (
    node instanceof HTMLLinkElement &&
    node.rel === 'stylesheet' &&
    !!node.getAttribute('href')
  );
}

// Request a stylesheet <link> created by the CSS chunk runtime, then attach it
// with a blob url. The CSS runtime's own onload/onerror handlers settle the
// chunk. `data-href` keeps the original href so the runtime's lookup of
// already loaded stylesheets still finds the link.
function requestStylesheetLink(
  link: HTMLLinkElement,
  request: AssetRequest,
  attach: (link: HTMLLinkElement) => void,
): void {
  const href = link.getAttribute('href')!;
  const url = link.href;
  fetchText(url, { customFetch: request }).then(
    (css) => {
      if (!link.getAttribute('data-href')) {
        link.setAttribute('data-href', href);
      }
      link.href = createBlobUrl(rewriteCssUrls(css, url), 'text/css');
      attach(link);
    },
    () => {
      link.dispatchEvent(new Event('error'));
    },
  );
}

// The CSS chunk runtimes (mini-css-extract-plugin, rspack's
// CssExtractRspackPlugin and native css) create the <link> and append it to
// document.head synchronously inside their ensure-chunk handler. While that
// handler runs, hold back stylesheet links and request them first.
function runWithStylesheetRequests<T>(request: AssetRequest, run: () => T): T {
  const head = document.head;
  const hasOwnAppendChild = Object.prototype.hasOwnProperty.call(
    head,
    'appendChild',
  );
  const appendChild = head.appendChild;
  const attach = (link: HTMLLinkElement) => {
    appendChild.call(head, link);
  };
  head.appendChild = function <N extends Node>(this: HTMLHeadElement, node: N) {
    if (isStylesheetLink(node)) {
      requestStylesheetLink(node, request, attach);
      return node;
    }
    return appendChild.call(this, node) as N;
  };
  try {
    return run();
  } finally {
    if (hasOwnAppendChild) {
      head.appendChild = appendChild;
    } else {
      delete (head as Partial<HTMLHeadElement>).appendChild;
    }
  }
}

const CSS_CHUNK_HANDLERS = ['miniCss', 'css'];

// Route the container's chunk loading through `assetRequestContext.request`.
// Installed once, the first time the container accepts a context with a
// request, and reads the request on every call so a context accepted later
// takes effect. Without a request each wrapper calls the original handler
// unchanged.
export function installAssetRequestContextChunkLoading(
  webpackRequire: WebpackRequire,
): void {
  const { federation } = webpackRequire;
  if (federation.hasAssetRequestContextChunkLoading) {
    return;
  }
  federation.hasAssetRequestContextChunkLoading = true;

  // JSONP and other script chunks: fetch the chunk, then let webpack's own
  // script loader run it from a blob url so its timeout, nonce and `done`
  // handling stay the same.
  const loadScript = webpackRequire.l;
  if (typeof loadScript === 'function') {
    webpackRequire.l = (url, done, key, chunkId) => {
      const request = getAssetRequest(webpackRequire);
      if (!request) {
        return loadScript(url, done, key, chunkId);
      }
      // Report the original url to `done`, as webpack's own error messages
      // and ChunkLoadError.request use event.target.src.
      const reportDone = (type: string) =>
        done({ type, target: { src: url } } as WebpackLoadScriptEvent);
      fetchText(url, { customFetch: request }).then(
        (code) => {
          const blobUrl = createBlobUrl(code, 'application/javascript');
          loadScript(
            blobUrl,
            (event) => {
              URL.revokeObjectURL(blobUrl);
              reportDone(event?.type || 'load');
            },
            key,
            chunkId,
          );
        },
        () => reportDone('error'),
      );
    };
  }

  const ensureChunkHandlers = webpackRequire.f;
  if (!ensureChunkHandlers) {
    return;
  }
  CSS_CHUNK_HANDLERS.forEach((name) => {
    const handler = ensureChunkHandlers[name];
    if (typeof handler !== 'function') {
      return;
    }
    ensureChunkHandlers[name] = (chunkId, promises) => {
      const request = getAssetRequest(webpackRequire);
      if (!request) {
        return handler(chunkId, promises);
      }
      return runWithStylesheetRequests(request, () =>
        handler(chunkId, promises),
      );
    };
  });
}
