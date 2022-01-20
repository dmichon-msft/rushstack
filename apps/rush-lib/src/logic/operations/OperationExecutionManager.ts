// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import colors from 'colors/safe';
import {
  StdioSummarizer,
  TerminalWritable,
  StdioWritable,
  TerminalChunkKind,
  TextRewriterTransform
} from '@rushstack/terminal';
import { StreamCollator, CollatedTerminal, CollatedWriter } from '@rushstack/stream-collator';
import { AlreadyReportedError, NewlineKind, InternalError, Sort } from '@rushstack/node-core-library';

import { Stopwatch } from '../../utilities/Stopwatch';
import { AsyncOperationQueue, IOperationSortFunction } from './AsyncOperationQueue';
import { Operation } from './Operation';
import { OperationStatus } from './OperationStatus';
import { IOperationRunnerContext } from './IOperationRunner';
import { CommandLineConfiguration } from '../../api/CommandLineConfiguration';
import { OperationError } from './OperationError';

export interface ITaskExecutionManagerOptions {
  quietMode: boolean;
  debugMode: boolean;
  parallelism: string | undefined;
  changedProjectsOnly: boolean;
  repoCommandLineConfiguration: CommandLineConfiguration;
  destination?: TerminalWritable;
}

/**
 * Format "======" lines for a shell window with classic 80 columns
 */
const ASCII_HEADER_WIDTH: number = 79;

/**
 * A class which manages the execution of a set of Operations with interdependencies.
 * Initially, and at the end of each Operation execution, all unblocked Operations
 * are added to a ready queue which is then executed. This is done continually until all
 * Operations are complete, or prematurely fails if any of the Operations fail.
 */
export class OperationExecutionManager {
  private readonly _operations: Set<Operation>;
  private readonly _changedProjectsOnly: boolean;
  private readonly _quietMode: boolean;
  private readonly _debugMode: boolean;
  private readonly _parallelism: number;
  private readonly _repoCommandLineConfiguration: CommandLineConfiguration;
  private readonly _totalOperations: number;

  private readonly _outputWritable: TerminalWritable;
  private readonly _colorsNewlinesTransform: TextRewriterTransform;
  private readonly _streamCollator: StreamCollator;

  private readonly _terminal: CollatedTerminal;

  // Variables for current status
  private _hasAnyFailures: boolean;
  private _hasAnyNonAllowedWarnings: boolean;
  private _completedOperations: number;

  public constructor(operations: Set<Operation>, options: ITaskExecutionManagerOptions) {
    const { quietMode, debugMode, parallelism, changedProjectsOnly, repoCommandLineConfiguration } = options;
    this._operations = operations;
    this._completedOperations = 0;
    this._totalOperations = operations.size;
    this._quietMode = quietMode;
    this._debugMode = debugMode;
    this._hasAnyFailures = false;
    this._hasAnyNonAllowedWarnings = false;
    this._changedProjectsOnly = changedProjectsOnly;
    this._repoCommandLineConfiguration = repoCommandLineConfiguration;

    // TERMINAL PIPELINE:
    //
    // streamCollator --> colorsNewlinesTransform --> StdioWritable
    //
    this._outputWritable = options.destination ? options.destination : StdioWritable.instance;
    this._colorsNewlinesTransform = new TextRewriterTransform({
      destination: this._outputWritable,
      normalizeNewlines: NewlineKind.OsDefault,
      removeColors: !colors.enabled
    });
    this._streamCollator = new StreamCollator({
      destination: this._colorsNewlinesTransform,
      onWriterActive: this._streamCollator_onWriterActive
    });
    this._terminal = this._streamCollator.terminal;

    const numberOfCores: number = os.cpus().length;

    if (parallelism) {
      if (parallelism === 'max') {
        this._parallelism = numberOfCores;
      } else {
        const parallelismInt: number = parseInt(parallelism, 10);

        if (isNaN(parallelismInt)) {
          throw new Error(`Invalid parallelism value of '${parallelism}', expected a number or 'max'`);
        }

        this._parallelism = parallelismInt;
      }
    } else {
      // If an explicit parallelism number wasn't provided, then choose a sensible
      // default.
      if (os.platform() === 'win32') {
        // On desktop Windows, some people have complained that their system becomes
        // sluggish if Rush is using all the CPU cores.  Leave one thread for
        // other operations. For CI environments, you can use the "max" argument to use all available cores.
        this._parallelism = Math.max(numberOfCores - 1, 1);
      } else {
        // Unix-like operating systems have more balanced scheduling, so default
        // to the number of CPU cores
        this._parallelism = numberOfCores;
      }
    }
  }

