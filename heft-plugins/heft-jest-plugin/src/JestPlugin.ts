// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// Load the Jest patches before anything else loads
import './patches/jestWorkerPatch';

import * as path from 'path';
import type { AggregatedResult } from '@jest/reporters';
import type { Config } from '@jest/types';
import { resolveRunner, resolveSequencer, resolveTestEnvironment, resolveWatchPlugin } from 'jest-resolve';
import { mergeWith, isObject } from 'lodash';
import type {
  HeftConfiguration,
  IScopedLogger,
  IHeftTaskPlugin,
  IHeftTaskSession,
  IHeftTaskRunHookOptions,
  IHeftTaskRunIncrementalHookOptions,
  CommandLineFlagParameter,
  CommandLineIntegerParameter,
  CommandLineStringParameter,
  CommandLineStringListParameter
} from '@rushstack/heft';
import {
  ConfigurationFile,
  type IJsonPathMetadata,
  InheritanceType,
  PathResolutionMethod
} from '@rushstack/heft-config-file';
import { FileSystem, Import, JsonFile, PackageName, type ITerminal } from '@rushstack/node-core-library';

import type { IHeftJestReporterOptions } from './HeftJestReporter';
import { jestResolve } from './JestUtils';

type JestReporterConfig = string | Config.ReporterConfig;

/**
 * Options to use when performing resolution for paths and modules specified in the Jest
 * configuration.
 */
interface IJestResolutionOptions {
  /**
   * The value that will be substituted for <rootDir> tokens.
   */
  rootDir: string;
  /**
   * Whether the value should be resolved as a module relative to the configuration file after
   * substituting special tokens.
   */
  resolveAsModule?: boolean;
}

/**
 * Options that can be provided to the plugin.
 */
export interface IJestPluginOptions {
  configurationPath?: string;
  debugHeftReporter?: boolean;
  detectOpenHandles?: boolean;
  disableCodeCoverage?: boolean;
  disableConfigurationModuleResolution?: boolean;
  extensionForTests?: '.js' | '.cjs' | '.mjs';
  findRelatedTests?: string[];
  folderNameForTests?: string;
  maxWorkers?: string;
  passWithNoTests?: boolean;
  silent?: boolean;
  testNamePattern?: string;
  testPathPattern?: string;
  testTimeout?: number;
  updateSnapshots?: boolean;
}

export interface IHeftJestConfiguration extends Config.InitialOptions {}

const PLUGIN_NAME: 'jest-plugin' = 'jest-plugin';
const PLUGIN_PACKAGE_NAME: string = '@rushstack/heft-jest-plugin';
const PLUGIN_PACKAGE_FOLDER: string = path.resolve(__dirname, '..');
const JEST_CONFIGURATION_LOCATION: string = `config/jest.config.json`;

const ROOTDIR_TOKEN: string = '<rootDir>';
const CONFIGDIR_TOKEN: string = '<configDir>';
const PACKAGE_CAPTUREGROUP: string = 'package';
const PACKAGEDIR_REGEX: RegExp = /^<packageDir:\s*(?<package>[^\s>]+)\s*>/;
const JSONPATHPROPERTY_REGEX: RegExp = /^\$\['([^']+)'\]/;

const JEST_CONFIG_PACKAGE_FOLDER: string = path.dirname(require.resolve('jest-config'));

interface IPendingTestRun {
  (): Promise<AggregatedResult | undefined>;
}

/**
 * @internal
 */
export default class JestPlugin implements IHeftTaskPlugin<IJestPluginOptions> {
  private static _jestConfigurationFileLoader: ConfigurationFile<IHeftJestConfiguration> | undefined;

  private _jestPromise: Promise<unknown> | undefined;
  private _pendingTestRuns: Set<IPendingTestRun> = new Set();
  private _executing: boolean = false;

