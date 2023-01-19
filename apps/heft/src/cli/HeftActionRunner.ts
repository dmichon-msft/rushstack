// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { performance } from 'perf_hooks';
import { createInterface, type Interface } from 'readline';
import {
  AlreadyReportedError,
  Colors,
  ConsoleTerminalProvider,
  InternalError,
  Path,
  type ITerminal,
  type IPackageJson
} from '@rushstack/node-core-library';
import type {
  CommandLineFlagParameter,
  CommandLineParameterProvider,
  CommandLineStringListParameter
} from '@rushstack/ts-command-line';
import ignore, { Ignore } from 'ignore';

import type { IHeftSessionWatchOptions, InternalHeftSession } from '../pluginFramework/InternalHeftSession';
import type { HeftConfiguration } from '../configuration/HeftConfiguration';
import type { LoggingManager } from '../pluginFramework/logging/LoggingManager';
import type { MetricsCollector } from '../metrics/MetricsCollector';
import { GitUtilities, type GitignoreFilterFn } from '../utilities/GitUtilities';
import { HeftParameterManager } from '../pluginFramework/HeftParameterManager';
import {
  OperationExecutionManager,
  type IOperationExecutionManagerOptions
} from '../operations/OperationExecutionManager';
import { Operation } from '../operations/Operation';
import { TaskOperationRunner, runAndMeasureAsync } from '../operations/runners/TaskOperationRunner';
import { PhaseOperationRunner } from '../operations/runners/PhaseOperationRunner';
import { LifecycleOperationRunner } from '../operations/runners/LifecycleOperationRunner';
import type { HeftPhase } from '../pluginFramework/HeftPhase';
import type { IHeftAction, IHeftActionOptions } from '../cli/actions/IHeftAction';
import type { HeftTask } from '../pluginFramework/HeftTask';
import type { LifecycleOperationRunnerType } from '../operations/runners/LifecycleOperationRunner';
import type { IChangedFileState } from '../pluginFramework/HeftTaskSession';
import { CancellationToken, CancellationTokenSource } from '../pluginFramework/CancellationToken';
import { Constants } from '../utilities/Constants';
import { ITimeData, watchForChangesAsync } from '../utilities/DirectoryWatcher';

export interface IHeftActionRunnerOptions extends IHeftActionOptions {
  action: IHeftAction;
}

export function initializeHeft(
  heftConfiguration: HeftConfiguration,
  terminal: ITerminal,
  isVerbose: boolean
): void {
  // Ensure that verbose is enabled on the terminal if requested. terminalProvider.verboseEnabled
  // should already be `true` if the `--debug` flag was provided. This is set in HeftCommandLineParser
  if (heftConfiguration.terminalProvider instanceof ConsoleTerminalProvider) {
    heftConfiguration.terminalProvider.verboseEnabled =
      heftConfiguration.terminalProvider.verboseEnabled || isVerbose;
  }

  // Log some information about the execution
  const projectPackageJson: IPackageJson = heftConfiguration.projectPackageJson;
  terminal.writeVerboseLine(`Project: ${projectPackageJson.name}@${projectPackageJson.version}`);
  terminal.writeVerboseLine(`Project build folder: ${heftConfiguration.buildFolderPath}`);
  if (heftConfiguration.rigConfig.rigFound) {
    terminal.writeVerboseLine(`Rig package: ${heftConfiguration.rigConfig.rigPackageName}`);
    terminal.writeVerboseLine(`Rig profile: ${heftConfiguration.rigConfig.rigProfile}`);
  }
  terminal.writeVerboseLine(`Heft version: ${heftConfiguration.heftPackageJson.version}`);
  terminal.writeVerboseLine(`Node version: ${process.version}`);
  terminal.writeVerboseLine('');
}

