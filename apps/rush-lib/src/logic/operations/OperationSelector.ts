// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import type { IPhase } from '../../api/CommandLineConfiguration';
import type { Operation } from './Operation';

export interface IOperationSelectorOptions {
  phasesToRun: ReadonlySet<IPhase>;
}

export interface ICreateOperationsOptions {
  projectSelection: ReadonlySet<RushConfigurationProject>;
  operationFactory: IOperationFactory;
}

export interface IOperationOptions {
  project: RushConfigurationProject;
  phase: IPhase;
}

export interface IOperationFactory {
  createOperation(options: IOperationOptions): Operation;
}

interface IOperationDependencies {
  operations: Set<Operation> | undefined;
  isCacheWriteAllowed: boolean;
}

interface IOperationNode {
  key: string;
  phase: IPhase;
  project: RushConfigurationProject;
}

interface ISelectedOperationNode extends IOperationNode {
  operation: Operation;
}

/**
 * This class is responsible for transforming a set of selected phases and selected projects into an Operation dependency graph.
 */
export class OperationSelector {
  private readonly _phasesToRun: ReadonlySet<IPhase>;

  public constructor(options: IOperationSelectorOptions) {
    this._phasesToRun = options.phasesToRun;
  }

  public createTasks(createTasksOptions: ICreateOperationsOptions): Set<Operation> {
    const { projectSelection, operationFactory: operationFactory } = createTasksOptions;

    const selectedNodes: Map<string, ISelectedOperationNode> = new Map();
    const selectedTasks: Set<Operation> = new Set();

    // Create tasks for selected phases and projects
    for (const phase of this._phasesToRun) {
      for (const project of projectSelection) {
        const operation: Operation = operationFactory.createOperation({
          phase,
          project
        });

        const key: string = getTaskKey(phase, project);

        const record: ISelectedOperationNode = {
          key,
          phase,
          project,
          operation: operation
        };

        selectedNodes.set(key, record);
        selectedTasks.add(operation);
      }
    }

    // Convert the [IPhase, RushConfigurationProject] into a value suitable for use as a Map key
    function getTaskKey(phase: IPhase, project: RushConfigurationProject): string {
      return `${project.packageName};${phase.name}`;
    }

    /**
     * Enumerates the declared dependencies
     */
    function* getRawDependencies(node: IOperationNode): Iterable<IOperationNode> {
      const {
        phase: {
          phaseDependencies: { self, upstream }
        },
        project
      } = node;

      for (const depPhase of self) {
        // Different phase, same project
        yield {
          key: getTaskKey(depPhase, project),
          phase: depPhase,
          project
        };
      }

      if (upstream.size) {
        const { dependencyProjects } = project;
        if (dependencyProjects.size) {
          for (const depPhase of upstream) {
            for (const dependencyProject of dependencyProjects) {
              yield {
                key: getTaskKey(depPhase, dependencyProject),
                phase: depPhase,
                project: dependencyProject
              };
            }
          }
        }
      }
    }

    const filteredDependencyCache: Map<string, IOperationDependencies> = new Map();
    function getFilteredDependencies(node: IOperationNode): IOperationDependencies {
      const { key } = node;
      const cached: IOperationDependencies | undefined = filteredDependencyCache.get(key);
      if (cached) {
        return cached;
      }

      const dependencies: IOperationDependencies = {
        operations: undefined,
        isCacheWriteAllowed: selectedNodes.has(key)
      };

      filteredDependencyCache.set(key, dependencies);

      for (const dep of getRawDependencies(node)) {
        const selectedRecord: ISelectedOperationNode | undefined = selectedNodes.get(dep.key);
        if (selectedRecord) {
          // This Operation is part of the current execution
          if (!dependencies.operations) {
            dependencies.operations = new Set();
          }
          dependencies.operations.add(selectedRecord.operation);
        } else {
          // This Operation is not part of the current execution, but may have dependencies that are.
          // Since a Operation has been excluded, we cannot guarantee the results, so it is cache unsafe.
          dependencies.isCacheWriteAllowed = false;
          const { operations: indirectDependencies }: IOperationDependencies = getFilteredDependencies(dep);
          if (indirectDependencies) {
            if (!dependencies.operations) {
              dependencies.operations = new Set();
            }

            for (const indirectDep of indirectDependencies) {
              dependencies.operations.add(indirectDep);
            }
          }
        }
      }

      return dependencies;
    }

    // Add dependency relationships
    for (const record of selectedNodes.values()) {
      const deps: IOperationDependencies = getFilteredDependencies(record);
      if (deps.operations) {
        for (const dependency of deps.operations) {
          record.operation.dependencies.add(dependency);
          dependency.dependents.add(record.operation);
        }
      }

      record.operation.runner.isCacheWriteAllowed = deps.isCacheWriteAllowed;
    }

    return selectedTasks;
  }
}
