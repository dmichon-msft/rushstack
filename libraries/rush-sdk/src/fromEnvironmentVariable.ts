// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type * as RushLibModuleType from '@microsoft/rush-lib';
import { type ITerminal } from '@rushstack/node-core-library';

import { provideRushLib, RUSH_LIB_NAME } from './fromRushPlugin';
import { requireExternal } from './requireIndirector';

export const RUSHSDK_RUSH_LIB_PATH_VAR: 'RUSHSDK_RUSH_LIB_PATH' = 'RUSHSDK_RUSH_LIB_PATH';

/**
 * For use in subprocesses of a Rush process, e.g. build processes inside of a Rush repository.
 *
 * Will return undefined if the RUSHSDK_RUSH_LIB_PATH environment variable is not defined
 * Separated out to minimize bundle footprint.
 */
export function tryLoadRushFromEnvironmentVariable(
  terminal: ITerminal
): typeof RushLibModuleType | undefined {
  const rushLibPath: string | undefined = process.env[RUSHSDK_RUSH_LIB_PATH_VAR];

  if (!rushLibPath) {
    terminal.writeDebugLine(`The ${RUSHSDK_RUSH_LIB_PATH_VAR} environment variable is not defined.`);
    return;
  }

  try {
    const result: typeof RushLibModuleType = requireExternal(rushLibPath);
    provideRushLib(result);
    return result;
  } catch (err) {
    terminal.writeDebugLine(`Error loading ${RUSH_LIB_NAME}: ${err}`);
  }
}
