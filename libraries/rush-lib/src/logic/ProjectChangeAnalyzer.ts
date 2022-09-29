// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import * as crypto from 'crypto';

import {
  getRepoChanges,
  getRepoRoot,
  getRepoState,
  getGitHashForFiles,
  IFileDiffStatus
} from '@rushstack/package-deps-hash';
import { Path, InternalError, FileSystem, ITerminal } from '@rushstack/node-core-library';

import { RushConfiguration } from '../api/RushConfiguration';
import { Git } from './Git';
import { BaseProjectShrinkwrapFile } from './base/BaseProjectShrinkwrapFile';
import { RushConfigurationProject } from '../api/RushConfigurationProject';
import { RushConstants } from './RushConstants';
import { IPrefixMatch, LookupByPath } from './LookupByPath';
import { PnpmShrinkwrapFile } from './pnpm/PnpmShrinkwrapFile';

/**
 * @beta
 */
export type IProjectFileFilter = (relativePath: string) => boolean;
/**
 * @beta
 */
export type IProjectFileFilterMap = Map<RushConfigurationProject, IProjectFileFilter>;

/**
 * @beta
 */
export interface IGetChangedProjectsOptions {
  targetBranchName: string;
  terminal: ITerminal;
  shouldFetch?: boolean;

  /**
   * If set to `true`, consider a project's external dependency installation layout as defined in the
   * package manager lockfile when determining if it has changed.
   */
  includeExternalDependencies: boolean;

  /**
   * If specified, the filter will be applied to project inputs during comparison
   */
  filters?: IProjectFileFilterMap;
}

interface IGitState {
  gitPath: string;
  hashes: Map<string, string>;
  rootDir: string;
}

interface IRawRepoState {
  projectState: Map<RushConfigurationProject, Map<string, string>> | undefined;
  rootDir: string;
}

type IFilterCacheMap = Map<RushConfigurationProject, ReadonlyMap<string, string>>;

/**
 * @beta
 */
export class ProjectChangeAnalyzer {
  private _data: IRawRepoState | undefined;
  private readonly _rushConfiguration: RushConfiguration;
  private readonly _cacheByFilter: WeakMap<IProjectFileFilter, IFilterCacheMap> = new WeakMap();
  private readonly _git: Git;

  public constructor(rushConfiguration: RushConfiguration) {
    this._rushConfiguration = rushConfiguration;
    this._git = new Git(this._rushConfiguration);
    this._data = undefined;
  }

  /**
   * @internal
   */
  public _ensureInitialized(terminal: ITerminal): IRawRepoState {
    if (!this._data) {
      this._data = this._getData(terminal);
    }

    return this._data;
  }

  /**
   * Try to get a list of the specified project's dependencies and their hashes.
   *
   * @remarks
   * If the data can't be generated (i.e. - if Git is not present) this returns undefined.
   *
   * @internal
   */
  public _tryGetProjectDependenciesAsync(
    project: RushConfigurationProject,
    terminal: ITerminal,
    fileFilter?: IProjectFileFilter
  ): ReadonlyMap<string, string> | undefined {
    const { projectState, rootDir } = this._ensureInitialized(terminal);

    if (projectState === undefined) {
      return undefined;
    }

    const unfilteredProjectData: Map<string, string> | undefined = projectState.get(project);
    if (!unfilteredProjectData) {
      throw new Error(`Project "${project.packageName}" does not exist in the current Rush configuration.`);
    }

    if (!fileFilter) {
      return unfilteredProjectData;
    }

    let cacheForFilter: IFilterCacheMap | undefined = this._cacheByFilter.get(fileFilter);
    if (!cacheForFilter) {
      cacheForFilter = new Map();
      this._cacheByFilter.set(fileFilter, cacheForFilter);
    }

    let cacheEntry: ReadonlyMap<string, string> | undefined = cacheForFilter.get(project);
    if (!cacheEntry) {
      cacheEntry = this._filterProjectData(project, unfilteredProjectData, rootDir, fileFilter);
      cacheForFilter.set(project, cacheEntry);
    }

    return cacheEntry;
  }

  /**
   * The project state hash is calculated in the following way:
   * - Project dependencies are collected (see ProjectChangeAnalyzer.getPackageDeps)
   *   - If project dependencies cannot be collected (i.e. - if Git isn't available),
   *     this function returns `undefined`
   * - The (path separator normalized) repo-root-relative dependencies' file paths are sorted
   * - A SHA1 hash is created and each (sorted) file path is fed into the hash and then its
   *   Git SHA is fed into the hash
   * - A hex digest of the hash is returned
   *
   * @internal
   */
  public _tryGetProjectStateHashAsync(
    project: RushConfigurationProject,
    terminal: ITerminal,
    fileFilter?: IProjectFileFilter
  ): string | undefined {
    const packageDeps: ReadonlyMap<string, string> | undefined = this._tryGetProjectDependenciesAsync(
      project,
      terminal,
      fileFilter
    );

    if (packageDeps) {
      const sortedPackageDepsFiles: string[] = Array.from(packageDeps.keys()).sort();
      const hash: crypto.Hash = crypto.createHash('sha1');
      for (const packageDepsFile of sortedPackageDepsFiles) {
        hash.update(packageDepsFile);
        hash.update(RushConstants.hashDelimiter);
        hash.update(packageDeps.get(packageDepsFile)!);
        hash.update(RushConstants.hashDelimiter);
      }

      return hash.digest('hex');
    }
  }

