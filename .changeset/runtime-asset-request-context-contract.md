---
'@module-federation/runtime-core': patch
'@module-federation/runtime': patch
---

Add a typed `assetRequestContext` field (`consumerId` and a `request` function) to `RemoteEntryInitOptions` and `Options`, and export the `AssetRequestContext` type. A host runtime plugin sets it on `remoteEntryInitOptions` in `beforeInitContainer`; the runtime passes it to the remote container's `init` unchanged. The container's bundler runtime passes it on to the container's federation instance through `initOptions`, where a runtime plugin reads it as `userOptions.assetRequestContext` in `beforeInit` and decides how to request the container's assets with it, for example to attach an `Authorization` header. The runtime itself does not change how anything is loaded.
