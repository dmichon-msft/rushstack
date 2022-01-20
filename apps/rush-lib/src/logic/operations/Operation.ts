// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { StdioSummarizer } from '@rushstack/terminal';
import { CollatedWriter } from '@rushstack/stream-collator';

import { Stopwatch } from '../../utilities/Stopwatch';
import { OperationStatus } from './OperationStatus';
import { OperationError } from './OperationError';
import { IOperationRunner } from './IOperationRunner';

/**
 * The `Operation` class is a node in the dependency graph of work that needs to be scheduled by the
 * `OperationExecutionManager`. Each `Operation` has a `runner` member of type `IOperationRunner`, whose
 * implementation manages the actual process of performing the operation.
 */
export class Operation {
  /**
   * When the scheduler is ready to process this `Operation`, the `runner` implements the actual work of
   * running the operation.
   */
  public runner: IOperationRunner;

  /**
   * The current execution status of a Operation. Operations start in the 'ready' state,
   * but can be 'blocked' if an upstream Operation failed. It is 'executing' when
   * the Operation is executing. Once execution is complete, it is either 'success' or
   * 'failure'.
   */
  public status: OperationStatus;

  /**
   * A set of all dependencies which must be executed before this Operation is complete.
   * When dependencies finish execution, they are removed from this list.
   */
  public dependencies: Set<Operation> = new Set<Operation>();

  /**
   * The inverse of dependencies, lists all Operations which are directly dependent on this one.
   */
  public dependents: Set<Operation> = new Set<Operation>();

  /**
   * This number represents how far away this Operation is from the furthest "root" project (i.e.
   * a project with no dependents). This helps us to calculate the critical path (i.e. the
   * longest chain of projects which must be executed in order, thereby limiting execution speed
   * of the entire Operation tree.
   *
   * This number is calculated via a memoized recursive function, and when choosing the next
   * Operation to execute, the Operation with the highest criticalPathLength is chosen.
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
   * The algorithm is implemented in TaskExecutionManager as _calculateCriticalPaths()
   */
  public criticalPathLength: number | undefined;

  /**
   * The error which occurred while executing this Operation, this is stored in case we need
   * it later (for example to re-print errors at end of execution).
   */
  public error: OperationError | undefined;

  /**
   * The Operation writer which contains information from the output streams of this Operation
   */
  public collatedWriter!: CollatedWriter;

  public stdioSummarizer!: StdioSummarizer;

  /**
   * The stopwatch which measures how long it takes the Operation to execute
   */
  public stopwatch!: Stopwatch;

  public constructor(runner: IOperationRunner, initialStatus: OperationStatus) {
    this.runner = runner;
    this.status = initialStatus;
  }

  public get name(): string {
    return this.runner.name;
  }
}