  /**
   * Setup the hooks and custom CLI options for the Jest plugin.
   *
   * @override
   */
  public apply(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    pluginOptions?: IJestPluginOptions
  ): void {
    const { parameters } = taskSession;

    // Flags
    const detectOpenHandlesParameter: CommandLineFlagParameter =
      parameters.getFlagParameter('--detect-open-handles');
    const debugHeftReporterParameter: CommandLineFlagParameter =
      parameters.getFlagParameter('--debug-heft-reporter');
    const disableCodeCoverageParameter: CommandLineFlagParameter =
      parameters.getFlagParameter('--disable-code-coverage');
    const silentParameter: CommandLineFlagParameter = parameters.getFlagParameter('--silent');
    const updateSnapshotsParameter: CommandLineFlagParameter =
      parameters.getFlagParameter('--update-snapshots');

    // Strings
    const configParameter: CommandLineStringParameter = parameters.getStringParameter('--config');
    const maxWorkersParameter: CommandLineStringParameter = parameters.getStringParameter('--max-workers');
    const testNamePatternParameter: CommandLineStringParameter =
      parameters.getStringParameter('--test-name-pattern');
    const testPathPatternParameter: CommandLineStringParameter =
      parameters.getStringParameter('--test-path-pattern');

    // String lists
    const findRelatedTestsParameter: CommandLineStringListParameter =
      parameters.getStringListParameter('--find-related-tests');

    // Integers
    const testTimeoutParameter: CommandLineIntegerParameter =
      parameters.getIntegerParameter('--test-timeout-ms');

    const combinedOptions: IJestPluginOptions = {
      ...pluginOptions,
      configurationPath: configParameter.value || pluginOptions?.configurationPath,
      debugHeftReporter: debugHeftReporterParameter.value || pluginOptions?.debugHeftReporter,
      detectOpenHandles: detectOpenHandlesParameter.value || pluginOptions?.detectOpenHandles,
      disableCodeCoverage: disableCodeCoverageParameter.value || pluginOptions?.disableCodeCoverage,
      findRelatedTests: findRelatedTestsParameter.values.length
        ? Array.from(findRelatedTestsParameter.values)
        : pluginOptions?.findRelatedTests,
      maxWorkers: maxWorkersParameter.value || pluginOptions?.maxWorkers,
      // Default to true and always pass with no tests
      passWithNoTests: true,
      silent: silentParameter.value || pluginOptions?.silent,
      testNamePattern: testNamePatternParameter.value || pluginOptions?.testNamePattern,
      testPathPattern: testPathPatternParameter.value || pluginOptions?.testPathPattern,
      testTimeout: testTimeoutParameter.value ?? pluginOptions?.testTimeout,
      updateSnapshots: updateSnapshotsParameter.value || pluginOptions?.updateSnapshots
    };

    taskSession.hooks.run.tapPromise(PLUGIN_NAME, async (runOptions: IHeftTaskRunHookOptions) => {
      await this._runJestAsync(taskSession, heftConfiguration, combinedOptions);
    });

    taskSession.hooks.runIncremental.tapPromise(
      PLUGIN_NAME,
      async (runIncrementalOptions: IHeftTaskRunIncrementalHookOptions) => {
        await this._runJestWatchAsync(
          taskSession,
          heftConfiguration,
          combinedOptions,
          runIncrementalOptions.requestRun
        );
      }
    );
  }

