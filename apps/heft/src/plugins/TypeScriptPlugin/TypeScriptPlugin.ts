// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { Terminal, FileSystem, JsonFile } from '@rushstack/node-core-library';

import { TypeScriptBuilder, ITypeScriptBuilderConfiguration } from './TypeScriptBuilder';
import { HeftSession } from '../../pluginFramework/HeftSession';
import { HeftConfiguration } from '../../configuration/HeftConfiguration';
import { IHeftPlugin } from '../../pluginFramework/IHeftPlugin';
import {
  CopyFromCacheMode,
  IBuildStageContext,
  ICompileSubstage,
  IBuildStageProperties
} from '../../stages/BuildStage';
import { ToolPackageResolver, IToolPackageResolution } from '../../utilities/ToolPackageResolver';
import { ScopedLogger } from '../../pluginFramework/logging/ScopedLogger';
import { ICleanStageContext, ICleanStageProperties } from '../../stages/CleanStage';
import { CoreConfigFiles, ISharedCopyConfiguration } from '../../utilities/CoreConfigFiles';

const PLUGIN_NAME: string = 'typescript';

interface IRunTypeScriptOptions {
  heftSession: HeftSession;
  heftConfiguration: HeftConfiguration;
  buildProperties: IBuildStageProperties;
  watchMode: boolean;

  /**
   * Fired whenever the compiler emits an output.  In watch mode, this event occurs after each recompile.
   */
  emitCallback: () => void;
}

interface IEmitModuleKind {
  moduleKind: 'commonjs' | 'amd' | 'umd' | 'system' | 'es2015' | 'esnext';
  outFolderName: string;
  jsExtensionOverride?: string;
}

interface IRawProjectReference {
  path: string;
}

interface IRawTsConfigJson {
  references?: readonly IRawProjectReference[];
  compilerOptions?: {
    composite?: boolean;
  };
}

interface IBuildTaskInfo {
  loggerName: string;
  rawConfig: IRawTsConfigJson;
  deps: Set<string>;
}

export interface ISharedTypeScriptConfiguration {
  /**
   * Can be set to 'copy' or 'hardlink'. If set to 'copy', copy files from cache. If set to 'hardlink', files will be
   * hardlinked to the cache location. This option is useful when producing a tarball of build output as TAR files
   * don't handle these hardlinks correctly. 'hardlink' is the default behavior.
   */
  copyFromCacheMode?: CopyFromCacheMode | undefined;

  /**
   * If provided, emit these module kinds in addition to the modules specified in the tsconfig.
   * Note that this option only applies to the main tsconfig.json configuration.
   */
  additionalModuleKindsToEmit?: IEmitModuleKind[] | undefined;

  /**
   * If 'true', emit CommonJS output into the TSConfig outDir with the file extension '.cjs'
   */
  emitCjsExtensionForCommonJS?: boolean | undefined;

  /**
   * If 'true', emit ESModule output into the TSConfig outDir with the file extension '.mjs'
   */
  emitMjsExtensionForESModule?: boolean | undefined;

  /**
   * Specifies the intermediary folder that tests will use.  Because Jest uses the
   * Node.js runtime to execute tests, the module format must be CommonJS.
   *
   * The default value is "lib".
   */
  emitFolderNameForTests?: string;

  /**
   * Specifies the path to one or more tsconfig.json, relative to the project root.
   *
   * The default value is ["tsconfig.json"]
   */
  tsconfigPaths?: string[] | undefined;

  /**
   * Configures additional file types that should be copied into the TypeScript compiler's emit folders, for example
   * so that these files can be resolved by import statements.
   */
  staticAssetsToCopy?: ISharedCopyConfiguration;
}

export interface ITypeScriptConfigurationJson extends ISharedTypeScriptConfiguration {
  disableTslint?: boolean;
  maxWriteParallelism: number | undefined;
}

interface ITypeScriptConfiguration extends ISharedTypeScriptConfiguration {
  /**
   * Set this to change the maximum number of file handles that will be opened concurrently for writing.
   * The default is 50.
   */
  maxWriteParallelism: number;

  isLintingEnabled: boolean | undefined;
}

interface ITypeScriptConfigurationFileCacheEntry {
  configurationFile: ITypeScriptConfigurationJson | undefined;
}

export class TypeScriptPlugin implements IHeftPlugin {
  public readonly pluginName: string = PLUGIN_NAME;

  private readonly _taskPackageResolver: ToolPackageResolver;
  private _typeScriptConfigurationFileCache: Map<string, ITypeScriptConfigurationFileCacheEntry> = new Map<
    string,
    ITypeScriptConfigurationFileCacheEntry
  >();

  public constructor(taskPackageResolver: ToolPackageResolver) {
    this._taskPackageResolver = taskPackageResolver;
  }

