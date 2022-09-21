// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  DiscardStdoutTransform,
  SplitterTransform,
  StderrLineTransform,
  TerminalWritable,
  TextRewriterTransform
} from '@rushstack/terminal';
import { InternalError, ITerminal, NewlineKind, Terminal } from '@rushstack/node-core-library';
import { CollatedTerminal, CollatedWriter, StreamCollator } from '@rushstack/stream-collator';

import { OperationStatus } from './OperationStatus';
import { IOperationRunner, IOperationRunnerContext } from './IOperationRunner';
import { Operation } from './Operation';
import { Stopwatch } from '../../utilities/Stopwatch';
import { OperationStateFile } from './OperationStateFile';
import { ProjectLogWritable } from './ProjectLogWritable';
import { CollatedTerminalProvider } from '../../utilities/CollatedTerminalProvider';

export interface IOperationExecutionRecordContext {
  streamCollator: StreamCollator;

  debugMode: boolean;
  quietMode: boolean;

  commonTempFolder: string;
}

/**
 * Internal class representing everything about executing an operation
 */
export class OperationExecutionRecord {
  /**
   * The current execution status of an operation. Operations start in the 'ready' state,
   * but can be 'blocked' if an upstream operation failed. It is 'executing' when
   * the operation is executing. Once execution is complete, it is either 'success' or
   * 'failure'.
   */
  public status: OperationStatus = OperationStatus.Ready;

  /**
   * The input hash that `status` is valid for.
   */
  public hash: string | undefined = undefined;

  /**
   * The error which occurred while executing this operation, this is stored in case we need
   * it later (for example to re-print errors at end of execution).
   */
  public error: Error | undefined = undefined;

  /**
   * This number represents how far away this Operation is from the furthest "root" operation (i.e.
   * an operation with no consumers). This helps us to calculate the critical path (i.e. the
   * longest chain of projects which must be executed in order, thereby limiting execution speed
   * of the entire operation tree.
   *
   * This number is calculated via a memoized depth-first search, and when choosing the next
   * operation to execute, the operation with the highest criticalPathLength is chosen.
   *
   * Example:
   *        (0) A
   *             \
   *          (1) B     C (0)         (applications)
   *               \   /|\
   *                \ / | \
   *             (2) D  |  X (1)      (utilities)
   *                    | / \
   *                    |/   \
   *                (2) Y     Z (2)   (other utilities)
   *
   * All roots (A & C) have a criticalPathLength of 0.
   * B has a score of 1, since A depends on it.
   * D has a score of 2, since we look at the longest chain (e.g D->B->A is longer than D->C)
   * X has a score of 1, since the only package which depends on it is A
   * Z has a score of 2, since only X depends on it, and X has a score of 1
   * Y has a score of 2, since the chain Y->X->C is longer than Y->C
   *
   * The algorithm is implemented in AsyncOperationQueue.ts as calculateCriticalPathLength()
   */
  public criticalPathLength: number | undefined = undefined;

  /**
   * The set of operations that must complete before this operation executes.
   */
  public readonly dependencies: Set<OperationExecutionRecord> = new Set();
  /**
   * The set of operations that depend on this operation.
   */
  public readonly consumers: Set<OperationExecutionRecord> = new Set();

  public readonly stopwatch: Stopwatch = new Stopwatch();

  public readonly runner: IOperationRunner;
  public readonly weight: number;
  public readonly _operationStateFile: OperationStateFile | undefined;

  private readonly _operation: Operation;
  private readonly _context: IOperationExecutionRecordContext;

  public constructor(operation: Operation, context: IOperationExecutionRecordContext) {
    const { runner } = operation;
    this._operation = operation;

    if (!runner) {
      throw new InternalError(
        `Operation for phase '${operation.associatedPhase?.name}' and project '${operation.associatedProject?.packageName}' has no runner.`
      );
    }

    this.runner = runner;
    this.weight = operation.weight;
    if (operation.associatedPhase && operation.associatedProject) {
      this._operationStateFile = new OperationStateFile({
        phase: operation.associatedPhase,
        rushProject: operation.associatedProject
      });
    }
    this._context = context;
  }