export async function runWithLoggingAsync(
  fn: () => Promise<void>,
  action: IHeftAction,
  loggingManager: LoggingManager,
  terminal: ITerminal,
  metricsCollector: MetricsCollector,
  cancellationToken: CancellationToken
): Promise<void> {
  const startTime: number = performance.now();
  loggingManager.resetScopedLoggerErrorsAndWarnings();

  // Execute the action operations
  let encounteredError: boolean = false;
  try {
    await fn();
  } catch (e) {
    encounteredError = true;
    throw e;
  } finally {
    const warningStrings: string[] = loggingManager.getWarningStrings();
    const errorStrings: string[] = loggingManager.getErrorStrings();

    const wasCancelled: boolean = cancellationToken.isCancelled;
    const encounteredWarnings: boolean = warningStrings.length > 0 || wasCancelled;
    encounteredError = encounteredError || errorStrings.length > 0;

    await metricsCollector.recordAsync(
      action.actionName,
      {
        encounteredError
      },
      action.getParameterStringMap()
    );

    const finishedLoggingWord: string = encounteredError ? 'Failed' : wasCancelled ? 'Cancelled' : 'Finished';
    const duration: number = performance.now() - startTime;
    const durationSeconds: number = Math.round(duration) / 1000;
    const finishedLoggingLine: string = `-------------------- ${finishedLoggingWord} (${durationSeconds}s) --------------------`;
    terminal.writeLine(
      Colors.bold(
        (encounteredError ? Colors.red : encounteredWarnings ? Colors.yellow : Colors.green)(
          finishedLoggingLine
        )
      )
    );

    if (warningStrings.length > 0) {
      terminal.writeWarningLine(
        `Encountered ${warningStrings.length} warning${warningStrings.length === 1 ? '' : 's'}`
      );
      for (const warningString of warningStrings) {
        terminal.writeWarningLine(`  ${warningString}`);
      }
    }

    if (errorStrings.length > 0) {
      terminal.writeErrorLine(
        `Encountered ${errorStrings.length} error${errorStrings.length === 1 ? '' : 's'}`
      );
      for (const errorString of errorStrings) {
        terminal.writeErrorLine(`  ${errorString}`);
      }
    }
  }

  if (encounteredError) {
    throw new AlreadyReportedError();
  }
}

export class HeftActionRunner {
  private readonly _action: IHeftAction;
  private readonly _terminal: ITerminal;
  private readonly _internalHeftSession: InternalHeftSession;
  private readonly _metricsCollector: MetricsCollector;
  private readonly _loggingManager: LoggingManager;
  private readonly _heftConfiguration: HeftConfiguration;
  private _parameterManager: HeftParameterManager | undefined;

  public constructor(options: IHeftActionRunnerOptions) {
    this._action = options.action;
    this._internalHeftSession = options.internalHeftSession;
    this._heftConfiguration = options.heftConfiguration;
    this._loggingManager = options.loggingManager;
    this._terminal = options.terminal;
    this._metricsCollector = options.metricsCollector;

    this._metricsCollector.setStartTime();
  }

  protected get parameterManager(): HeftParameterManager {
    if (!this._parameterManager) {
      throw new InternalError(`HeftActionRunner.defineParameters() has not been called.`);
    }
    return this._parameterManager;
  }

  public defineParameters(parameterProvider?: CommandLineParameterProvider | undefined): void {
    if (!this._parameterManager) {
      // Use the provided parameter provider if one was provided. This is used by the RunAction
      // to allow for the Heft plugin parameters to be applied as scoped parameters.
      parameterProvider = parameterProvider || this._action;
    } else {
      throw new InternalError(`HeftActionParameters.defineParameters() has already been called.`);
    }

    const verboseFlag: CommandLineFlagParameter = parameterProvider.defineFlagParameter({
      parameterLongName: Constants.verboseParameterLongName,
      parameterShortName: Constants.verboseParameterShortName,
      description: 'If specified, log information useful for debugging.'
    });
    const productionFlag: CommandLineFlagParameter = parameterProvider.defineFlagParameter({
      parameterLongName: Constants.productionParameterLongName,
      description: 'If specified, run Heft in production mode.'
    });
    const localesParameter: CommandLineStringListParameter = parameterProvider.defineStringListParameter({
      parameterLongName: Constants.localesParameterLongName,
      argumentName: 'LOCALE',
      description: 'Use the specified locale for this run, if applicable.'
    });

    let cleanFlag: CommandLineFlagParameter | undefined;
    let cleanCacheFlag: CommandLineFlagParameter | undefined;
    if (!this._action.watch) {
      // Only enable the clean flags in non-watch mode
      cleanFlag = parameterProvider.defineFlagParameter({
        parameterLongName: Constants.cleanParameterLongName,
        description: 'If specified, clean the outputs before running each phase.'
      });
      cleanCacheFlag = parameterProvider.defineFlagParameter({
        parameterLongName: Constants.cleanCacheParameterLongName,
        description:
          'If specified, clean the cache before running each phase. To use this flag, the ' +
          `${JSON.stringify(Constants.cleanParameterLongName)} flag must also be provided.`
      });
    }

    const parameterManager: HeftParameterManager = new HeftParameterManager({
      getIsDebug: () => this._internalHeftSession.debug,
      getIsVerbose: () => verboseFlag.value,
      getIsProduction: () => productionFlag.value,
      getIsWatch: () => this._action.watch,
      getLocales: () => localesParameter.values,
      getIsClean: () => !!cleanFlag?.value,
      getIsCleanCache: () => !!cleanCacheFlag?.value
    });

    // Add all the lifecycle parameters for the action
    for (const lifecyclePluginDefinition of this._internalHeftSession.lifecycle.pluginDefinitions) {
      parameterManager.addPluginParameters(lifecyclePluginDefinition);
    }

    // Add all the task parameters for the action
    for (const phase of this._action.selectedPhases) {
      for (const task of phase.tasks) {
        parameterManager.addPluginParameters(task.pluginDefinition);
      }
    }

    // Finalize and apply to the CommandLineParameterProvider
    parameterManager.finalizeParameters(parameterProvider);
    this._parameterManager = parameterManager;
  }