  /**
   * Runs Jest using the provided options.
   */
  private async _runJestAsync(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    options: IJestPluginOptions
  ): Promise<void> {
    const logger: IScopedLogger = taskSession.logger;
    const terminal: ITerminal = logger.terminal;

    const { getVersion, runCLI } = await import(`@jest/core`);
    terminal.writeLine(`Using Jest version ${getVersion()}`);

    const buildFolderPath: string = heftConfiguration.buildFolderPath;
    const projectRelativeFilePath: string = options?.configurationPath ?? JEST_CONFIGURATION_LOCATION;
    let jestConfig: IHeftJestConfiguration;
    if (options?.disableConfigurationModuleResolution) {
      // Module resolution explicitly disabled, use the config as-is
      const jestConfigPath: string = path.join(buildFolderPath, projectRelativeFilePath);
      if (!(await FileSystem.existsAsync(jestConfigPath))) {
        logger.emitError(new Error(`Expected to find jest config file at "${jestConfigPath}".`));
        return;
      }
      jestConfig = await JsonFile.loadAsync(jestConfigPath);
    } else {
      // Load in and resolve the config file using the "extends" field
      jestConfig = await JestPlugin._getJestConfigurationLoader(
        buildFolderPath,
        projectRelativeFilePath
      ).loadConfigurationFileForProjectAsync(
        terminal,
        heftConfiguration.buildFolderPath,
        heftConfiguration.rigConfig
      );
      if (jestConfig.preset) {
        throw new Error(
          'The provided jest.config.json specifies a "preset" property while using resolved modules. ' +
            'You must either remove all "preset" values from your Jest configuration, use the "extends" ' +
            'property, or set the "disableConfigurationModuleResolution" option to "true" on the Jest ' +
            'plugin in heft.json'
        );
      }
    }

    // If no displayName is provided, use the package name. This field is used by Jest to
    // differentiate in multi-project repositories, and since we have the context, we may
    // as well provide it.
    if (!jestConfig.displayName) {
      jestConfig.displayName = heftConfiguration.projectPackageJson.name;
    }

    const jestArgv: Config.Argv = {
      // In debug mode, avoid forking separate processes that are difficult to debug
      runInBand: taskSession.parameters.debug,
      debug: taskSession.parameters.debug,
      detectOpenHandles: options.detectOpenHandles || false,

      // Use the temp folder. Cache is unreliable, so we want it cleared on every --clean run
      cacheDirectory: taskSession.tempFolderPath,
      updateSnapshot: options.updateSnapshots,

      listTests: false,
      rootDir: buildFolderPath,

      silent: options.silent || false,
      testNamePattern: options.testNamePattern,
      testPathPattern: options.testPathPattern ? [options.testPathPattern] : undefined,
      testTimeout: options.testTimeout,
      maxWorkers: options.maxWorkers,

      passWithNoTests: options.passWithNoTests,

      $0: process.argv0,
      _: []
    };

    if (!options.debugHeftReporter) {
      // Extract the reporters and transform to include the Heft reporter by default
      jestArgv.reporters = JestPlugin._extractHeftJestReporters(
        taskSession,
        heftConfiguration,
        jestConfig,
        projectRelativeFilePath
      );
    } else {
      logger.emitWarning(
        new Error('The "--debug-heft-reporter" parameter was specified; disabling HeftJestReporter')
      );
    }

    if (options.findRelatedTests?.length) {
      // Pass test names as the command line remainder
      jestArgv.findRelatedTests = true;
      jestArgv._ = [...options.findRelatedTests];
    }

    if (options.disableCodeCoverage) {
      jestConfig.collectCoverage = false;
    }

    // Stringify the config and pass it into Jest directly
    jestArgv.config = JSON.stringify(jestConfig);

    const {
      // Config.Argv is weakly typed.  After updating the jestArgv object, it's a good idea to inspect "globalConfig"
      // in the debugger to validate that your changes are being applied as expected.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      globalConfig,
      results: jestResults
    } = await runCLI(jestArgv, [buildFolderPath]);

    if (jestResults.numFailedTests > 0) {
      logger.emitError(
        new Error(
          `${jestResults.numFailedTests} Jest test${jestResults.numFailedTests > 1 ? 's' : ''} failed`
        )
      );
    } else if (jestResults.numFailedTestSuites > 0) {
      logger.emitError(
        new Error(
          `${jestResults.numFailedTestSuites} Jest test suite${
            jestResults.numFailedTestSuites > 1 ? 's' : ''
          } failed`
        )
      );
    }
  }