  private _streamCollator_onWriterActive = (writer: CollatedWriter | undefined): void => {
    if (writer) {
      this._completedOperations++;

      // Format a header like this
      //
      // ==[ @rushstack/the-long-thing ]=================[ 1 of 1000 ]==

      // leftPart: "==[ @rushstack/the-long-thing "
      const leftPart: string = colors.gray('==[') + ' ' + colors.cyan(writer.taskName) + ' ';
      const leftPartLength: number = 4 + writer.taskName.length + 1;

      // rightPart: " 1 of 1000 ]=="
      const completedOfTotal: string = `${this._completedOperations} of ${this._totalOperations}`;
      const rightPart: string = ' ' + colors.white(completedOfTotal) + ' ' + colors.gray(']==');
      const rightPartLength: number = 1 + completedOfTotal.length + 4;

      // middlePart: "]=================["
      const twoBracketsLength: number = 2;
      const middlePartLengthMinusTwoBrackets: number = Math.max(
        ASCII_HEADER_WIDTH - (leftPartLength + rightPartLength + twoBracketsLength),
        0
      );

      const middlePart: string = colors.gray(']' + '='.repeat(middlePartLengthMinusTwoBrackets) + '[');

      this._terminal.writeStdoutLine('\n' + leftPart + middlePart + rightPart);

      if (!this._quietMode) {
        this._terminal.writeStdoutLine('');
      }
    }
  };

  /**
   * Executes all tasks which have been registered, returning a promise which is resolved when all the
   * tasks are completed successfully, or rejects when any operation fails.
   */
  public async executeAsync(): Promise<void> {
    this._completedOperations = 0;
    const totalTasks: number = this._totalOperations;

    if (!this._quietMode) {
      const plural: string = totalTasks === 1 ? '' : 's';
      this._terminal.writeStdoutLine(`Selected ${totalTasks} project${plural}:`);
      this._terminal.writeStdoutLine(
        Array.from(this._operations, (x) => `  ${x.name}`)
          .sort()
          .join('\n')
      );
      this._terminal.writeStdoutLine('');
    }

    this._terminal.writeStdoutLine(`Executing a maximum of ${this._parallelism} simultaneous processes...`);

    const maxParallelism: number = Math.min(totalTasks, this._parallelism);
    const prioritySort: IOperationSortFunction = (a: Operation, b: Operation): number => {
      let diff: number = a.criticalPathLength! - b.criticalPathLength!;
      if (diff) {
        return diff;
      }

      diff = a.dependents.size - b.dependents.size;
      if (diff) {
        return diff;
      }

      // No further default considerations.
      return 0;
    };
    const taskQueue: AsyncOperationQueue = new AsyncOperationQueue(this._operations, prioritySort);

    // Iterate in parallel with maxParallelism concurrent lanes
    await Promise.all(
      Array.from({ length: maxParallelism }, async (unused: undefined, index: number): Promise<void> => {
        // laneId can be used in logging to examine concurrency
        const laneId: number = index + 1;
        // The taskQueue is a singular async iterable that stalls until an operation is available, and marks itself
        // done when the queue is empty.
        for await (const operation of taskQueue) {
          // Take an operation, execute it, wait for it to finish, wait for a new operation
          await this._executeOperationAsync(operation, laneId);
        }
      })
    );

    this._printOperationStatus();

    if (this._hasAnyFailures) {
      this._terminal.writeStderrLine(colors.red('Projects failed to build.') + '\n');
      throw new AlreadyReportedError();
    } else if (this._hasAnyNonAllowedWarnings) {
      this._terminal.writeStderrLine(colors.yellow('Projects succeeded with warnings.') + '\n');
      throw new AlreadyReportedError();
    }
  }