  public async executeAsync(): Promise<void> {
    // Set the parameter manager on the internal session, which is used to provide the selected
    // parameters to plugins. Set this in onExecute() since we now know that this action is being
    // executed, and the session should be populated with the executing parameters.
    this._internalHeftSession.parameterManager = this.parameterManager;

    initializeHeft(this._heftConfiguration, this._terminal, this.parameterManager.defaultParameters.verbose);

    if (this._action.watch) {
      await this._executeWatchAsync();
    } else {
      await this._executeOnceAsync();
    }
  }

  private async _executeWatchAsync(): Promise<void> {
    const terminal: ITerminal = this._terminal;
    const watcherCwd: string = this._heftConfiguration.buildFolderPath;

    const cli: Interface = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    const cliCancellationTokenSource: CancellationTokenSource = new CancellationTokenSource();
    const cliCancellationToken: CancellationToken = cliCancellationTokenSource.token;

    let forceShutdown: boolean = false;
    cli.on('SIGINT', () => {
      if (forceShutdown) {
        process.exit(1);
      }
      forceShutdown = true;
      cliCancellationTokenSource.cancel();
      terminal.writeWarningLine(`SIGINT detected. Shutting down.`);
    });

    const git: GitUtilities = new GitUtilities(this._heftConfiguration.buildFolderPath);

    // Create a gitignore filter to test if a file is ignored by git. If it is, it will be counted
    // as a non-source file. If it is not, it will be counted as a source file. If git is not present,
    // all files will be counted as source files and must manually be ignored by providing a glob to
    // the ignoredSourceFileGlobs option.
    const isFileTracked: GitignoreFilterFn = (await git.tryCreateGitignoreFilterAsync()) || (() => true);

    const additionalIgnore: Ignore = ignore();
    additionalIgnore.add('node_modules');
    for (const ignoreGlob of this._internalHeftSession.watchOptions.ignoredSourceFileGlobs) {
      additionalIgnore.add(ignoreGlob);
    }
    const normalizedCwd: string = Path.convertToSlashes(watcherCwd);
    const additionalIgnoreFn: (filePath: string) => boolean = additionalIgnore.createFilter();

    const filter: (filePath: string) => boolean = (filePath: string) => {
      if (!isFileTracked(filePath)) {
        return false;
      }

      const relativePath: string = filePath.slice(normalizedCwd.length + 1);

      return additionalIgnoreFn(relativePath);
    };

    terminal.writeLine(`Starting watcher at path "${normalizedCwd}"`);
    const watcher: AsyncIterableIterator<ITimeData> = watchForChangesAsync({
      rootPath: normalizedCwd,
      cancellationToken: cliCancellationToken,
      debounceTimeoutMs: 250,
      filter
    });

    const initialResult: IteratorResult<ITimeData> = await watcher.next();
    if (initialResult.done) {
      return;
    }

    let lastExecutedState: ITimeData = initialResult.value;
    let currentState: ITimeData = initialResult.value;

    terminal.writeDebugLine(`Initial state obtained.`);

    let isFirstRun: boolean = true;

    // eslint-disable-next-line no-constant-condition
    while (!cliCancellationToken.isCancelled) {
      // Create the cancellation token which is passed to the incremental build.
      const cancellationTokenSource: CancellationTokenSource = new CancellationTokenSource();
      const cancellationToken: CancellationToken = cancellationTokenSource.token;

      cliCancellationToken.onCancelledPromise.then(
        () => {
          // Cancel the build if requested via CLI
          cancellationTokenSource.cancel();
        },
        () => {
          // Cancel the build if requested via CLI
          cancellationTokenSource.cancel();
        }
      );

      // Start the incremental build and wait for a source file to change
      const sourceChangesPromise: Promise<IteratorResult<ITimeData>> = watcher.next();
      const executePromise: Promise<void> = this._executeOnceAsync(
        isFirstRun,
        cancellationToken,
        currentState
      );
      lastExecutedState = currentState;

      try {
        // Whichever promise settles first will be the result of the race.
        const isSourceChange: IteratorResult<ITimeData> | void = await Promise.race([
          sourceChangesPromise,
          executePromise
        ]);
        if (isSourceChange) {
          // If there's a source file change, we need to cancel the incremental build and wait for the
          // execution to finish before we begin execution again.
          cancellationTokenSource.cancel();
          currentState = isSourceChange.value;
          this._terminal.writeLine(
            Colors.bold('Changes detected, cancelling and restarting incremental build...')
          );
          await executePromise;
        } else if (cliCancellationToken.isCancelled) {
          this._terminal.writeLine(Colors.bold('Shutting down...'));
          break;
        } else {
          // Mark the first run as completed, to ensure that copy incremental copy operations are now
          // enabled.
          isFirstRun = false;
          this._terminal.writeLine(Colors.bold('Waiting for changes. Press CTRL + C to exit...'));
          this._terminal.writeLine('');
          const result: IteratorResult<ITimeData> = await sourceChangesPromise;
          if (result.done) {
            return;
          }
          currentState = result.value;
        }
      } catch (e) {
        // Swallow AlreadyReportedErrors, since we likely have already logged them out to the terminal.
        // We also need to wait for source file changes here so that we don't continuously loop after
        // encountering an error.
        if (e instanceof AlreadyReportedError) {
          this._terminal.writeLine(Colors.bold('Waiting for changes. Press CTRL + C to exit...'));
          this._terminal.writeLine('');
          const result: IteratorResult<ITimeData> = await sourceChangesPromise;
          if (result.done) {
            return;
          }
          currentState = result.value;
        } else {
          // We don't know where this error is coming from, throw
          throw e;
        }
      }

      if (!cliCancellationToken.isCancelled) {
        // Write an empty line to the terminal for separation between iterations. We've already iterated
        // at this point, so log out that we're about to start a new run.
        this._terminal.writeLine('');
        this._terminal.writeLine(Colors.bold('Starting incremental build...'));
      }
    }
  }

