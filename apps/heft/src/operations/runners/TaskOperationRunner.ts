// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { performance } from 'perf_hooks';
import glob from 'fast-glob';

import { AlreadyReportedError } from '@rushstack/node-core-library';

import { OperationStatus } from '../OperationStatus';
import { HeftTask } from '../../pluginFramework/HeftTask';
import {
  copyFilesAsync,
  copyIncrementalFilesAsync,
  type ICopyOperation,
  type IIncrementalCopyOperation
} from '../../plugins/CopyFilesPlugin';
import { deleteFilesAsync, type IDeleteOperation } from '../../plugins/DeleteFilesPlugin';
import type { IOperationRunner, IOperationRunnerContext } from '../IOperationRunner';
import type {
  HeftTaskSession,
  IChangedFileState,
  IHeftTaskRunHookOptions,
  IHeftTaskRunIncrementalHookOptions
} from '../../pluginFramework/HeftTaskSession';
import type { HeftPhaseSession } from '../../pluginFramework/HeftPhaseSession';
import type { InternalHeftSession } from '../../pluginFramework/InternalHeftSession';
import type { CancellationToken } from '../../pluginFramework/CancellationToken';
import type { GlobFn, IGlobOptions } from '../../plugins/FileGlobSpecifier';
import { StaticFileSystemAdapter } from '../../pluginFramework/StaticFileSystemAdapter';

export interface ITaskOperationRunnerOptions {
  internalHeftSession: InternalHeftSession;
  task: HeftTask;
  isFirstRun: boolean;
  cancellationToken: CancellationToken;
}

/**
 * Log out a start message, run a provided function, and log out an end message
 */
export async function runAndMeasureAsync<T = void>(
  fn: () => Promise<T>,
  startMessageFn: () => string,
  endMessageFn: () => string,
  logFn: (message: string) => void
): Promise<T> {
  logFn(startMessageFn());
  const startTime: number = performance.now();
  try {
    return await fn();
  } finally {
    const endTime: number = performance.now();
    logFn(`${endMessageFn()} (${endTime - startTime}ms)`);
  }
}

export class TaskOperationRunner implements IOperationRunner {
  private readonly _options: ITaskOperationRunnerOptions;

  public readonly silent: boolean = false;

  public get name(): string {
    const { taskName, parentPhase } = this._options.task;
    return `Task ${JSON.stringify(taskName)} of phase ${JSON.stringify(parentPhase.phaseName)}`;
  }

  public constructor(options: ITaskOperationRunnerOptions) {
    this._options = options;
  }

  public async executeAsync(context: IOperationRunnerContext): Promise<OperationStatus> {
    const { internalHeftSession, task } = this._options;
    const { parentPhase } = task;
    const phaseSession: HeftPhaseSession = internalHeftSession.getSessionForPhase(parentPhase);
    const taskSession: HeftTaskSession = phaseSession.getSessionForTask(task);
    return await this._executeTaskAsync(context, taskSession);
  }