  private async _executeOperationAsync(operation: Operation, tid: number): Promise<void> {
    operation.status = OperationStatus.Executing;
    operation.stopwatch = Stopwatch.start();
    operation.collatedWriter = this._streamCollator.registerTask(operation.name);
    operation.stdioSummarizer = new StdioSummarizer();

    const context: IOperationRunnerContext = {
      repoCommandLineConfiguration: this._repoCommandLineConfiguration,
      stdioSummarizer: operation.stdioSummarizer,
      collatedWriter: operation.collatedWriter,
      quietMode: this._quietMode,
      debugMode: this._debugMode
    };

    try {
      const result: OperationStatus = await operation.runner.executeAsync(context);

      operation.stopwatch.stop();
      operation.stdioSummarizer.close();

      switch (result) {
        case OperationStatus.Success:
          this._markTaskAsSuccess(operation);
          break;
        case OperationStatus.SuccessWithWarning:
          this._hasAnyNonAllowedWarnings =
            this._hasAnyNonAllowedWarnings || !operation.runner.warningsAreAllowed;
          this._markTaskAsSuccessWithWarning(operation);
          break;
        case OperationStatus.FromCache:
          this._markTaskAsFromCache(operation);
          break;
        case OperationStatus.Skipped:
          this._markTaskAsSkipped(operation);
          break;
        case OperationStatus.Failure:
          this._hasAnyFailures = true;
          this._markTaskAsFailed(operation);
          break;
      }
    } catch (error) {
      operation.stdioSummarizer.close();

      this._hasAnyFailures = true;

      // eslint-disable-next-line require-atomic-updates
      operation.error = error as OperationError;

      this._markTaskAsFailed(operation);
    }

    operation.collatedWriter.close();
  }

  /**
   * Marks an operation as having failed and marks each of its dependents as blocked
   */
  private _markTaskAsFailed(operation: Operation): void {
    if (operation.error) {
      operation.collatedWriter.terminal.writeStderrLine(operation.error.message);
    }
    operation.collatedWriter.terminal.writeStderrLine(colors.red(`"${operation.name}" failed to build.`));
    operation.status = OperationStatus.Failure;
    operation.dependents.forEach((dependent: Operation) => {
      this._markTaskAsBlocked(dependent, operation);
    });
  }

  /**
   * Marks an operation and all its dependents as blocked
   */
  private _markTaskAsBlocked(blockedTask: Operation, failedTask: Operation): void {
    if (blockedTask.status === OperationStatus.Ready) {
      this._completedOperations++;

      // Note: We cannot write to operation.collatedWriter because "blockedTask" will be skipped
      failedTask.collatedWriter.terminal.writeStdoutLine(
        `"${blockedTask.name}" is blocked by "${failedTask.name}".`
      );
      blockedTask.status = OperationStatus.Blocked;
      blockedTask.dependents.forEach((dependent: Operation) => {
        this._markTaskAsBlocked(dependent, failedTask);
      });
    }
  }

  /**
   * Marks an operation as being completed, and removes it from the dependencies list of all its dependents
   */
  private _markTaskAsSuccess(operation: Operation): void {
    if (operation.runner.hadEmptyScript) {
      operation.collatedWriter.terminal.writeStdoutLine(
        colors.green(`"${operation.name}" had an empty script.`)
      );
    } else {
      operation.collatedWriter.terminal.writeStdoutLine(
        colors.green(`"${operation.name}" completed successfully in ${operation.stopwatch.toString()}.`)
      );
    }
    operation.status = OperationStatus.Success;

    operation.dependents.forEach((dependent: Operation) => {
      if (!this._changedProjectsOnly) {
        dependent.runner.isSkipAllowed = false;
      }
      dependent.dependencies.delete(operation);
    });
  }

