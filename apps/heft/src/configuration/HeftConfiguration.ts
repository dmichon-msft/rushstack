// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { type IPackageJson, PackageJsonLookup, InternalError, Path } from '@rushstack/node-core-library';
import { Terminal, type ITerminalProvider, type ITerminal } from '@rushstack/terminal';
import {
  type IProjectConfigurationFileSpecification,
  ProjectConfigurationFile
} from '@rushstack/heft-config-file';
import { type IRigConfig, RigConfig } from '@rushstack/rig-package';

import { Constants } from '../utilities/Constants';
import { RigPackageResolver, type IRigPackageResolver } from './RigPackageResolver';

import * as wellKnown from './wellKnown/JavaScriptEmitKinds';

/**
 * @internal
 */
export interface IHeftConfigurationInitializationOptions {
  /**
   * The working directory the tool was executed in.
   */
  cwd: string;

  /**
   * Terminal instance to facilitate logging.
   */
  terminalProvider: ITerminalProvider;
}

interface IProjectConfigurationFileEntry<TConfigFile> {
  options: IProjectConfigurationFileSpecification<TConfigFile>;
  loader: ProjectConfigurationFile<TConfigFile>;
}

const projectConfigurationFileRegistry: Map<string, IProjectConfigurationFileEntry<unknown>> = new Map();
/**
 * For unit test usage.
 * @internal
 */
export function _clearProjectConfigurationFileRegistry(): void {
  projectConfigurationFileRegistry.clear();
}

/**
 * @public
 */
export class HeftConfiguration {
  private _buildFolderPath!: string;
  private _slashNormalizedBuildFolderPath: string | undefined;
  private _projectConfigFolderPath: string | undefined;
  private _tempFolderPath: string | undefined;
  private _rigConfig: IRigConfig | undefined;
  private _globalTerminal!: Terminal;
  private _terminalProvider!: ITerminalProvider;
  private _rigPackageResolver!: RigPackageResolver;

  /**
   * Project build folder path. This is the folder containing the project's package.json file.
   */
  public get buildFolderPath(): string {
    return this._buildFolderPath;
  }

  /**
   * {@link HeftConfiguration.buildFolderPath} with all path separators converted to forward slashes.
   */
  public get slashNormalizedBuildFolderPath(): string {
    if (!this._slashNormalizedBuildFolderPath) {
      this._slashNormalizedBuildFolderPath = Path.convertToSlashes(this.buildFolderPath);
    }

    return this._slashNormalizedBuildFolderPath;
  }

  /**
   * The path to the project's "config" folder.
   */
  public get projectConfigFolderPath(): string {
    if (!this._projectConfigFolderPath) {
      this._projectConfigFolderPath = path.join(this.buildFolderPath, Constants.projectConfigFolderName);
    }

    return this._projectConfigFolderPath;
  }

  /**
   * The project's temporary folder.
   *
   * @remarks This folder exists at \<project root\>/temp. In general, this folder is used to store temporary
   * output from tasks under task-specific subfolders, and is not intended to be directly written to.
   * Instead, plugins should write to the directory provided by HeftTaskSession.taskTempFolderPath
   */
  public get tempFolderPath(): string {
    if (!this._tempFolderPath) {
      this._tempFolderPath = path.join(this._buildFolderPath, Constants.tempFolderName);
    }

    return this._tempFolderPath;
  }

  /**
   * The rig.json configuration for this project, if present.
   */
  public get rigConfig(): IRigConfig {
    if (!this._rigConfig) {
      throw new InternalError(
        'The rigConfig cannot be accessed until HeftConfiguration.checkForRigAsync() has been called'
      );
    }
    return this._rigConfig;
  }

  /**
   * The rig package resolver, which can be used to rig-resolve a requested package.
   */
  public get rigPackageResolver(): IRigPackageResolver {
    if (!this._rigPackageResolver) {
      this._rigPackageResolver = new RigPackageResolver({
        buildFolder: this.buildFolderPath,
        projectPackageJson: this.projectPackageJson,
        rigConfig: this.rigConfig
      });
    }
    return this._rigPackageResolver;
  }