  /**
   * Runs Jest using the provided options.
   */
  private async _runJestWatchAsync(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    options: IJestPluginOptions,
    requestRun: () => void
  ): Promise<void> {
    const logger: IScopedLogger = taskSession.logger;
    const terminal: ITerminal = logger.terminal;

    const pendingTestRuns: Set<IPendingTestRun> = this._pendingTestRuns;

    if (!this._jestPromise) {
      // Monkey-patch Jest's watch mode so that we can orchestrate it.
      const jestCoreDir: string = path.dirname(require.resolve('@jest/core'));

      // Tell Jest we are a dumb terminal
      process.env.TERM = 'dumb';

      // Shim watch so that we can intercept the output stream
      const watchModulePath: string = path.resolve(jestCoreDir, 'watch.js');
      const watchModule: typeof import('@jest/core/build/watch') = require(watchModulePath);
      const { default: originalWatch } = watchModule;
      type WatchParams = Parameters<typeof originalWatch>;
      const watch: typeof originalWatch = (
        initialGlobalConfig: WatchParams[0],
        contexts: WatchParams[1],
        outputStream: NodeJS.WriteStream,
        hasteMapInstances: WatchParams[3],
        stdin: NodeJS.ReadStream | undefined,
        hooks: WatchParams[5],
        filter: WatchParams[6]
      ) => {
        // TODO: Route `outputStream` via `terminal`
        return originalWatch(
          initialGlobalConfig,
          contexts,
          outputStream,
          hasteMapInstances,
          stdin,
          hooks,
          filter
        );
      };
      Object.defineProperty(watchModule, 'default', {
        get(): typeof originalWatch {
          return watch;
        }
      });

      // Shim runJest so that we can defer test execution
      const runJestModulePath: string = path.resolve(jestCoreDir, 'runJest.js');
      const runJestModule: typeof import('@jest/core/build/runJest') = require(runJestModulePath);
      const { default: originalRunJest } = runJestModule;
      const runJest: typeof originalRunJest = (
        params: Parameters<typeof originalRunJest>[0]
      ): Promise<void> => {
        if (!this._executing) {
          process.nextTick(requestRun);
        }

        return new Promise((resolve: () => void, reject: (err: Error) => void) => {
          pendingTestRuns.add(async (): Promise<AggregatedResult | undefined> => {
            let result: AggregatedResult | undefined;
            const { onComplete } = params;
            try {
              await originalRunJest({
                ...params,
                onComplete: (testResults: AggregatedResult) => {
                  result = testResults;
                  onComplete(testResults);
                }
              });
              resolve();
            } catch (err) {
              reject(err);
              throw err;
            }

            return result;
          });
        });
      };

      Object.defineProperty(runJestModule, 'default', {
        get(): typeof originalRunJest {
          return runJest;
        }
      });

      const { getVersion, runCLI } = await import(`@jest/core`);
      terminal.writeLine(`Using Jest version ${getVersion()}`);

      const buildFolderPath: string = heftConfiguration.buildFolderPath;
      const projectRelativeFilePath: string = options?.configurationPath ?? JEST_CONFIGURATION_LOCATION;
      let jestConfig: IHeftJestConfiguration;
      if (options?.disableConfigurationModuleResolution) {
        // Module resolution explicitly disabled, use the config as-is
        const jestConfigPath: string = path.join(buildFolderPath, projectRelativeFilePath);
        if (!(await FileSystem.existsAsync(jestConfigPath))) {
          logger.emitError(new Error(`Expected to find jest config file at "${jestConfigPath}".`));
          return;
        }
        jestConfig = await JsonFile.loadAsync(jestConfigPath);
      } else {
        // Load in and resolve the config file using the "extends" field
        jestConfig = await JestPlugin._getJestConfigurationLoader(
          buildFolderPath,
          projectRelativeFilePath
        ).loadConfigurationFileForProjectAsync(
          terminal,
          heftConfiguration.buildFolderPath,
          heftConfiguration.rigConfig
        );
        if (jestConfig.preset) {
          throw new Error(
            'The provided jest.config.json specifies a "preset" property while using resolved modules. ' +
              'You must either remove all "preset" values from your Jest configuration, use the "extends" ' +
              'property, or set the "disableConfigurationModuleResolution" option to "true" on the Jest ' +
              'plugin in heft.json'
          );
        }
      }

      // If no displayName is provided, use the package name. This field is used by Jest to
      // differentiate in multi-project repositories, and since we have the context, we may
      // as well provide it.
      if (!jestConfig.displayName) {
        jestConfig.displayName = heftConfiguration.projectPackageJson.name;
      }

      const jestArgv: Config.Argv = {
        // In debug mode, avoid forking separate processes that are difficult to debug
        runInBand: taskSession.parameters.debug,
        debug: taskSession.parameters.debug,
        detectOpenHandles: options.detectOpenHandles || false,

        // Use the temp folder. Cache is unreliable, so we want it cleared on every --clean run
        cacheDirectory: taskSession.tempFolderPath,
        updateSnapshot: options.updateSnapshots,

        listTests: false,
        rootDir: buildFolderPath,

        silent: options.silent || false,
        testNamePattern: options.testNamePattern,
        testPathPattern: options.testPathPattern ? [options.testPathPattern] : undefined,
        testTimeout: options.testTimeout,
        maxWorkers: options.maxWorkers,

        passWithNoTests: options.passWithNoTests,

        $0: process.argv0,
        _: [],

        watch: true
      };

      if (!options.debugHeftReporter) {
        // Extract the reporters and transform to include the Heft reporter by default
        jestArgv.reporters = JestPlugin._extractHeftJestReporters(
          taskSession,
          heftConfiguration,
          jestConfig,
          projectRelativeFilePath
        );
      } else {
        logger.emitWarning(
          new Error('The "--debug-heft-reporter" parameter was specified; disabling HeftJestReporter')
        );
      }

      if (options.findRelatedTests?.length) {
        // Pass test names as the command line remainder
        jestArgv.findRelatedTests = true;
        jestArgv._ = [...options.findRelatedTests];
      }

      if (options.disableCodeCoverage) {
        jestConfig.collectCoverage = false;
      }

      // Stringify the config and pass it into Jest directly
      jestArgv.config = JSON.stringify(jestConfig);

      this._jestPromise = runCLI(jestArgv, [buildFolderPath]);
    }

    if (pendingTestRuns.size > 0) {
      this._executing = true;
      for (const pendingTestRun of pendingTestRuns) {
        pendingTestRuns.delete(pendingTestRun);
        const jestResults: AggregatedResult | undefined = await pendingTestRun();
        if (jestResults) {
          if (jestResults.numFailedTests > 0) {
            logger.emitError(
              new Error(
                `${jestResults.numFailedTests} Jest test${jestResults.numFailedTests > 1 ? 's' : ''} failed`
              )
            );
          } else if (jestResults.numFailedTestSuites > 0) {
            logger.emitError(
              new Error(
                `${jestResults.numFailedTestSuites} Jest test suite${
                  jestResults.numFailedTestSuites > 1 ? 's' : ''
                } failed`
              )
            );
          }
        } else {
          terminal.writeLine(`No tests were executed.`);
        }
      }
      this._executing = false;
    } else {
      terminal.writeLine(`No pending test runs.`);
    }
  }

