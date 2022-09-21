// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { RushConfiguration } from '../../api/RushConfiguration';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { IEvaluateSelectorOptions, ISelectorParser } from './ISelectorParser';
import {
  IGetChangedProjectsOptions,
  IProjectFileFilterMap,
  ProjectChangeAnalyzer
} from '../ProjectChangeAnalyzer';
import { Async, ITerminal } from '@rushstack/node-core-library';
import { RushProjectConfiguration } from '../../api/RushProjectConfiguration';
import ignore, { Ignore } from 'ignore';

export interface IGitSelectorParserOptions {
  /**
   * If set to `true`, consider a project's external dependency installation layout as defined in the
   * package manager lockfile when determining if it has changed.
   */
  includeExternalDependencies: boolean;

  /**
   * If set to `true` apply the `incrementalBuildIgnoredGlobs` property in a project's `rush-project.json`
   * and exclude matched files from change detection.
   */
  enableFiltering: boolean;
}

export class GitChangedProjectSelectorParser implements ISelectorParser<RushConfigurationProject> {
  private readonly _rushConfiguration: RushConfiguration;
  private readonly _options: IGitSelectorParserOptions;

  public constructor(rushConfiguration: RushConfiguration, options: IGitSelectorParserOptions) {
    this._rushConfiguration = rushConfiguration;
    this._options = options;
  }

  public async evaluateSelectorAsync({
    unscopedSelector,
    terminal
  }: IEvaluateSelectorOptions): Promise<Iterable<RushConfigurationProject>> {
    const projectChangeAnalyzer: ProjectChangeAnalyzer = new ProjectChangeAnalyzer(this._rushConfiguration);

    const { includeExternalDependencies, enableFiltering } = this._options;

    let filters: Map<RushConfigurationProject, (relativePath: string) => boolean> | undefined;
    if (enableFiltering) {
      filters = await this._getFiltersAsync(terminal);
    }

    const options: IGetChangedProjectsOptions = {
      terminal,
      targetBranchName: unscopedSelector,
      includeExternalDependencies,
      filters
    };

    return await projectChangeAnalyzer.getChangedProjectsAsync(options);
  }

  public getCompletions(): Iterable<string> {
    return [this._rushConfiguration.repositoryDefaultBranch, 'HEAD~1', 'HEAD'];
  }

  private async _getFiltersAsync(terminal: ITerminal): Promise<IProjectFileFilterMap> {
    const filters: IProjectFileFilterMap = new Map();
    await Async.forEachAsync(
      this._rushConfiguration.projects,
      async (project: RushConfigurationProject) => {
        const ignoreGlobs: ReadonlyArray<string> | undefined =
          await RushProjectConfiguration.tryLoadIgnoreGlobsForProjectAsync(project, terminal);
        if (ignoreGlobs && ignoreGlobs.length > 0) {
          const ignoreMatcher: Ignore = ignore();
          for (const glob of ignoreGlobs) {
            ignoreMatcher.add(glob);
          }
          filters.set(project, ignoreMatcher.createFilter());
        }
      },
      {
        concurrency: 10
      }
    );
    return filters;
  }
}