  /**
   * Marks an operation as being completed, but with warnings written to stderr, and removes it from the dependencies
   * list of all its dependents
   */
  private _markTaskAsSuccessWithWarning(operation: Operation): void {
    operation.collatedWriter.terminal.writeStderrLine(
      colors.yellow(`"${operation.name}" completed with warnings in ${operation.stopwatch.toString()}.`)
    );
    operation.status = OperationStatus.SuccessWithWarning;
    operation.dependents.forEach((dependent: Operation) => {
      if (!this._changedProjectsOnly) {
        dependent.runner.isSkipAllowed = false;
      }
      dependent.dependencies.delete(operation);
    });
  }

  /**
   * Marks an operation as skipped.
   */
  private _markTaskAsSkipped(operation: Operation): void {
    operation.collatedWriter.terminal.writeStdoutLine(colors.green(`${operation.name} was skipped.`));
    operation.status = OperationStatus.Skipped;
    operation.dependents.forEach((dependent: Operation) => {
      dependent.dependencies.delete(operation);
    });

    const invalidationQueue: Set<Operation> = new Set(operation.dependents);
    for (const consumer of invalidationQueue) {
      // If an operation is skipped, state is not guaranteed in downstream tasks, so block cache write
      consumer.runner.isCacheWriteAllowed = false;

      // Propagate through the entire build queue applying cache write prevention.
      for (const indirectConsumer of consumer.dependents) {
        invalidationQueue.add(indirectConsumer);
      }
    }
  }

  /**
   * Marks an operation as provided by cache.
   */
  private _markTaskAsFromCache(operation: Operation): void {
    operation.collatedWriter.terminal.writeStdoutLine(
      colors.green(`${operation.name} was restored from the build cache.`)
    );
    operation.status = OperationStatus.FromCache;
    operation.dependents.forEach((dependent: Operation) => {
      dependent.dependencies.delete(operation);
    });
  }

  /**
   * Prints out a report of the status of each project
   */
  private _printOperationStatus(): void {
    const tasksByStatus: { [status: string]: Operation[] } = {};
    for (const operation of this._operations) {
      switch (operation.status) {
        // These are the sections that we will report below
        case OperationStatus.Skipped:
        case OperationStatus.FromCache:
        case OperationStatus.Success:
        case OperationStatus.SuccessWithWarning:
        case OperationStatus.Blocked:
        case OperationStatus.Failure:
          break;
        default:
          // This should never happen
          throw new InternalError('Unexpected operation status: ' + operation.status);
      }

      if (tasksByStatus[operation.status]) {
        tasksByStatus[operation.status].push(operation);
      } else {
        tasksByStatus[operation.status] = [operation];
      }
    }

    // Skip a few lines before we start the summary
    this._terminal.writeStdoutLine('');
    this._terminal.writeStdoutLine('');
    this._terminal.writeStdoutLine('');

    // These are ordered so that the most interesting statuses appear last:
    this._writeCondensedSummary(
      OperationStatus.Skipped,
      tasksByStatus,
      colors.green,
      'These projects were already up to date:'
    );

    this._writeCondensedSummary(
      OperationStatus.FromCache,
      tasksByStatus,
      colors.green,
      'These projects were restored from the build cache:'
    );

    this._writeCondensedSummary(
      OperationStatus.Success,
      tasksByStatus,
      colors.green,
      'These projects completed successfully:'
    );

    this._writeDetailedSummary(OperationStatus.SuccessWithWarning, tasksByStatus, colors.yellow, 'WARNING');

    this._writeCondensedSummary(
      OperationStatus.Blocked,
      tasksByStatus,
      colors.white,
      'These projects were blocked by dependencies that failed:'
    );

    this._writeDetailedSummary(OperationStatus.Failure, tasksByStatus, colors.red);

    this._terminal.writeStdoutLine('');
  }