  /**
   * Returns the loader for the `config/api-extractor-task.json` config file.
   */
  public static _getJestConfigurationLoader(
    buildFolder: string,
    projectRelativeFilePath: string
  ): ConfigurationFile<IHeftJestConfiguration> {
    if (!JestPlugin._jestConfigurationFileLoader) {
      // Bypass Jest configuration validation
      const schemaPath: string = `${__dirname}/schemas/anything.schema.json`;

      // By default, ConfigurationFile will replace all objects, so we need to provide merge functions for these
      const shallowObjectInheritanceFunc: <T extends Record<string, unknown> | undefined>(
        currentObject: T,
        parentObject: T
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) => T = <T>(currentObject: T, parentObject?: T): T => {
        // Merged in this order to ensure that the currentObject properties take priority in order-of-definition,
        // since Jest executes them in this order. For example, if the extended Jest configuration contains a
        // "\\.(css|sass|scss)$" transform but the extending Jest configuration contains a "\\.(css)$" transform,
        // merging like this will ensure that the returned transforms are executed in the correct order, stopping
        // after hitting the first pattern that applies:
        // {
        //   "\\.(css)$": "...",
        //   "\\.(css|sass|scss)$": "..."
        // }
        // https://github.com/facebook/jest/blob/0a902e10e0a5550b114340b87bd31764a7638729/packages/jest-config/src/normalize.ts#L102
        return { ...(currentObject || {}), ...(parentObject || {}), ...(currentObject || {}) } as T;
      };
      const deepObjectInheritanceFunc: <T extends Record<string, unknown> | undefined>(
        currentObject: T,
        parentObject: T
      ) => T = <T>(currentObject: T, parentObject: T): T => {
        return mergeWith(parentObject || {}, currentObject || {}, (value: T, source: T) => {
          // Need to use a custom inheritance function instead of "InheritanceType.merge" since
          // some properties are allowed to have different types which may be incompatible with
          // merging.
          if (!isObject(source)) {
            return source;
          }
          return Array.isArray(value) ? [...value, ...(source as Array<unknown>)] : { ...value, ...source };
        }) as T;
      };

      const tokenResolveMetadata: IJsonPathMetadata = JestPlugin._getJsonPathMetadata({
        rootDir: buildFolder
      });
      const jestResolveMetadata: IJsonPathMetadata = JestPlugin._getJsonPathMetadata({
        rootDir: buildFolder,
        resolveAsModule: true
      });

      JestPlugin._jestConfigurationFileLoader = new ConfigurationFile<IHeftJestConfiguration>({
        projectRelativeFilePath: projectRelativeFilePath,
        jsonSchemaPath: schemaPath,
        propertyInheritance: {
          moduleNameMapper: {
            inheritanceType: InheritanceType.custom,
            inheritanceFunction: shallowObjectInheritanceFunc
          },
          transform: {
            inheritanceType: InheritanceType.custom,
            inheritanceFunction: shallowObjectInheritanceFunc
          },
          globals: {
            inheritanceType: InheritanceType.custom,
            inheritanceFunction: deepObjectInheritanceFunc
          }
        },
        jsonPathMetadata: {
          // string
          '$.cacheDirectory': tokenResolveMetadata,
          '$.coverageDirectory': tokenResolveMetadata,
          '$.dependencyExtractor': jestResolveMetadata,
          '$.filter': jestResolveMetadata,
          '$.globalSetup': jestResolveMetadata,
          '$.globalTeardown': jestResolveMetadata,
          '$.moduleLoader': jestResolveMetadata,
          '$.prettierPath': jestResolveMetadata,
          '$.resolver': jestResolveMetadata,
          '$.runner': jestResolveMetadata,
          '$.snapshotResolver': jestResolveMetadata,
          '$.testEnvironment': jestResolveMetadata,
          '$.testResultsProcessor': jestResolveMetadata,
          '$.testRunner': jestResolveMetadata,
          '$.testSequencer': jestResolveMetadata,
          // string[]
          '$.modulePaths.*': tokenResolveMetadata,
          '$.roots.*': tokenResolveMetadata,
          '$.setupFiles.*': jestResolveMetadata,
          '$.setupFilesAfterEnv.*': jestResolveMetadata,
          '$.snapshotSerializers.*': jestResolveMetadata,
          // moduleNameMapper: { [regex]: path | [ ...paths ] }
          '$.moduleNameMapper.*@string()': tokenResolveMetadata, // string path
          '$.moduleNameMapper.*.*': tokenResolveMetadata, // array of paths
          // reporters: (path | [ path, options ])[]
          '$.reporters[?(@ !== "default")]*@string()': jestResolveMetadata, // string path, excluding "default"
          '$.reporters.*[?(@property == 0 && @ !== "default")]': jestResolveMetadata, // First entry in [ path, options ], excluding "default"
          // transform: { [regex]: path | [ path, options ] }
          '$.transform.*@string()': jestResolveMetadata, // string path
          '$.transform.*[?(@property == 0)]': jestResolveMetadata, // First entry in [ path, options ]
          // watchPlugins: (path | [ path, options ])[]
          '$.watchPlugins.*@string()': jestResolveMetadata, // string path
          '$.watchPlugins.*[?(@property == 0)]': jestResolveMetadata // First entry in [ path, options ]
        }
      });
    }

    return JestPlugin._jestConfigurationFileLoader;
  }