  public _filterProjectData<T>(
    project: RushConfigurationProject,
    unfilteredProjectData: Map<string, T>,
    rootDir: string,
    fileFilter?: IProjectFileFilter
  ): Map<string, T> {
    if (!fileFilter) {
      return unfilteredProjectData;
    }

    const projectKey: string = path.relative(rootDir, project.projectFolder);
    const projectKeyLength: number = projectKey.length + 1;

    // At this point, `filePath` is guaranteed to start with `projectKey`, so
    // we can safely slice off the first N characters to get the file path relative to the
    // root of the project.
    const filteredProjectData: Map<string, T> = new Map<string, T>();
    for (const [filePath, value] of unfilteredProjectData) {
      const relativePath: string = filePath.slice(projectKeyLength);
      if (fileFilter(relativePath)) {
        // Add the file path to the filtered data if it is not ignored
        filteredProjectData.set(filePath, value);
      }
    }
    return filteredProjectData;
  }

  /**
   * Gets a list of projects that have changed in the current state of the repo
   * when compared to the specified branch, optionally taking the shrinkwrap and settings in
   * the rush-project.json file into consideration.
   */
  public async getChangedProjectsAsync(
    options: IGetChangedProjectsOptions
  ): Promise<Set<RushConfigurationProject>> {
    return this.getChangedProjects(options);
  }

  /**
   * Gets a list of projects that have changed in the current state of the repo
   * when compared to the specified branch, optionally taking the shrinkwrap and settings in
   * the rush-project.json file into consideration.
   */
  public getChangedProjects(options: IGetChangedProjectsOptions): Set<RushConfigurationProject> {
    const { _rushConfiguration: rushConfiguration } = this;

    const { targetBranchName, terminal, includeExternalDependencies, filters, shouldFetch } = options;

    const gitPath: string = this._git.getGitPathOrThrow();
    const repoRoot: string = getRepoRoot(rushConfiguration.rushJsonFolder);

    const mergeCommit: string = this._git.getMergeBase(targetBranchName, terminal, shouldFetch);

    const repoChanges: Map<string, IFileDiffStatus> = getRepoChanges(repoRoot, mergeCommit, gitPath);

    const changedProjects: Set<RushConfigurationProject> = new Set();

    if (includeExternalDependencies) {
      // Even though changing the installed version of a nested dependency merits a change file,
      // ignore lockfile changes for `rush change` for the moment

      // Determine the current variant from the link JSON.
      const variant: string | undefined = rushConfiguration.currentInstalledVariant;

      const fullShrinkwrapPath: string = rushConfiguration.getCommittedShrinkwrapFilename(variant);

      const shrinkwrapFile: string = Path.convertToSlashes(path.relative(repoRoot, fullShrinkwrapPath));
      const shrinkwrapStatus: IFileDiffStatus | undefined = repoChanges.get(shrinkwrapFile);

      if (shrinkwrapStatus) {
        if (shrinkwrapStatus.status !== 'M') {
          terminal.writeLine(`Lockfile was created or deleted. Assuming all projects are affected.`);
          return new Set(rushConfiguration.projects);
        }

        const { packageManager } = rushConfiguration;

        if (packageManager === 'pnpm') {
          const currentShrinkwrap: PnpmShrinkwrapFile | undefined =
            PnpmShrinkwrapFile.loadFromFile(fullShrinkwrapPath);

          if (!currentShrinkwrap) {
            throw new Error(`Unable to obtain current shrinkwrap file.`);
          }

          const oldShrinkwrapText: string = this._git.getBlobContent({
            // <ref>:<path> syntax: https://git-scm.com/docs/gitrevisions
            blobSpec: `${mergeCommit}:${shrinkwrapFile}`,
            repositoryRoot: repoRoot
          });
          const oldShrinkWrap: PnpmShrinkwrapFile = PnpmShrinkwrapFile.loadFromString(oldShrinkwrapText);

          for (const project of rushConfiguration.projects) {
            if (
              currentShrinkwrap
                .getProjectShrinkwrap(project)
                .hasChanges(oldShrinkWrap.getProjectShrinkwrap(project))
            ) {
              changedProjects.add(project);
            }
          }
        } else {
          terminal.writeLine(
            `Lockfile has changed and lockfile content comparison is only supported for pnpm. Assuming all projects are affected.`
          );
          return new Set(rushConfiguration.projects);
        }
      }
    }

    const lookup: LookupByPath<RushConfigurationProject> =
      rushConfiguration.getProjectLookupForRoot(repoRoot);

    for (const file of repoChanges.keys()) {
      const match: IPrefixMatch<RushConfigurationProject> | undefined = lookup.findChildPathAndIndex(file);
      if (match) {
        const project: RushConfigurationProject = match.value;
        if (!changedProjects.has(project)) {
          const projectFilter: IProjectFileFilter | undefined = filters?.get(project);
          if (!projectFilter || projectFilter(file.slice(match.index + 1))) {
            changedProjects.add(project);
          }
        }
      }
    }

    return changedProjects;
  }

