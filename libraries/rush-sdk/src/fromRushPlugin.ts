// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type * as RushLibModuleType from '@microsoft/rush-lib';
import { type ITerminal } from '@rushstack/node-core-library';

declare const global: NodeJS.Global &
  typeof globalThis & {
    ___rush___rushLibModule?: typeof RushLibModuleType;
    ___rush___rushLibModuleFromInstallAndRunRush?: typeof RushLibModuleType;
  };

export const RUSH_LIB_NAME: '@microsoft/rush-lib' = '@microsoft/rush-lib';

/**
 * For use only in Rush plugins (or other code that is directly loaded into a running Rush process).
 * Provides access to the currently running instance of `@microsoft/rush-lib`.
 *
 * Will return undefined if no instance of Rush is loaded in the current process.
 * Separated out to minimize bundle footprint.
 */
export function tryLoadFromRushPlugin(terminal: ITerminal): typeof RushLibModuleType | undefined {
  const result: typeof RushLibModuleType | undefined =
    global.___rush___rushLibModule ?? global.___rush___rushLibModuleFromInstallAndRunRush;

  if (!result) {
    terminal.writeDebugLine(`Rush is not currently loaded in the current process.`);
  }

  return result;
}

/**
 * Provides rush-lib to subsequent calls
 */
export function provideRushLib(rushLib: typeof RushLibModuleType): void {
  global.___rush___rushLibModule = rushLib;
}