  private static _extractHeftJestReporters(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    config: IHeftJestConfiguration,
    projectRelativeFilePath: string
  ): JestReporterConfig[] {
    let isUsingHeftReporter: boolean = false;

    const logger: IScopedLogger = taskSession.logger;
    const terminal: ITerminal = logger.terminal;
    const reporterOptions: IHeftJestReporterOptions = {
      heftConfiguration,
      logger,
      debugMode: taskSession.parameters.debug
    };
    if (Array.isArray(config.reporters)) {
      // Harvest all the array indices that need to modified before altering the array
      const heftReporterIndices: number[] = JestPlugin._findIndexes(config.reporters, 'default');

      // Replace 'default' reporter with the heft reporter
      // This may clobber default reporters options
      if (heftReporterIndices.length > 0) {
        const heftReporter: Config.ReporterConfig = JestPlugin._getHeftJestReporterConfig(reporterOptions);
        for (const index of heftReporterIndices) {
          config.reporters[index] = heftReporter;
        }
        isUsingHeftReporter = true;
      }
    } else if (typeof config.reporters === 'undefined' || config.reporters === null) {
      // Otherwise if no reporters are specified install only the heft reporter
      config.reporters = [JestPlugin._getHeftJestReporterConfig(reporterOptions)];
      isUsingHeftReporter = true;
    } else {
      // Making a note if Heft cannot understand the reporter entry in Jest config
      // Not making this an error or warning because it does not warrant blocking a dev or CI test pass
      // If the Jest config is truly wrong Jest itself is in a better position to report what is wrong with the config
      terminal.writeVerboseLine(
        `The 'reporters' entry in Jest config '${projectRelativeFilePath}' is in an unexpected format. Was ` +
          'expecting an array of reporters'
      );
    }

    if (!isUsingHeftReporter) {
      terminal.writeVerboseLine(
        `HeftJestReporter was not specified in Jest config '${projectRelativeFilePath}'. Consider adding a ` +
          "'default' entry in the reporters array."
      );
    }

    // Since we're injecting the HeftConfiguration, we need to pass these args directly and not through serialization
    const reporters: JestReporterConfig[] = config.reporters;
    config.reporters = undefined;
    return reporters;
  }