  private async _executeOnceAsync(
    isFirstRun: boolean = true,
    cancellationToken?: CancellationToken,
    changedFiles?: ITimeData
  ): Promise<void> {
    cancellationToken = cancellationToken || new CancellationToken();
    const operations: Set<Operation> = this._generateOperations(isFirstRun, cancellationToken);
    const operationExecutionManagerOptions: IOperationExecutionManagerOptions = {
      loggingManager: this._loggingManager,
      terminal: this._terminal,
      // TODO: Allow for running non-parallelized operations.
      parallelism: undefined,
      fsObjectVersions: changedFiles
    };
    const executionManager: OperationExecutionManager = new OperationExecutionManager(
      operations,
      operationExecutionManagerOptions
    );

    // Execute the action operations
    await runWithLoggingAsync(
      executionManager.executeAsync.bind(executionManager),
      this._action,
      this._loggingManager,
      this._terminal,
      this._metricsCollector,
      cancellationToken
    );
  }

  private _generateOperations(isFirstRun: boolean, cancellationToken: CancellationToken): Set<Operation> {
    const { selectedPhases } = this._action;
    const {
      defaultParameters: { clean, cleanCache }
    } = this.parameterManager;

    if (cleanCache && !clean) {
      throw new Error(
        `The ${JSON.stringify(Constants.cleanCacheParameterLongName)} option can only be used in ` +
          `conjunction with ${JSON.stringify(Constants.cleanParameterLongName)}.`
      );
    }

    const operations: Map<string, Operation> = new Map();
    const startLifecycleOperation: Operation = this._getOrCreateLifecycleOperation('start', operations);
    const finishLifecycleOperation: Operation = this._getOrCreateLifecycleOperation('finish', operations);

    let hasWarnedAboutSkippedPhases: boolean = false;
    for (const phase of selectedPhases) {
      // Warn if any dependencies are excluded from the list of selected phases
      if (!hasWarnedAboutSkippedPhases) {
        for (const dependencyPhase of phase.dependencyPhases) {
          if (!selectedPhases.has(dependencyPhase)) {
            // Only write once, and write with yellow to make it stand out without writing a warning to stderr
            hasWarnedAboutSkippedPhases = true;
            this._terminal.writeLine(
              Colors.bold(
                'The provided list of phases does not contain all phase dependencies. You may need to run the ' +
                  'excluded phases manually.'
              )
            );
            break;
          }
        }
      }

      // Create operation for the phase start node
      const phaseOperation: Operation = this._getOrCreatePhaseOperation(phase, operations);
      // Set the 'start' lifecycle operation as a dependency of all phases to ensure the 'start' lifecycle
      // operation runs first
      phaseOperation.dependencies.add(startLifecycleOperation);
      // Set the phase operation as a dependency of the 'end' lifecycle operation to ensure the phase
      // operation runs first
      finishLifecycleOperation.dependencies.add(phaseOperation);

      // Create operations for each task
      for (const task of phase.tasks) {
        const taskOperation: Operation = this._getOrCreateTaskOperation(
          task,
          operations,
          isFirstRun,
          cancellationToken
        );
        // Set the phase operation as a dependency of the task operation to ensure the phase operation runs first
        taskOperation.dependencies.add(phaseOperation);
        // Set the 'start' lifecycle operation as a dependency of all tasks to ensure the 'start' lifecycle
        // operation runs first
        taskOperation.dependencies.add(startLifecycleOperation);
        // Set the task operation as a dependency of the 'stop' lifecycle operation to ensure the task operation
        // runs first
        finishLifecycleOperation.dependencies.add(taskOperation);

        // Set all dependency tasks as dependencies of the task operation
        for (const dependencyTask of task.dependencyTasks) {
          taskOperation.dependencies.add(
            this._getOrCreateTaskOperation(dependencyTask, operations, isFirstRun, cancellationToken)
          );
        }

        // Set all tasks in a in a phase as dependencies of the consuming phase
        for (const consumingPhase of phase.consumingPhases) {
          if (this._action.selectedPhases.has(consumingPhase)) {
            // Set all tasks in a dependency phase as dependencies of the consuming phase to ensure the dependency
            // tasks run first
            const consumingPhaseOperation: Operation = this._getOrCreatePhaseOperation(
              consumingPhase,
              operations
            );
            consumingPhaseOperation.dependencies.add(taskOperation);
          }
        }
      }
    }

    return new Set(operations.values());
  }

