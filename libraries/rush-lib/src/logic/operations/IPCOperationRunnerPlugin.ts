// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { IPhase } from '../../api/CommandLineConfiguration';
import { RushConfigurationProject } from '../../api/RushConfigurationProject';
import {
  ICreateOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import { IPCOperationRunner } from './IPCOperationRunner';
import { Operation } from './Operation';
import { RushProjectConfiguration } from '../../api/RushProjectConfiguration';

const PLUGIN_NAME: 'IPCOperationRunnerPlugin' = 'IPCOperationRunnerPlugin';

/**
 * Plugin that implements compatible phases via IPC to a long-lived watch process.
 */
export class IPCOperationRunnerPlugin implements IPhasedCommandPlugin {
  public apply(hooks: PhasedCommandHooks): void {
    const runnerCache: Map<string, IPCOperationRunner> = new Map();

    hooks.createOperations.tapPromise(
      PLUGIN_NAME,
      async (operations: Set<Operation>, context: ICreateOperationsContext) => {
        const { projectConfigurations, isWatch } = context;

        for (const operation of operations) {
          const { associatedPhase: phase, associatedProject: project, runner } = operation;

          if (phase && project && runner?.constructor.name === 'ShellOperationRunner') {
            const config: RushProjectConfiguration | undefined = projectConfigurations.get(project);
            if (config?.operationSettingsByOperationName.get(phase.name)) {
              // Read a config property to determine whether or not to opt in to IPC.
              // Technically the IPC runner should be a superset of the regular ShellOperationRunner,
              // but there is a change to default cacheability.
            }

            // Implementation detail.
            const commandToRun: string = runner.getConfigHash();

            const operationName: string = getDisplayName(project, phase);
            let ipcOperationRunner: IPCOperationRunner | undefined = runnerCache.get(operationName);
            if (!ipcOperationRunner) {
              ipcOperationRunner = new IPCOperationRunner({
                phase,
                project,
                name: operationName,
                shellCommand: commandToRun,
                warningsAreAllowed: runner.warningsAreAllowed,
                persist: isWatch
              });
              runnerCache.set(operationName, ipcOperationRunner);
            }

            operation.runner = ipcOperationRunner;
          }
        }

        return operations;
      }
    );
  }
}

function getDisplayName(project: RushConfigurationProject, phase: IPhase): string {
  if (phase.isSynthetic) {
    return `${project.packageName} - IPC`;
  }

  return `${project.packageName} (${phase.name.replace(/^_phase:/g, '')}) - IPC`;
}