  private _getData(terminal: ITerminal): IRawRepoState {
    const repoState: IGitState | undefined = this._getRepoDeps(terminal);
    if (!repoState) {
      // Mark as resolved, but no data
      return {
        projectState: undefined,
        rootDir: this._rushConfiguration.rushJsonFolder
      };
    }

    const lookup: LookupByPath<RushConfigurationProject> = this._rushConfiguration.getProjectLookupForRoot(
      repoState.rootDir
    );
    const projectHashDeps: Map<RushConfigurationProject, Map<string, string>> = new Map();

    for (const project of this._rushConfiguration.projects) {
      projectHashDeps.set(project, new Map());
    }

    const { hashes: repoDeps, rootDir } = repoState;

    // Currently, only pnpm handles project shrinkwraps
    if (this._rushConfiguration.packageManager === 'pnpm') {
      const projectDependencyManifestPaths: string[] = [];

      for (const project of projectHashDeps.keys()) {
        const projectShrinkwrapFilePath: string = BaseProjectShrinkwrapFile.getFilePathForProject(project);
        const relativeProjectShrinkwrapFilePath: string = Path.convertToSlashes(
          path.relative(rootDir, projectShrinkwrapFilePath)
        );

        if (!FileSystem.exists(projectShrinkwrapFilePath)) {
          throw new Error(
            `A project dependency file (${relativeProjectShrinkwrapFilePath}) is missing. You may need to run ` +
              '"rush install" or "rush update".'
          );
        }

        projectDependencyManifestPaths.push(relativeProjectShrinkwrapFilePath);
      }

      const gitPath: string = this._git.getGitPathOrThrow();
      const hashes: Map<string, string> = getGitHashForFiles(
        projectDependencyManifestPaths,
        rootDir,
        gitPath
      );

      let i: number = 0;
      for (const projectDeps of projectHashDeps.values()) {
        const projectDependencyManifestPath: string = projectDependencyManifestPaths[i];
        const hash: string | undefined = hashes.get(projectDependencyManifestPath);
        if (hash === undefined) {
          throw new InternalError(`Expected to get a hash for ${projectDependencyManifestPath}`);
        }

        projectDeps.set(projectDependencyManifestPath, hash);
        i++;
      }
    } else {
      // Determine the current variant from the link JSON.
      const variant: string | undefined = this._rushConfiguration.currentInstalledVariant;

      // Add the shrinkwrap file to every project's dependencies
      const shrinkwrapFile: string = Path.convertToSlashes(
        path.relative(rootDir, this._rushConfiguration.getCommittedShrinkwrapFilename(variant))
      );

      const shrinkwrapHash: string | undefined = repoDeps.get(shrinkwrapFile);

      for (const projectDeps of projectHashDeps.values()) {
        if (shrinkwrapHash) {
          projectDeps.set(shrinkwrapFile, shrinkwrapHash);
        }
      }
    }

    // Sort each project folder into its own package deps hash
    for (const [filePath, fileHash] of repoDeps) {
      // lookups in findChildPath are O(K)
      // K being the maximum folder depth of any project in rush.json (usually on the order of 3)
      const owningProject: RushConfigurationProject | undefined = lookup.findChildPath(filePath);

      if (owningProject) {
        const owningProjectHashDeps: Map<string, string> = projectHashDeps.get(owningProject)!;
        owningProjectHashDeps.set(filePath, fileHash);
      }
    }

    return {
      projectState: projectHashDeps,
      rootDir
    };
  }

  private _getRepoDeps(terminal: ITerminal): IGitState | undefined {
    try {
      if (this._git.isPathUnderGitWorkingTree()) {
        // Load the package deps hash for the whole repository
        const gitPath: string = this._git.getGitPathOrThrow();
        const rootDir: string = getRepoRoot(this._rushConfiguration.rushJsonFolder, gitPath);
        const hashes: Map<string, string> = getRepoState(rootDir, gitPath);
        return {
          gitPath,
          hashes,
          rootDir
        };
      } else {
        return undefined;
      }
    } catch (e) {
      // If getPackageDeps fails, don't fail the whole build. Treat this case as if we don't know anything about
      // the state of the files in the repo. This can happen if the environment doesn't have Git.
      terminal.writeWarningLine(
        `Error calculating the state of the repo. (inner error: ${e}). Continuing without diffing files.`
      );

      return undefined;
    }
  }
}
