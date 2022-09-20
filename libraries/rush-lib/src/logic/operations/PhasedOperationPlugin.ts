// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Async, ITerminal } from '@rushstack/node-core-library';

import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import type { IPhase } from '../../api/CommandLineConfiguration';

import { Operation } from './Operation';
import { OperationStatus } from './OperationStatus';
import { NullOperationRunner } from './NullOperationRunner';
import type {
  ICreateOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import { IOperationSettings, RushProjectConfiguration } from '../../api/RushProjectConfiguration';

const PLUGIN_NAME: 'PhasedOperationPlugin' = 'PhasedOperationPlugin';

/**
 * Core phased command plugin that provides the functionality for generating a base operation graph
 * from the set of selected projects and phases.
 */
export class PhasedOperationPlugin implements IPhasedCommandPlugin {
  private readonly _terminal: ITerminal;

  public constructor(terminal: ITerminal) {
    this._terminal = terminal;
  }

  public apply(hooks: PhasedCommandHooks): void {
    hooks.createOperations.tapPromise(
      PLUGIN_NAME,
      async (operations: Set<Operation>, context: ICreateOperationsContext) => {
        return createOperationsAsync(operations, context, this._terminal);
      }
    );
  }
}

async function createOperationsAsync(
  existingOperations: Set<Operation>,
  context: ICreateOperationsContext,
  terminal: ITerminal
): Promise<Set<Operation>> {
  const { projectsInUnknownState: changedProjects, phaseSelection, projectSelection } = context;
  const operationsWithWork: Set<Operation> = new Set();

  const operations: Map<string, Operation> = new Map();

  const rushProjectConfigurations: Map<RushConfigurationProject, RushProjectConfiguration | false> =
    new Map();

  terminal.writeVerboseLine(`Loading and validating rush-project.json files...`);
  Async.forEachAsync(
    projectSelection,
    async (project: RushConfigurationProject) => {
      const config: RushProjectConfiguration | undefined =
        await RushProjectConfiguration.tryLoadForProjectAsync(project, terminal);
      if (config) {
        config.validatePhaseConfiguration(phaseSelection, terminal);
      }
      rushProjectConfigurations.set(project, config || false);
    },
    {
      concurrency: 10
    }
  );
  terminal.writeVerboseLine(`Done.`);

  // Create tasks for selected phases and projects
  for (const phase of phaseSelection) {
    for (const project of projectSelection) {
      getOrCreateOperation(phase, project);
    }
  }

  // Recursively expand all consumers in the `operationsWithWork` set.
  for (const operation of operationsWithWork) {
    for (const consumer of operation.consumers) {
      operationsWithWork.add(consumer);
    }
  }

  for (const [key, operation] of operations) {
    if (!operationsWithWork.has(operation)) {
      // This operation is in scope, but did not change since it was last executed by the current command.
      // However, we have no state tracking across executions, so treat as unknown.
      operation.runner = new NullOperationRunner({
        name: key,
        result: OperationStatus.Skipped,
        silent: true
      });
    }
  }

  return existingOperations;

  // Binds phaseSelection, projectSelection, operations via closure
  function getOrCreateOperation(phase: IPhase, project: RushConfigurationProject): Operation {
    const key: string = getOperationKey(phase, project);
    let operation: Operation | undefined = operations.get(key);
    if (!operation) {
      const projectConfiguration: RushProjectConfiguration | false | undefined =
        rushProjectConfigurations.get(project);

      operation = new Operation({
        project,
        phase
      });

      if (projectConfiguration) {
        const operationSettings: Readonly<IOperationSettings> | undefined =
          projectConfiguration.operationSettingsByOperationName.get(phase.name);
        operation.outputFolderNames = operationSettings?.outputFolderNames;
        operation.disableCache =
          operationSettings?.disableBuildCacheForOperation ||
          projectConfiguration.disableBuildCacheForProject;
      }

      if (!phaseSelection.has(phase) || !projectSelection.has(project)) {
        // Not in scope. Mark skipped because state is unknown.
        operation.runner = new NullOperationRunner({
          name: key,
          result: OperationStatus.Skipped,
          silent: true
        });
      } else if (changedProjects.has(project)) {
        operationsWithWork.add(operation);
      }

      operations.set(key, operation);
      existingOperations.add(operation);

      const {
        dependencies: { self, upstream }
      } = phase;

      for (const depPhase of self) {
        operation.addDependency(getOrCreateOperation(depPhase, project));
      }

      if (upstream.size) {
        const { dependencyProjects } = project;
        if (dependencyProjects.size) {
          for (const depPhase of upstream) {
            for (const dependencyProject of dependencyProjects) {
              operation.addDependency(getOrCreateOperation(depPhase, dependencyProject));
            }
          }
        }
      }
    }

    return operation;
  }
}

// Convert the [IPhase, RushConfigurationProject] into a value suitable for use as a Map key
function getOperationKey(phase: IPhase, project: RushConfigurationProject): string {
  return `${project.packageName};${phase.name}`;
}
