// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { BuildCacheConfiguration } from '../api/BuildCacheConfiguration';
import { RushConfiguration } from '../api/RushConfiguration';
import { RushConfigurationProject } from '../api/RushConfigurationProject';
import { ProjectBuilder, convertSlashesForWindows } from '../logic/taskRunner/ProjectBuilder';
import { ProjectChangeAnalyzer } from './ProjectChangeAnalyzer';
import { Task } from './taskRunner/Task';
import { TaskCollection } from './taskRunner/TaskCollection';
import { TaskStatus } from './taskRunner/TaskStatus';

export interface ITaskSelectorOptions {
  rushConfiguration: RushConfiguration;
  buildCacheConfiguration: BuildCacheConfiguration | undefined;
  selection: ReadonlySet<RushConfigurationProject>;
  commandName: string;
  commandToRun: string;
  customParameterValues: string[];
  isQuietMode: boolean;
  isDebugMode: boolean;
  isIncrementalBuildAllowed: boolean;
  ignoreMissingScript: boolean;
  ignoreDependencyOrder: boolean;
  packageDepsFilename: string;
  projectChangeAnalyzer?: ProjectChangeAnalyzer;
  allowWarningsInSuccessfulBuild?: boolean;
}

/**
 * This class is responsible for:
 *  - based on to/from flags, solving the dependency graph and figuring out which projects need to be run
 *  - creating a ProjectBuilder for each project that needs to be built
 *  - registering the necessary ProjectBuilders with the TaskRunner, which actually orchestrates execution
 */
export class TaskSelector {
  private _options: ITaskSelectorOptions;
  private _projectChangeAnalyzer: ProjectChangeAnalyzer;

  public constructor(options: ITaskSelectorOptions) {
    this._options = options;

    const { projectChangeAnalyzer = new ProjectChangeAnalyzer(options.rushConfiguration) } = options;

    this._projectChangeAnalyzer = projectChangeAnalyzer;
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

  public registerTasks(): Set<Task> {
    const projects: ReadonlySet<RushConfigurationProject> = this._options.selection;

    const tasks: Map<RushConfigurationProject, Task> = new Map();

    // Register all tasks
    for (const project of projects) {
      const commandToRun: string | undefined = TaskSelector.getScriptToRun(
        project,
        this._options.commandToRun,
        this._options.customParameterValues
      );
      if (commandToRun === undefined && !this._options.ignoreMissingScript) {
        throw new Error(
          `The project [${project.packageName}] does not define a '${this._options.commandToRun}' command in the 'scripts' section of its package.json`
        );
      }

      const task: Task = new Task(
        new ProjectBuilder({
          rushProject: project,
          rushConfiguration: this._options.rushConfiguration,
          buildCacheConfiguration: this._options.buildCacheConfiguration,
          commandToRun: commandToRun || '',
          commandName: this._options.commandName,
          isIncrementalBuildAllowed: this._options.isIncrementalBuildAllowed,
          projectChangeAnalyzer: this._projectChangeAnalyzer,
          packageDepsFilename: this._options.packageDepsFilename,
          allowWarningsInSuccessfulBuild: this._options.allowWarningsInSuccessfulBuild
        }),
        TaskStatus.Ready
      );

      tasks.set(project, task);
    }

    if (!this._options.ignoreDependencyOrder) {
      const dependencyCache: Map<RushConfigurationProject, Set<RushConfigurationProject>> = new Map();

      // Generate the filtered dependency graph for selected projects
      function getFilteredDependencies(project: RushConfigurationProject): Set<RushConfigurationProject> {
        const cached: Set<RushConfigurationProject> | undefined = dependencyCache.get(project);
        if (cached) {
          return cached;
        }

        const filteredDependencies: Set<RushConfigurationProject> = new Set();
        dependencyCache.set(project, filteredDependencies);

        for (const dep of project.dependencyProjects) {
          if (projects.has(dep)) {
            // Add direct relationships for projects in the set
            filteredDependencies.add(dep);
          } else {
            // Add indirect relationships for projects not in the set
            for (const indirectDep of getFilteredDependencies(dep)) {
              filteredDependencies.add(indirectDep);
            }
          }
        }

        return filteredDependencies;
      }

      for (const [project, task] of tasks) {
        const filteredDependencies: Set<RushConfigurationProject> = getFilteredDependencies(project);

        for (const dependency of filteredDependencies) {
          const dependencyTask: Task | undefined = tasks.get(dependency);
          if (dependencyTask) {
            task.dependencies.add(dependencyTask);
          }
        }
      }
    }

    return new Set(tasks.values());
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
