// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Terminal, ConsoleTerminalProvider } from '@rushstack/node-core-library';

import { tryLoadFromRushPlugin } from './fromRushPlugin';
import { tryLoadRushFromEnvironmentVariable } from './fromEnvironmentVariable';
import { tryLoadRushFromRushLibDependency } from './fromRushLibDependency';
import { tryLoadRushFromInstallRunRush } from './fromInstallRunRush';

const verboseEnabled: boolean = typeof process !== 'undefined' && process.env.RUSH_SDK_DEBUG === '1';
const terminal: Terminal = new Terminal(
  new ConsoleTerminalProvider({
    verboseEnabled
  })
);

type RushLibModuleType = Record<string, unknown>;
// SCENARIO 1:  Rush's PluginManager has initialized "rush-sdk" with Rush's own instance of rush-lib.
// The Rush host process will assign "global.___rush___rushLibModule" before loading the plugin.
let rushLibModule: RushLibModuleType | undefined = tryLoadFromRushPlugin(terminal);

// SCENARIO 2:  The project importing "rush-sdk" has installed its own instance of "rush-lib"
// as a package.json dependency.  For example, this is used by the Jest tests for Rush plugins.
if (!rushLibModule) {
  rushLibModule = tryLoadRushFromRushLibDependency(terminal);
}

// SCENARIO 3:  The project importing "rush-sdk" is being loaded in as a child of an executing Rush
// process, e.g. it is a build tool being invoked during `rush build`
if (!rushLibModule) {
  rushLibModule = tryLoadRushFromEnvironmentVariable(terminal);
}

// SCENARIO 3:  A tool or script depends on "rush-sdk", and is meant to be used inside a monorepo folder.
// In this case, we can use install-run-rush.js to obtain the appropriate rush-lib version for the monorepo.
if (!rushLibModule) {
  rushLibModule = tryLoadRushFromInstallRunRush(terminal);
}

if (!rushLibModule) {
  // This error indicates that a project is trying to import "@rushstack/rush-sdk", but the Rush engine
  // instance cannot be found.  If you are writing Jest tests for a Rush plugin, add "@microsoft/rush-lib"
  // to the devDependencies for your project.
  terminal.writeErrorLine(`Error: The @rushstack/rush-sdk package was not able to load the Rush engine.`);
  process.exit(1);
}

// Based on TypeScript's __exportStar()
for (const property in rushLibModule) {
  if (property !== 'default' && !exports.hasOwnProperty(property)) {
    const rushLibModuleForClosure: RushLibModuleType = rushLibModule;

    // Based on TypeScript's __createBinding()
    Object.defineProperty(exports, property, {
      enumerable: true,
      get: function () {
        return rushLibModuleForClosure[property];
      }
    });
  }
}