  /**
   * Terminal instance to facilitate logging.
   */
  public get globalTerminal(): ITerminal {
    return this._globalTerminal;
  }

  /**
   * Terminal provider for the provided terminal.
   */
  public get terminalProvider(): ITerminalProvider {
    return this._terminalProvider;
  }

  /**
   * The Heft tool's package.json
   */
  public get heftPackageJson(): IPackageJson {
    return PackageJsonLookup.instance.tryLoadPackageJsonFor(__dirname)!;
  }

  /**
   * The package.json of the project being built
   */
  public get projectPackageJson(): IPackageJson {
    return PackageJsonLookup.instance.tryLoadPackageJsonFor(this.buildFolderPath)!;
  }

  /**
   * The set of named well-known configuration files that may be shared among multiple plugins.
   */
  public get wellKnownConfigurationFiles(): Readonly<typeof wellKnown> {
    return wellKnown;
  }

  private constructor() {}

  /**
   * Performs the search for rig.json and initializes the `HeftConfiguration.rigConfig` object.
   * @internal
   */
  public async _checkForRigAsync(): Promise<void> {
    if (!this._rigConfig) {
      this._rigConfig = await RigConfig.loadForProjectFolderAsync({
        projectFolderPath: this._buildFolderPath
      });
    }
  }

  /**
   * Attempts to load a riggable project configuration file.
   * @param options - The options for the configuration file loader from `@rushstack/heft-config-file`. If invoking this function multiple times for the same file, reuse the same object.
   * @param terminal - The terminal to log messages during configuration file loading.
   * @returns The configuration file, or undefined if it could not be loaded.
   */
  public async tryLoadProjectConfigurationFileAsync<TConfigFile>(
    options: IProjectConfigurationFileSpecification<TConfigFile>,
    terminal: ITerminal
  ): Promise<TConfigFile | undefined> {
    let entry: IProjectConfigurationFileEntry<TConfigFile> | undefined = projectConfigurationFileRegistry.get(
      options.projectRelativeFilePath
    ) as IProjectConfigurationFileEntry<TConfigFile> | undefined;

    if (!entry) {
      entry = {
        options: Object.freeze(options),
        loader: new ProjectConfigurationFile<TConfigFile>(options)
      };
    } else if (options !== entry.options) {
      throw new Error(
        `The project configuration file for ${options.projectRelativeFilePath} has already been loaded with different options. Please ensure that options object used to load the configuration file is the same referenced object in all calls.`
      );
    }

    const loader: ProjectConfigurationFile<TConfigFile> =
      entry.loader as ProjectConfigurationFile<TConfigFile>;
    return loader.tryLoadConfigurationFileForProjectAsync(terminal, this._buildFolderPath, this._rigConfig);
  }

  /**
   * @internal
   */
  public static initialize(options: IHeftConfigurationInitializationOptions): HeftConfiguration {
    const configuration: HeftConfiguration = new HeftConfiguration();

    const packageJsonPath: string | undefined = PackageJsonLookup.instance.tryGetPackageJsonFilePathFor(
      options.cwd
    );
    if (packageJsonPath) {
      let buildFolderPath: string = path.dirname(packageJsonPath);
      // On Windows it is possible for the drive letter in the CWD to be lowercase, but the normalized naming is uppercase
      // Force it to always be uppercase for consistency.
      buildFolderPath =
        process.platform === 'win32'
          ? buildFolderPath.charAt(0).toUpperCase() + buildFolderPath.slice(1)
          : buildFolderPath;
      configuration._buildFolderPath = buildFolderPath;
    } else {
      throw new Error('No package.json file found. Are you in a project folder?');
    }

    configuration._terminalProvider = options.terminalProvider;
    configuration._globalTerminal = new Terminal(options.terminalProvider);
    return configuration;
  }
}