  private _writeCondensedSummary(
    status: OperationStatus,
    tasksByStatus: { [status: string]: Operation[] },
    headingColor: (text: string) => string,
    preamble: string
  ): void {
    // Example:
    //
    // ==[ BLOCKED: 4 projects ]==============================================================
    //
    // These projects were blocked by dependencies that failed:
    //   @scope/name
    //   e
    //   k

    const tasks: Operation[] | undefined = tasksByStatus[status];
    if (!tasks || tasks.length === 0) {
      return;
    }
    Sort.sortBy(tasks, (x) => x.name);

    this._writeSummaryHeader(status, tasks, headingColor);
    this._terminal.writeStdoutLine(preamble);

    const longestTaskName: number = Math.max(...tasks.map((x) => x.name.length));

    for (const operation of tasks) {
      if (
        operation.stopwatch &&
        !operation.runner.hadEmptyScript &&
        operation.status !== OperationStatus.Skipped
      ) {
        const time: string = operation.stopwatch.toString();
        const padding: string = ' '.repeat(longestTaskName - operation.name.length);
        this._terminal.writeStdoutLine(`  ${operation.name}${padding}    ${time}`);
      } else {
        this._terminal.writeStdoutLine(`  ${operation.name}`);
      }
    }
    this._terminal.writeStdoutLine('');
  }

  private _writeDetailedSummary(
    status: OperationStatus,
    tasksByStatus: { [status: string]: Operation[] },
    headingColor: (text: string) => string,
    shortStatusName?: string
  ): void {
    // Example:
    //
    // ==[ SUCCESS WITH WARNINGS: 2 projects ]================================
    //
    // --[ WARNINGS: f ]------------------------------------[ 5.07 seconds ]--
    //
    // [eslint] Warning: src/logic/taskExecution/TaskExecutionManager.ts:393:3 ...

    const tasks: Operation[] | undefined = tasksByStatus[status];
    if (!tasks || tasks.length === 0) {
      return;
    }

    this._writeSummaryHeader(status, tasks, headingColor);

    if (shortStatusName === undefined) {
      shortStatusName = status;
    }

    for (const operation of tasks) {
      // Format a header like this
      //
      // --[ WARNINGS: f ]------------------------------------[ 5.07 seconds ]--

      // leftPart: "--[ WARNINGS: f "
      const subheadingText: string = `${shortStatusName}: ${operation.name}`;

      const leftPart: string = colors.gray('--[') + ' ' + headingColor(subheadingText) + ' ';
      const leftPartLength: number = 4 + subheadingText.length + 1;

      // rightPart: " 5.07 seconds ]--"
      const time: string = operation.stopwatch.toString();
      const rightPart: string = ' ' + colors.white(time) + ' ' + colors.gray(']--');
      const rightPartLength: number = 1 + time.length + 1 + 3;

      // middlePart: "]----------------------["
      const twoBracketsLength: number = 2;
      const middlePartLengthMinusTwoBrackets: number = Math.max(
        ASCII_HEADER_WIDTH - (leftPartLength + rightPartLength + twoBracketsLength),
        0
      );

      const middlePart: string = colors.gray(']' + '-'.repeat(middlePartLengthMinusTwoBrackets) + '[');

      this._terminal.writeStdoutLine(leftPart + middlePart + rightPart + '\n');

      const details: string = operation.stdioSummarizer.getReport();
      if (details) {
        // Don't write a newline, because the report will always end with a newline
        this._terminal.writeChunk({ text: details, kind: TerminalChunkKind.Stdout });
      }

      this._terminal.writeStdoutLine('');
    }
  }

  private _writeSummaryHeader(
    status: OperationStatus,
    tasks: Operation[],
    headingColor: (text: string) => string
  ): void {
    // Format a header like this
    //
    // ==[ FAILED: 2 projects ]================================================

    // "2 projects"
    const projectsText: string = tasks.length.toString() + (tasks.length === 1 ? ' project' : ' projects');
    const headingText: string = `${status}: ${projectsText}`;

    // leftPart: "==[ FAILED: 2 projects "
    const leftPart: string = colors.gray('==[') + ' ' + headingColor(headingText) + ' ';
    const leftPartLength: number = 3 + 1 + headingText.length + 1;

    const rightPartLengthMinusBracket: number = Math.max(ASCII_HEADER_WIDTH - (leftPartLength + 1), 0);

    // rightPart: "]======================"
    const rightPart: string = colors.gray(']' + '='.repeat(rightPartLengthMinusBracket));

    this._terminal.writeStdoutLine(leftPart + rightPart);
    this._terminal.writeStdoutLine('');
  }
}