  private _getOrCreateLifecycleOperation(
    type: LifecycleOperationRunnerType,
    operations: Map<string, Operation>
  ): Operation {
    const key: string = `lifecycle.${type}`;

    let operation: Operation | undefined = operations.get(key);
    if (!operation) {
      operation = new Operation({
        groupName: 'lifecycle',
        runner: new LifecycleOperationRunner({ type, internalHeftSession: this._internalHeftSession })
      });
      operations.set(key, operation);
    }
    return operation;
  }

  private _getOrCreatePhaseOperation(phase: HeftPhase, operations: Map<string, Operation>): Operation {
    const key: string = phase.phaseName;

    let operation: Operation | undefined = operations.get(key);
    if (!operation) {
      // Only create the operation. Dependencies are hooked up separately
      operation = new Operation({
        groupName: phase.phaseName,
        runner: new PhaseOperationRunner({ phase, internalHeftSession: this._internalHeftSession })
      });
      operations.set(key, operation);
    }
    return operation;
  }

  private _getOrCreateTaskOperation(
    task: HeftTask,
    operations: Map<string, Operation>,
    isFirstRun: boolean,
    cancellationToken: CancellationToken,
    changedFiles?: Map<string, IChangedFileState>
  ): Operation {
    const key: string = `${task.parentPhase.phaseName}.${task.taskName}`;

    let operation: Operation | undefined = operations.get(key);
    if (!operation) {
      operation = new Operation({
        groupName: task.parentPhase.phaseName,
        runner: new TaskOperationRunner({
          internalHeftSession: this._internalHeftSession,
          task,
          isFirstRun,
          cancellationToken
        })
      });
      operations.set(key, operation);
    }
    return operation;
  }
}