  public apply(heftSession: HeftSession, heftConfiguration: HeftConfiguration): void {
    const logger: ScopedLogger = heftSession.requestScopedLogger('TypeScript Plugin');

    heftSession.hooks.clean.tap(PLUGIN_NAME, (clean: ICleanStageContext) => {
      clean.hooks.loadStageConfiguration.tapPromise(PLUGIN_NAME, async () => {
        await this._updateCleanOptions(logger, heftConfiguration, clean.properties);
      });
    });

    heftSession.hooks.build.tap(PLUGIN_NAME, (build: IBuildStageContext) => {
      build.hooks.compile.tap(PLUGIN_NAME, (compile: ICompileSubstage) => {
        compile.hooks.run.tapPromise(PLUGIN_NAME, async () => {
          await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            let isFirstEmit: boolean = true;
            this._runTypeScriptAsync(logger, {
              heftSession,
              heftConfiguration,
              buildProperties: build.properties,
              watchMode: build.properties.watchMode,
              emitCallback: () => {
                if (isFirstEmit) {
                  isFirstEmit = false;

                  // In watch mode, `_runTypeScriptAsync` will never resolve so we need to resolve the promise here
                  // to allow the build to move on to the `afterCompile` substage.
                  if (build.properties.watchMode) {
                    resolve();
                  }
                } else {
                  compile.hooks.afterRecompile.promise().catch((error) => {
                    heftConfiguration.globalTerminal.writeErrorLine(
                      `An error occurred in an afterRecompile hook: ${error}`
                    );
                  });
                }
              }
            })
              .then(resolve)
              .catch(reject);
          });
        });
      });
    });
  }

  private async _ensureConfigFileLoadedAsync(
    terminal: Terminal,
    heftConfiguration: HeftConfiguration
  ): Promise<ITypeScriptConfigurationJson | undefined> {
    const buildFolder: string = heftConfiguration.buildFolder;
    let typescriptConfigurationFileCacheEntry: ITypeScriptConfigurationFileCacheEntry | undefined =
      this._typeScriptConfigurationFileCache.get(buildFolder);

    if (!typescriptConfigurationFileCacheEntry) {
      typescriptConfigurationFileCacheEntry = {
        configurationFile:
          await CoreConfigFiles.typeScriptConfigurationFileLoader.tryLoadConfigurationFileForProjectAsync(
            terminal,
            buildFolder,
            heftConfiguration.rigConfig
          )
      };

      this._typeScriptConfigurationFileCache.set(buildFolder, typescriptConfigurationFileCacheEntry);
    }

    return typescriptConfigurationFileCacheEntry.configurationFile;
  }

  private async _updateCleanOptions(
    logger: ScopedLogger,
    heftConfiguration: HeftConfiguration,
    cleanProperties: ICleanStageProperties
  ): Promise<void> {
    const configurationFile: ITypeScriptConfigurationJson | undefined =
      await this._ensureConfigFileLoadedAsync(logger.terminal, heftConfiguration);

    if (configurationFile?.additionalModuleKindsToEmit) {
      for (const additionalModuleKindToEmit of configurationFile.additionalModuleKindsToEmit) {
        cleanProperties.pathsToDelete.add(
          path.resolve(heftConfiguration.buildFolder, additionalModuleKindToEmit.outFolderName)
        );
      }
    }
  }

  private async _getBuildOrderAsync(
    buildFolder: string,
    typescriptConfigurationJson: ITypeScriptConfigurationJson | undefined
  ): Promise<Map<string, IBuildTaskInfo>> {
    const { tsconfigPaths = ['tsconfig.json'] } = typescriptConfigurationJson || {};

    const resolvedPaths: string[] = tsconfigPaths.map((configPath: string) =>
      path.resolve(buildFolder, configPath)
    );

    const dependencyMap: Map<string, IBuildTaskInfo> = new Map();
    try {
      await Promise.all(
        resolvedPaths.map(async (configPath: string, index: number) => {
          const tsConfig: IRawTsConfigJson = await JsonFile.loadAsync(configPath);
          dependencyMap.set(configPath, {
            loggerName: tsconfigPaths[index],
            deps: new Set(),
            rawConfig: tsConfig
          });
        })
      );
    } catch (err) {
      if (!FileSystem.isNotExistError(err)) {
        throw err;
      }

      if (!typescriptConfigurationJson) {
        // Not a TypeScript project. Empty dependency graph.
        return new Map();
      }

      // Was a typescript project, but a reference config does not exist.
      throw err;
    }

    for (const [configPath, { deps, rawConfig }] of dependencyMap) {
      if (!rawConfig.references) {
        continue;
      }

      const configDir: string = path.dirname(configPath);
      for (const ref of rawConfig.references) {
        const resolved: string = path.resolve(configDir, ref.path);
        if (dependencyMap.has(resolved)) {
          deps.add(resolved);
        }
      }
    }

    return dependencyMap;
  }

  private async _runTypeScriptAsync(logger: ScopedLogger, options: IRunTypeScriptOptions): Promise<void> {
    const { heftSession, heftConfiguration, buildProperties, watchMode } = options;

    const typescriptConfigurationJson: ITypeScriptConfigurationJson | undefined =
      await this._ensureConfigFileLoadedAsync(logger.terminal, heftConfiguration);

    const buildOrder: Map<string, IBuildTaskInfo> = await this._getBuildOrderAsync(
      heftConfiguration.buildFolder,
      typescriptConfigurationJson
    );
    if (!buildOrder.size) {
      // No tsconfig. Nothing to do.
      buildProperties.isTypeScriptProject = false;
      return;
    }

    if (buildOrder.size > 1 && watchMode) {
      throw new Error(`Heft does not yet support --watch for multiple tsconfigs in a single project.`);
    }

    const typeScriptConfiguration: ITypeScriptConfiguration = {
      copyFromCacheMode: typescriptConfigurationJson?.copyFromCacheMode,
      additionalModuleKindsToEmit: typescriptConfigurationJson?.additionalModuleKindsToEmit,
      emitCjsExtensionForCommonJS: typescriptConfigurationJson?.emitCjsExtensionForCommonJS,
      emitMjsExtensionForESModule: typescriptConfigurationJson?.emitMjsExtensionForESModule,
      emitFolderNameForTests: typescriptConfigurationJson?.emitFolderNameForTests,
      maxWriteParallelism: typescriptConfigurationJson?.maxWriteParallelism || 50,
      isLintingEnabled: !(buildProperties.lite || typescriptConfigurationJson?.disableTslint)
    };

    if (heftConfiguration.projectPackageJson.private !== true) {
      if (typeScriptConfiguration.copyFromCacheMode === undefined) {
        logger.terminal.writeVerboseLine(
          'Setting TypeScript copyFromCacheMode to "copy" because the "private" field ' +
            'in package.json is not set to true. Linked files are not handled correctly ' +
            'when package are packed for publishing.'
        );
        // Copy if the package is intended to be published
        typeScriptConfiguration.copyFromCacheMode = 'copy';
      } else if (typeScriptConfiguration.copyFromCacheMode !== 'copy') {
        logger.emitWarning(
          new Error(
            `The TypeScript copyFromCacheMode is set to "${typeScriptConfiguration.copyFromCacheMode}", ` +
              'but the the "private" field in package.json is not set to true. ' +
              'Linked files are not handled correctly when packages are packed for publishing.'
          )
        );
      }
    }

    const toolPackageResolution: IToolPackageResolution =
      await this._taskPackageResolver.resolveToolPackagesAsync(heftConfiguration, logger.terminal);
    if (!toolPackageResolution.typeScriptPackagePath) {
      throw new Error('Unable to resolve a TypeScript compiler package');
    }

    // Set some properties used by the Jest plugin
    buildProperties.emitFolderNameForTests = typeScriptConfiguration.emitFolderNameForTests || 'lib';
    buildProperties.emitExtensionForTests = typeScriptConfiguration.emitCjsExtensionForCommonJS
      ? '.cjs'
      : '.js';

    const typeScriptBuilderCommonConfiguration: Omit<
      ITypeScriptBuilderConfiguration,
      'tsconfigPath' | 'loggerName'
    > = {
      buildFolder: heftConfiguration.buildFolder,
      typeScriptToolPath: toolPackageResolution.typeScriptPackagePath!,
      tslintToolPath: toolPackageResolution.tslintPackagePath,
      eslintToolPath: toolPackageResolution.eslintPackagePath,

      lintingEnabled: !!typeScriptConfiguration.isLintingEnabled,
      buildCacheFolder: heftConfiguration.buildCacheFolder,
      additionalModuleKindsToEmit: typeScriptConfiguration.additionalModuleKindsToEmit,
      emitCjsExtensionForCommonJS: !!typeScriptConfiguration.emitCjsExtensionForCommonJS,
      emitMjsExtensionForESModule: !!typeScriptConfiguration.emitMjsExtensionForESModule,
      copyFromCacheMode: typeScriptConfiguration.copyFromCacheMode,
      watchMode: watchMode,
      maxWriteParallelism: typeScriptConfiguration.maxWriteParallelism
    };

    const getNextTsConfig: () => [string, IBuildTaskInfo] = () => {
      for (const item of buildOrder) {
        if (item[1].deps.size === 0) {
          return item;
        }
      }
      throw new Error(
        `Circular dependency in remaining tsconfigs: '${Array.from(buildOrder.keys()).join(`', '`)}'.`
      );
    };

    while (buildOrder.size > 0) {
      const [tsconfigPath, buildTask] = getNextTsConfig();

      logger.terminal.writeLine(`Processing config at ${tsconfigPath}.`);

      const builderConfiguration: ITypeScriptBuilderConfiguration = {
        ...typeScriptBuilderCommonConfiguration,
        tsconfigPath,
        loggerName: buildTask.loggerName
      };

      const builder: TypeScriptBuilder = new TypeScriptBuilder(
        heftConfiguration.terminalProvider,
        builderConfiguration,
        heftSession,
        options.emitCallback
      );

      if (heftSession.debugMode) {
        await builder.invokeAsync();
      } else {
        await builder.invokeAsSubprocessAsync();
      }

      buildOrder.delete(tsconfigPath);
      for (const { deps } of buildOrder.values()) {
        deps.delete(tsconfigPath);
      }
    }
  }
}
