## @rushstack/heft-node-rig

A rig package for Node.js projects that build using [Heft](https://www.npmjs.com/package/@rushstack/heft) and [esbuild](https://github.com/evanw/esbuild)
build system.  To learn more about rig packages, consult the
[@rushstack/rig-package](https://www.npmjs.com/package/@rushstack/rig-package) documentation.

This rig contains a single profile: `default`

To enable it, add a **rig.json** file to your project, as shown below:

**config/rig.json**
```js
{
  "$schema": "https://developer.microsoft.com/json-schemas/rig-package/rig.schema.json",

  "rigPackageName": "@rushstack/heft-esbuild-node-rig"
}
```

The config files provided by this rig profile can be found in the [heft-esbuild-node-rig/profiles/default](
https://github.com/microsoft/rushstack/tree/master/rigs/heft-esbuild-node-rig/profiles/default) source folder.


## Links

- [CHANGELOG.md](
  https://github.com/microsoft/rushstack/blob/master/rigs/heft-esbuild-node-rig/CHANGELOG.md) - Find
  out what's new in the latest version

`@rushstack/heft-esbuild-node-rig` is part of the [Rush Stack](https://rushstack.io/) family of projects.