  /**
   * Returns the reporter config using the HeftJestReporter and the provided options.
   */
  private static _getHeftJestReporterConfig(
    reporterOptions: IHeftJestReporterOptions
  ): Config.ReporterConfig {
    return [
      `${__dirname}/HeftJestReporter.js`,
      reporterOptions as Record<keyof IHeftJestReporterOptions, unknown>
    ];
  }

  /**
   * Resolve all specified properties to an absolute path using Jest resolution. In addition, the following
   * transforms will be applied to the provided propertyValue before resolution:
   *   - replace `<rootDir>` with the same rootDir
   *   - replace `<configDir>` with the directory containing the current configuration file
   *   - replace `<packageDir:...>` with the path to the resolved package (NOT module)
   */
  private static _getJsonPathMetadata(options: IJestResolutionOptions): IJsonPathMetadata {
    return {
      customResolver: (configurationFilePath: string, propertyName: string, propertyValue: string) => {
        const configDir: string = path.dirname(configurationFilePath);
        const parsedPropertyName: string | undefined = propertyName?.match(JSONPATHPROPERTY_REGEX)?.[1];

        function requireResolveFunction(request: string): string {
          return require.resolve(request, {
            paths: [configDir, PLUGIN_PACKAGE_FOLDER, JEST_CONFIG_PACKAGE_FOLDER]
          });
        }

        // Compare with replaceRootDirInPath() from here:
        // https://github.com/facebook/jest/blob/5f4dd187d89070d07617444186684c20d9213031/packages/jest-config/src/utils.ts#L58
        if (propertyValue.startsWith(ROOTDIR_TOKEN)) {
          // Example:  <rootDir>/path/to/file.js
          const restOfPath: string = path.normalize('./' + propertyValue.slice(ROOTDIR_TOKEN.length));
          propertyValue = path.resolve(options.rootDir, restOfPath);
        } else if (propertyValue.startsWith(CONFIGDIR_TOKEN)) {
          // Example:  <configDir>/path/to/file.js
          const restOfPath: string = path.normalize('./' + propertyValue.slice(CONFIGDIR_TOKEN.length));
          propertyValue = path.resolve(configDir, restOfPath);
        } else {
          // Example:  <packageDir:@my/package>/path/to/file.js
          const packageDirMatches: RegExpExecArray | null = PACKAGEDIR_REGEX.exec(propertyValue);
          if (packageDirMatches !== null) {
            const packageName: string | undefined = packageDirMatches.groups?.[PACKAGE_CAPTUREGROUP];
            if (!packageName) {
              throw new Error(
                `Could not parse package name from "packageDir" token ` +
                  (parsedPropertyName ? `of property "${parsedPropertyName}" ` : '') +
                  `in "${configDir}".`
              );
            }

            if (!PackageName.isValidName(packageName)) {
              throw new Error(
                `Module paths are not supported when using the "packageDir" token ` +
                  (parsedPropertyName ? `of property "${parsedPropertyName}" ` : '') +
                  `in "${configDir}". Only a package name is allowed.`
              );
            }

            // Resolve to the package directory (not the module referenced by the package). The normal resolution
            // method will generally not be able to find @rushstack/heft-jest-plugin from a project that is
            // using a rig. Since it is important, and it is our own package, we resolve it manually as a special
            // case.
            const resolvedPackagePath: string =
              packageName === PLUGIN_PACKAGE_NAME
                ? PLUGIN_PACKAGE_FOLDER
                : Import.resolvePackage({ baseFolderPath: configDir, packageName });
            // First entry is the entire match
            const restOfPath: string = path.normalize(
              './' + propertyValue.slice(packageDirMatches[0].length)
            );
            propertyValue = path.resolve(resolvedPackagePath, restOfPath);
          }
        }

        // Return early, since the remainder of this function is used to resolve module paths
        if (!options.resolveAsModule) {
          return propertyValue;
        }

        // Example:  @rushstack/heft-jest-plugin
        if (propertyValue === PLUGIN_PACKAGE_NAME) {
          return PLUGIN_PACKAGE_FOLDER;
        }

        // Example:  @rushstack/heft-jest-plugin/path/to/file.js
        if (propertyValue.startsWith(PLUGIN_PACKAGE_NAME)) {
          const restOfPath: string = path.normalize('./' + propertyValue.slice(PLUGIN_PACKAGE_NAME.length));
          return path.join(PLUGIN_PACKAGE_FOLDER, restOfPath);
        }

        // Use the Jest-provided resolvers to resolve the module paths
        switch (parsedPropertyName) {
          case 'testRunner':
            return resolveRunner(/*resolver:*/ undefined, {
              rootDir: configDir,
              filePath: propertyValue,
              requireResolveFunction
            });
          case 'testSequencer':
            return resolveSequencer(/*resolver:*/ undefined, {
              rootDir: configDir,
              filePath: propertyValue,
              requireResolveFunction
            });
          case 'testEnvironment':
            return resolveTestEnvironment({
              rootDir: configDir,
              testEnvironment: propertyValue,
              requireResolveFunction
            });
          case 'watchPlugins':
            return resolveWatchPlugin(/*resolver:*/ undefined, {
              rootDir: configDir,
              filePath: propertyValue,
              requireResolveFunction
            });
          default:
            // We know the value will be non-null since resolve will throw an error if it is null
            // and non-optional
            return jestResolve(/*resolver:*/ undefined, {
              rootDir: configDir,
              filePath: propertyValue,
              key: propertyName
            })!;
        }
      },
      pathResolutionMethod: PathResolutionMethod.custom
    };
  }

  /**
   * Finds the indices of jest reporters with a given name
   */
  private static _findIndexes(items: JestReporterConfig[], search: string): number[] {
    const result: number[] = [];

    for (let index: number = 0; index < items.length; index++) {
      const item: JestReporterConfig = items[index];

      // Item is either a string or a tuple of [reporterName: string, options: unknown]
      if (item === search) {
        result.push(index);
      } else if (typeof item !== 'undefined' && item !== null && item[0] === search) {
        result.push(index);
      }
    }

    return result;
  }
}
