// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { IPhase } from '../../api/CommandLineConfiguration';
import { RushConfigurationProject } from '../../api/RushConfigurationProject';
import {
  ICreateOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import { HeftOperationRunner } from './HeftOperationRunner';
import { Operation } from './Operation';

const PLUGIN_NAME: 'HeftOperationRunnerPlugin' = 'HeftOperationRunnerPlugin';

export class HeftOperationRunnerPlugin implements IPhasedCommandPlugin {
  public apply(hooks: PhasedCommandHooks): void {
    const runnerCache: Map<string, HeftOperationRunner> = new Map();

    hooks.createOperations.tapPromise(
      {
        name: PLUGIN_NAME,
        stage: 10
      },
      async (operations: Set<Operation>, context: ICreateOperationsContext) => {
        for (const operation of operations) {
          const { associatedPhase: phase, associatedProject: project, runner } = operation;

          if (phase && project && runner?.constructor.name === 'ShellOperationRunner') {
            // Implementation detail.
            let commandToRun: string = runner.getConfigHash();

            if (!commandToRun.startsWith('heft ') && !commandToRun.includes('@rushstack/heft')) {
              // Not a heft project
              continue;
            }

            if (
              project.packageJson.dependencies?.['@rushstack/heft'] !== 'workspace:*' &&
              project.packageJson.devDependencies?.['@rushstack/heft'] !== 'workspace:*'
            ) {
              continue;
            }

            commandToRun = commandToRun.replace(/ run /, ' run-watch ');

            const operationName: string = getDisplayName(project, phase);
            let heftOperationRunner: HeftOperationRunner | undefined = runnerCache.get(operationName);
            if (!heftOperationRunner) {
              heftOperationRunner = new HeftOperationRunner({
                phase,
                project,
                name: operationName,
                shellCommand: commandToRun,
                warningsAreAllowed: runner.warningsAreAllowed
              });
              runnerCache.set(operationName, heftOperationRunner);
            }

            operation.runner = heftOperationRunner;
          }
        }

        return operations;
      }
    );
  }
}

function getDisplayName(project: RushConfigurationProject, phase: IPhase): string {
  if (phase.isSynthetic) {
    return `${project.packageName} - Heft IPC`;
  }

  return `${project.packageName} (${phase.name.replace(/^_phase:|\-(?:changed|incremental)$/g, '')}) - IPC`;
}