  private async _executeTaskAsync(
    context: IOperationRunnerContext,
    taskSession: HeftTaskSession
  ): Promise<OperationStatus> {
    const { cancellationToken, isFirstRun } = this._options;

    const {
      hooks,
      logger: { terminal }
    } = taskSession;

    const { changedFiles } = context;

    // Store
    const localChanges: Map<string, IChangedFileState> = new Map();

    // Exit the task early if cancellation is requested
    if (cancellationToken.isCancelled) {
      return OperationStatus.Cancelled;
    }

    const shouldRunIncremental: boolean = taskSession.parameters.watch && hooks.runIncremental.isUsed();

    const shouldRun: boolean = hooks.run.isUsed() || shouldRunIncremental;
    if (!shouldRun) {
      terminal.writeVerboseLine('Task execution skipped, no implementation provided');
      return OperationStatus.NoOp;
    }

    const globChangedFilesAsync: GlobFn = createLazyGlobSourceFilesFn(changedFiles.keys());

    await runAndMeasureAsync(
      async () => {
        // Create the options and provide a utility method to obtain paths to copy
        const copyOperations: ICopyOperation[] = [];
        const incrementalCopyOperations: IIncrementalCopyOperation[] = [];
        const deleteOperations: IDeleteOperation[] = [];

        const runHookOptions: IHeftTaskRunHookOptions = {
          addCopyOperations: (copyOperationsToAdd: ICopyOperation[]) => {
            for (const copyOperation of copyOperationsToAdd) {
              copyOperations.push(copyOperation);
            }
          },
          addDeleteOperations: (deleteOperationsToAdd: IDeleteOperation[]) => {
            for (const deleteOperation of deleteOperationsToAdd) {
              deleteOperations.push(deleteOperation);
            }
          }
        };

        // Run the plugin run hook
        try {
          if (shouldRunIncremental) {
            const runIncrementalHookOptions: IHeftTaskRunIncrementalHookOptions = {
              ...runHookOptions,
              addCopyOperations: (incrementalCopyOperationsToAdd: IIncrementalCopyOperation[]) => {
                for (const incrementalCopyOperation of incrementalCopyOperationsToAdd) {
                  if (incrementalCopyOperation.onlyIfChanged) {
                    incrementalCopyOperations.push(incrementalCopyOperation);
                  } else {
                    copyOperations.push(incrementalCopyOperation);
                  }
                }
              },
              globChangedFilesAsync,
              changedFiles,
              cancellationToken: cancellationToken!,
              recordChangedFiles: (fileStates: Iterable<[string, IChangedFileState]>) => {
                for (const [filePath, state] of fileStates) {
                  localChanges.set(filePath, state);
                }
              }
            };
            await hooks.runIncremental.promise(runIncrementalHookOptions);
          } else {
            await hooks.run.promise(runHookOptions);
          }
        } catch (e) {
          // Log out using the task logger, and return an error status
          if (!(e instanceof AlreadyReportedError)) {
            taskSession.logger.emitError(e as Error);
          }
          return OperationStatus.Failure;
        }

        for (const [file, state] of localChanges) {
          changedFiles.set(file, state);
        }

        const fileOperationPromises: Promise<ReadonlyMap<string, IChangedFileState>>[] = [];

        // Copy the files if any were specified. Avoid checking the cancellation token here
        // since plugins may be tracking state changes and would have already considered
        // added copy operations as "processed" during hook execution.
        if (copyOperations.length) {
          fileOperationPromises.push(copyFilesAsync(copyOperations, taskSession.logger));
        }

        // Also incrementally copy files if any were specified. We know that globChangedFilesAsyncFn must
        // exist because incremental copy operations are only available in incremental mode.
        if (incrementalCopyOperations.length) {
          const globExistingChangedFilesFn: GlobFn = createLazyGlobSourceFilesFn(
            iterateExistingFiles(changedFiles)
          );

          fileOperationPromises.push(
            copyIncrementalFilesAsync(
              incrementalCopyOperations,
              globExistingChangedFilesFn,
              isFirstRun,
              taskSession.logger
            )
          );
        }

        // Delete the files if any were specified. Avoid checking the cancellation token here
        // for the same reasons as above.
        if (deleteOperations.length) {
          fileOperationPromises.push(deleteFilesAsync(deleteOperations, taskSession.logger.terminal));
        }

        if (fileOperationPromises.length) {
          const allResults: ReadonlyMap<string, IChangedFileState>[] = await Promise.all(
            fileOperationPromises
          );

          for (const map of allResults) {
            for (const [file, state] of map) {
              changedFiles.set(file, state);
            }
          }
        }
      },
      () => `Starting ${shouldRunIncremental ? 'incremental ' : ''}task execution`,
      () => {
        const finishedWord: string = cancellationToken.isCancelled ? 'Cancelled' : 'Finished';
        return `${finishedWord} ${shouldRunIncremental ? 'incremental ' : ''}task execution`;
      },
      terminal.writeVerboseLine.bind(terminal)
    );

    // Even if the entire process has completed, we should mark the operation as cancelled if
    // cancellation has been requested.
    return cancellationToken.isCancelled ? OperationStatus.Cancelled : OperationStatus.Success;
  }
}

function* iterateExistingFiles(sourceFiles: Iterable<[string, IChangedFileState]>): Iterable<string> {
  for (const [filePath, { version }] of sourceFiles) {
    if (version !== undefined) {
      yield filePath;
    }
  }
}

function createLazyGlobSourceFilesFn(sourceFiles: Iterable<string>): GlobFn {
  let globFn: GlobFn | undefined;
  return (outerPattern: string | string[], outerOptions?: IGlobOptions) => {
    if (!globFn) {
      const staticFileSystemAdapter: StaticFileSystemAdapter = new StaticFileSystemAdapter(sourceFiles);

      globFn = (pattern: string | string[], options?: IGlobOptions) => {
        return Promise.resolve(
          glob.sync(pattern, {
            fs: staticFileSystemAdapter,
            cwd: options?.cwd,
            absolute: options?.absolute,
            ignore: options?.ignore,
            dot: options?.dot
          })
        );
      };
    }

    return globFn(outerPattern, outerOptions);
  };
}