  public get name(): string {
    return this.runner.name;
  }

  public get nonCachedDurationMs(): number | undefined {
    // Lazy calculated because the state file is created/restored later on
    return this._operationStateFile?.state?.nonCachedDurationMs;
  }

  public async executeAsync(onResult: (record: OperationExecutionRecord) => void): Promise<void> {
    // Get current hash
    // Check against last hash
    // If match, do nothing

    this.status = OperationStatus.Executing;
    this.stopwatch.start();

    // Check for cache hit
    // If found, attempt cache replay via priority queue

    // Wait for dependencies to finish

    // If not found or cache replay failed, invoke runner

    const runnerContext: OperationRunnerContext = new OperationRunnerContext(this._operation, this._context);

    try {
      this.status = await this.runner.executeAsync(runnerContext);
      // Delegate global state reporting
      onResult(this);
    } catch (error) {
      this.status = OperationStatus.Failure;
      this.error = error;
      // Delegate global state reporting
      onResult(this);
    } finally {
      runnerContext.dispose();
      this.stopwatch.stop();
    }

    // Perform cache write
  }
}

interface IProjectLogs {
  terminalWritable: TerminalWritable;
  projectLogWritable: ProjectLogWritable;
  terminal: ITerminal;
}

class OperationRunnerContext implements IOperationRunnerContext {
  private readonly _operation: Operation;
  private readonly _context: IOperationExecutionRecordContext;
  private _logger: IProjectLogs | undefined;

  public constructor(operation: Operation, context: IOperationExecutionRecordContext) {
    this._operation = operation;
    this._context = context;
    this._logger = undefined;
  }

  public get debugMode(): boolean {
    return this._context.debugMode;
  }

  public get quietMode(): boolean {
    return this._context.quietMode;
  }

  public get terminal(): ITerminal {
    return this._ensureLog().terminal;
  }

  public get terminalWritable(): TerminalWritable {
    return this._ensureLog().terminalWritable;
  }

  public dispose(): void {
    if (this._logger) {
      this._logger.terminalWritable.close();
      this._logger.projectLogWritable.close();
    }
  }

  private _ensureLog(): IProjectLogs {
    if (!this._logger) {
      const { name } = this._operation;

      const { commonTempFolder, streamCollator, debugMode, quietMode } = this._context;

      const logFilePath: string = this._operation.getLogFilePath(commonTempFolder);

      // TERMINAL PIPELINE:
      //                             +--> quietModeTransform? --> collatedWriter
      //                             |
      // normalizeNewlineTransform --1--> stderrLineTransform --> removeColorsTransform --> projectLogWritable
      const collatedWriter: CollatedWriter = streamCollator.registerTask(name!);

      const projectLogWritable: ProjectLogWritable = new ProjectLogWritable(
        logFilePath,
        collatedWriter.terminal
      );

      const removeColorsTransform: TextRewriterTransform = new TextRewriterTransform({
        destination: projectLogWritable,
        removeColors: true,
        normalizeNewlines: NewlineKind.OsDefault
      });

      const stderrLineTransform: StderrLineTransform = new StderrLineTransform({
        destination: removeColorsTransform,
        newlineKind: NewlineKind.Lf // for StdioSummarizer
      });

      const splitterTransform: SplitterTransform = new SplitterTransform({
        destinations: [
          quietMode ? new DiscardStdoutTransform({ destination: collatedWriter }) : collatedWriter,
          stderrLineTransform
        ]
      });

      const normalizeNewlineTransform: TextRewriterTransform = new TextRewriterTransform({
        destination: splitterTransform,
        normalizeNewlines: NewlineKind.Lf,
        ensureNewlineAtEnd: true
      });

      const collatedTerminal: CollatedTerminal = new CollatedTerminal(normalizeNewlineTransform);
      const terminalProvider: CollatedTerminalProvider = new CollatedTerminalProvider(collatedTerminal, {
        debugEnabled: debugMode
      });
      const terminal: Terminal = new Terminal(terminalProvider);

      this._logger = {
        terminalWritable: normalizeNewlineTransform,
        projectLogWritable,
        terminal
      };
    }

    return this._logger;
  }
}
