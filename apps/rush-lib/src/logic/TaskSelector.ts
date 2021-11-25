// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { BuildCacheConfiguration } from '../api/BuildCacheConfiguration';
import { RushConfiguration } from '../api/RushConfiguration';
import { RushConfigurationProject } from '../api/RushConfigurationProject';
import { ProjectBuilder, convertSlashesForWindows } from '../logic/taskRunner/ProjectBuilder';
import { ProjectChangeAnalyzer } from './ProjectChangeAnalyzer';
import { Task } from './taskRunner/Task';
import { TaskStatus } from './taskRunner/TaskStatus';

export interface ITaskSelectorOptions {
  rushConfiguration: RushConfiguration;
  buildCacheConfiguration: BuildCacheConfiguration | undefined;
  commandName: string;
  commandToRun: string;
  customParameterValues: string[];
  isQuietMode: boolean;
  isDebugMode: boolean;
  isIncrementalBuildAllowed: boolean;
  ignoreMissingScript: boolean;
  ignoreDependencyOrder: boolean;
  packageDepsFilename: string;
  allowWarningsInSuccessfulBuild?: boolean;
}

export interface ICreateTasksOptions {
  selection: ReadonlySet<RushConfigurationProject>;
  projectChangeAnalyzer?: ProjectChangeAnalyzer;
}

/**
 * This class is responsible for:
 *  - based on to/from flags, solving the dependency graph and figuring out which projects need to be run
 *  - creating a ProjectBuilder for each project that needs to be built
 *  - registering the necessary ProjectBuilders with the TaskRunner, which actually orchestrates execution
 */
export class TaskSelector {
  private readonly _options: ITaskSelectorOptions;

  public constructor(options: ITaskSelectorOptions) {
    this._options = options;
  }

  public static getScriptToRun(
    rushProject: RushConfigurationProject,
    commandToRun: string,
    customParameterValues: string[]
  ): string | undefined {
    const script: string | undefined = TaskSelector._getScriptCommand(rushProject, commandToRun);

    if (script === undefined) {
      return undefined;
    }

    if (!script) {
      return '';
    } else {
      const taskCommand: string = `${script} ${customParameterValues.join(' ')}`;
      return process.platform === 'win32' ? convertSlashesForWindows(taskCommand) : taskCommand;
    }
  }

  /**
   * Creates tasks for the selected projects, using the specified ProjectChangeAnalyzer for change detection.
   */
  public createTasks(createTasksOptions: ICreateTasksOptions): Set<Task> {
    const { _options: options } = this;

    const {
      selection: projects,
      projectChangeAnalyzer = new ProjectChangeAnalyzer(options.rushConfiguration)
    } = createTasksOptions;

    const taskByProject: Map<RushConfigurationProject, Task> = new Map();

    // Register all tasks
    for (const project of projects) {
      const commandToRun: string | undefined = TaskSelector.getScriptToRun(
        project,
        options.commandToRun,
        options.customParameterValues
      );

      if (commandToRun === undefined && !options.ignoreMissingScript) {
        throw new Error(
          `The project [${project.packageName}] does not define a '${options.commandToRun}' command in the 'scripts' section of its package.json`
        );
      }

      const task: Task = new Task(
        new ProjectBuilder({
          // Common parameters
          rushConfiguration: options.rushConfiguration,
          buildCacheConfiguration: options.buildCacheConfiguration,
          commandName: options.commandName,
          isIncrementalBuildAllowed: options.isIncrementalBuildAllowed,
          projectChangeAnalyzer,
          packageDepsFilename: options.packageDepsFilename,
          allowWarningsInSuccessfulBuild: options.allowWarningsInSuccessfulBuild,
          // Project-specific parameters
          rushProject: project,
          commandToRun: commandToRun || ''
        }),
        TaskStatus.Ready
      );

      taskByProject.set(project, task);
    }

    if (!options.ignoreDependencyOrder) {
      const dependencyMap: Map<RushConfigurationProject, Set<RushConfigurationProject>> = new Map();

      // Generate the filtered dependency graph for selected projects
      function getSelectedDependencies(project: RushConfigurationProject): Set<RushConfigurationProject> {
        const cached: Set<RushConfigurationProject> | undefined = dependencyMap.get(project);
        if (cached) {
          return cached;
        }

        const filteredDependencies: Set<RushConfigurationProject> = new Set();
        dependencyMap.set(project, filteredDependencies);

        for (const dep of project.dependencyProjects) {
          if (projects.has(dep)) {
            // Add direct relationships for projects in the set
            filteredDependencies.add(dep);
          } else {
            // Add indirect relationships for projects not in the set
            for (const indirectDep of getSelectedDependencies(dep)) {
              filteredDependencies.add(indirectDep);
            }
          }
        }

        return filteredDependencies;
      }

      // Add ordering relationships for each dependency
      for (const [project, task] of taskByProject) {
        const filteredDependencies: Set<RushConfigurationProject> = getSelectedDependencies(project);
        for (const dependency of filteredDependencies) {
          const dependencyTask: Task | undefined = taskByProject.get(dependency);
          if (!dependencyTask) {
            // This should be unreachable code.
            throw new Error(
              `Missing task for project ${dependency.packageName}! This indicates a bug in Rush.`
            );
          }

          task.dependencies.add(dependencyTask);
          // Don't bother with the reverse mapping here. It'll get added by AsyncTaskQueue at execution time.
        }
      }
    }

    return new Set(taskByProject.values());
  }

  private static _getScriptCommand(
    rushProject: RushConfigurationProject,
    script: string
  ): string | undefined {
    if (!rushProject.packageJson.scripts) {
      return undefined;
    }

    const rawCommand: string = rushProject.packageJson.scripts[script];

    if (rawCommand === undefined || rawCommand === null) {
      return undefined;
    }

    return rawCommand;
  }
}
