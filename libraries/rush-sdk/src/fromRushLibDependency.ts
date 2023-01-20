// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type * as RushLibModuleType from '@microsoft/rush-lib';
import { type IPackageJson, type ITerminal, PackageJsonLookup } from '@rushstack/node-core-library';
import { requireExternal } from './requireIndirector';
import { RUSH_LIB_NAME, provideRushLib } from './fromRushPlugin';

/**
 * For use only in projects that also define a dependency on `@microsoft/rush-lib`, during
 * their local builds.
 *
 * Will return undefined if the calling package does not declare a direct dependency on `@microsoft/rush-lib`.
 */
export function tryLoadRushFromRushLibDependency(terminal: ITerminal): typeof RushLibModuleType | undefined {
  let parent: NodeModule | null | undefined = module?.parent;
  while (parent && parent.path === __dirname) {
    parent = parent.parent;
  }

  const importingPath: string | null | undefined = parent?.filename;

  if (!importingPath) {
    terminal.writeDebugLine(`Unable to locate a parent non-rush-sdk module.`);
    return;
  }

  const callerPackageFolder: string | undefined =
    PackageJsonLookup.instance.tryGetPackageFolderFor(importingPath);
  if (callerPackageFolder === undefined) {
    terminal.writeDebugLine(`Parent module does not have a package.json.`);
    return;
  }

  const callerPackageJson: IPackageJson = requireExternal(`${callerPackageFolder}/package.json`);
  if (
    callerPackageJson.dependencies?.[RUSH_LIB_NAME] === undefined &&
    callerPackageJson.devDependencies?.[RUSH_LIB_NAME] === undefined &&
    callerPackageJson.peerDependencies?.[RUSH_LIB_NAME] === undefined
  ) {
    // Try to resolve rush-lib from the caller's folder
    terminal.writeDebugLine(`Caller package does not declare a dependency on ${RUSH_LIB_NAME}`);
    return;
  }

  try {
    const rushLibPath: string = require.resolve(RUSH_LIB_NAME, {
      paths: [callerPackageFolder]
    });

    const result: typeof RushLibModuleType = requireExternal(rushLibPath);
    provideRushLib(result);
    return result;
  } catch (err) {
    terminal.writeDebugLine(`Error loading ${RUSH_LIB_NAME}: ${err}`);
  }
}
