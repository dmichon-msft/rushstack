// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { InternalError, ITerminal } from '@rushstack/node-core-library';

import { OperationStatus } from './OperationStatus';
import { Stopwatch } from '../utilities/Stopwatch';
import type { OperationError } from './OperationError';
import type { Operation } from './Operation';
import type { IOperationRunner, IOperationRunnerContext } from './IOperationRunner';
import type { LoggingManager } from '../pluginFramework/logging/LoggingManager';
import type { OperationGroupRecord } from './OperationGroupRecord';
import { IChangedFileState } from '../pluginFramework/HeftTaskSession';

export interface IOperationExecutionRecordOptions {
  operation: Operation;
  group: OperationGroupRecord | undefined;
  context: IOperationExecutionRecordContext;
}

export interface IOperationExecutionRecordContext {
  terminal: ITerminal;
  loggingManager: LoggingManager;
}

/**
 * Internal class representing everything about executing an operation
 */
export class OperationExecutionRecord implements IOperationRunnerContext {
  /**
   * The current execution status of an operation. Operations start in the 'ready' state,
   * but can be 'blocked' if an upstream operation failed. It is 'executing' when
   * the operation is executing. Once execution is complete, it is either 'success' or
   * 'failure'.
   */
  public status: OperationStatus = OperationStatus.Ready;

  /**
   * The error which occurred while executing this operation, this is stored in case we need
   * it later (for example to re-print errors at end of execution).
   */
  public error: OperationError | undefined = undefined;

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
  public readonly group: OperationGroupRecord | undefined;

  public readonly changedFiles: Map<string, IChangedFileState> = new Map();

  private readonly _context: IOperationExecutionRecordContext;

  public constructor(options: IOperationExecutionRecordOptions) {
    const { operation, group, context } = options;
    const { runner } = operation;

    if (!runner) {
      throw new InternalError(`Operation has no runner.`);
    }

    this.runner = runner;
    this.weight = operation.weight;
    this._context = context;
    this.group = group;
    this.group?.addOperation(this);
  }

  public get name(): string {
    return this.runner.name;
  }

  public get terminal(): ITerminal {
    return this._context.terminal;
  }

  public get loggingManager(): LoggingManager {
    return this._context.loggingManager;
  }

  public async executeAsync(onResult: (record: OperationExecutionRecord) => void): Promise<void> {
    this.status = OperationStatus.Executing;
    this.stopwatch.start();
    this.group?.startTimer();

    try {
      this.status = await this.runner.executeAsync(this);
      // Delegate global state reporting
      onResult(this);
    } catch (error) {
      this.status = OperationStatus.Failure;
      this.error = error as OperationError;
      // Delegate global state reporting
      onResult(this);
    } finally {
      this.group?.setOperationAsComplete(this);
      this.stopwatch.stop();
    }
  }
}
