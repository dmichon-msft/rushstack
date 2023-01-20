// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { SpawnSyncReturns } from 'child_process';
import * as path from 'path';

import type * as RushLibModuleType from '@microsoft/rush-lib';
import {
  type ITerminal,
  JsonFile,
  type JsonObject,
  FileSystem,
  Executable
} from '@rushstack/node-core-library';

import { requireExternal } from './requireIndirector';
import { provideRushLib, RUSH_LIB_NAME } from './fromRushPlugin';

/**
 * For use only in Rush plugins (or other code that is directly loaded into a running Rush process).
 * Provides access to the currently running instance of `@microsoft/rush-lib`.
 *
 * Will throw an error if no instance of Rush is loaded in the current process.
 * Separated out to minimize bundle footprint.
 */
export function tryLoadRushFromInstallRunRush(terminal: ITerminal): typeof RushLibModuleType | undefined {
  const rushJsonPath: string | undefined = tryFindRushJsonLocation(process.cwd());
  if (!rushJsonPath) {
    terminal.writeDebugLine(
      'Unable to find rush.json in the current folder or its parent folders.\n' +
        'This tool is meant to be invoked from a working directory inside a Rush repository.'
    );
    return;
  }
  const monorepoRoot: string = path.dirname(rushJsonPath);

  const rushJson: JsonObject = JsonFile.load(rushJsonPath);
  const { rushVersion } = rushJson;

  const installRunNodeModuleFolder: string = path.join(
    monorepoRoot,
    `common/temp/install-run/@microsoft+rush@${rushVersion}`
  );

  let result: typeof RushLibModuleType | undefined;

  try {
    const rushLibPath: string = require.resolve(RUSH_LIB_NAME, { paths: [installRunNodeModuleFolder] });
    result = requireExternal(rushLibPath);
  } catch (err) {
    terminal.writeDebugLine(`${RUSH_LIB_NAME} has not yet been installed by install-run-rush`);
  }

  const installAndRunRushJSPath: string = path.join(monorepoRoot, 'common/scripts/install-run-rush.js');
  terminal.writeLine('The Rush engine has not been installed yet. Invoking install-run-rush.js...');

  const installAndRunRushProcess: SpawnSyncReturns<string> = Executable.spawnSync(
    'node',
    [installAndRunRushJSPath, '--help'],
    {
      stdio: 'pipe'
    }
  );

  if (installAndRunRushProcess.status !== 0) {
    terminal.writeDebugLine(`The ${RUSH_LIB_NAME} package failed to install.`);
    return;
  }

  try {
    const rushLibPath: string = require.resolve(RUSH_LIB_NAME, { paths: [installRunNodeModuleFolder] });
    result = requireExternal(rushLibPath);
  } catch (err) {
    terminal.writeDebugLine(installAndRunRushProcess.stderr.toString());
    terminal.writeDebugLine(`The ${RUSH_LIB_NAME} package failed to load.`);
    return;
  }

  if (result) {
    provideRushLib(result);
  }

  return result;
}

/**
 * Find the rush.json location and return the path, or undefined if a rush.json can't be found.
 *
 * @privateRemarks
 * Keep this in sync with `RushConfiguration.tryFindRushJsonLocation`.
 */
function tryFindRushJsonLocation(startingFolder: string): string | undefined {
  let currentFolder: string = startingFolder;

  // Look upwards at parent folders until we find a folder containing rush.json
  for (let i: number = 0; i < 10; ++i) {
    const rushJsonFilename: string = path.join(currentFolder, 'rush.json');

    if (FileSystem.exists(rushJsonFilename)) {
      return rushJsonFilename;
    }

    const parentFolder: string = path.dirname(currentFolder);
    if (parentFolder === currentFolder) {
      break;
    }

    currentFolder = parentFolder;
  }

  return undefined;
}
