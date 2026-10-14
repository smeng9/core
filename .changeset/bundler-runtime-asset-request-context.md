---
'@module-federation/webpack-bundler-runtime': patch
---

Support remotes whose assets need an authenticated request. A remote container that receives `assetRequestContext` in its `init` options runs its JS chunks (`__webpack_require__.l`) and its CSS chunks (mini-css-extract-plugin, `CssExtractRspackPlugin`, native CSS) from content fetched through `assetRequestContext.request`. A container keeps the context of the first `consumerId`; the same `consumerId` may replace it, and a context from a different `consumerId` is ignored with a warning. Without `assetRequestContext` nothing changes.

On the host, a user-written runtime plugin sets the context in `beforeInitContainer`, and its `loadEntry` hook can use the new `loadEntryWithRequest` (`module`/`esm` entries) and `loadScriptEntryWithRequest` (script entries) exports to load the remote entry through the same `request`. Both reject with RUNTIME-008 on failure, so `loadEntryError` recovery still runs.
