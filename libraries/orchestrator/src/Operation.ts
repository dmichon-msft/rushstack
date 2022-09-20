// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { IOperationRunner } from './IOperationRunner';
import { OperationStatus } from './OperationStatus';

export interface IOperationResult {
  /**
   * Hash derived from `localStateVector`
   */
  localStateHash: string | undefined;
  /**
   * The states of all "local" inputs, e.g. the tracked files in a Rush project folder and the integrity hashes of external npm dependencies.
   */
  localStateVector: Map<string, string> | undefined;

  /**
   * Hash derived from `localStateHash` and `quickStateVector`
   */
  quickStateHash: string | undefined;
  /**
   * The `quickStateHash` values of all operations this operation depends on
   */
  quickStateVector: Map<Operation<unknown>, string> | undefined;

  /**
   * Hash derived from `
   */
  exactStateHash: string | undefined;
  exactStateVector: Map<string, string> | undefined;

  status: OperationStatus;
  error: Error | undefined;
}

const INITIALIZED: IOperationResult = {
  localStateHash: undefined,
  localStateVector: undefined,

  quickStateHash: undefined,
  quickStateVector: undefined,

  exactStateHash: undefined,
  exactStateVector: undefined,

  status: OperationStatus.Ready,
  error: undefined
};

/**
 * The `Operation` class is a node in the dependency graph of work that needs to be scheduled by the
 * `OperationExecutionManager`. Each `Operation` has a `runner` member of type `IOperationRunner`, whose
 * implementation manages the actual process of running a single operation.
 *
 * @alpha
 */
export class Operation<TMetadata> {
  /**
   * The Rush phase associated with this Operation, if any
   */
  public readonly metadata: TMetadata | undefined;

  /**
   * A set of all operations which depend on this operation.
   */
  public readonly consumers: ReadonlySet<Operation<TMetadata>> = new Set();

  /**
   * A set of all dependencies which must be executed before this operation is complete.
   */
  public readonly dependencies: ReadonlySet<Operation<TMetadata>> = new Set();

  /**
   * When the scheduler is ready to process this `Operation`, the `runner` implements the actual work of
   * running the operation.
   */
  public runner: IOperationRunner | undefined = undefined;

  /**
   * The weight for this operation. This scalar is the contribution of this operation to the
   * `criticalPathLength` calculation above. Modify to indicate the following:
   * - `weight` === 1: indicates that this operation has an average duration
   * - `weight` &gt; 1: indicates that this operation takes longer than average and so the scheduler
   *     should try to favor starting it over other, shorter operations. An example might be an operation that
   *     bundles an entire application and runs whole-program optimization.
   * - `weight` &lt; 1: indicates that this operation takes less time than average and so the scheduler
   *     should favor other, longer operations over it. An example might be an operation to unpack a cached
   *     output, or an operation using NullOperationRunner, which might use a value of 0.
   */
  public weight: number = 1;

  public lastStateHash: string | undefined = undefined;
  public lastRoughHash: string | undefined = undefined;
  public lastExactHash: string | undefined = undefined;

  public status: OperationStatus = 'Ready';

  public constructor(metadata: TMetadata | undefined, runner: IOperationRunner | undefined) {
    this.metadata = metadata;
    this.runner = runner;
  }

  /**
   * The name of this operation, for logging.
   */
  public get name(): string | undefined {
    return this.runner?.name;
  }

  /**
   * Computes an approximate state hash for this operation. The hash is expected to have the following properties:
   * - If the hash for two input vectors matches, outputs can be reused
   * - If the hash for two input vectors does not match, will need to compare exact state hash
   */
  public async getQuickStateHashAsync(): Promise<string> {
    return '';
  }

  /**
   * Computes an exact state hash for this operation. The hash is expected to have the following properties:
   * - If the hash for two input vectors matches, outputs can be reused
   * - If the hash for two input vectors does not match, the operation must be fully executed
   */
  public async getExactStateHashAsync(): Promise<string> {
    return '';
  }

  /**
   * Adds the specified operation as a dependency and updates the consumer list.
   */
  public addDependency(dependency: Operation<TMetadata>): void {
    // Cast internally to avoid adding the overhead of getters
    (this.dependencies as Set<Operation<TMetadata>>).add(dependency);
    (dependency.consumers as Set<Operation<TMetadata>>).add(this);
  }

  /**
   * Deletes the specified operation as a dependency and updates the consumer list.
   */
  public deleteDependency(dependency: Operation<TMetadata>): void {
    // Cast internally to avoid adding the overhead of getters
    (this.dependencies as Set<Operation<TMetadata>>).delete(dependency);
    (dependency.consumers as Set<Operation<TMetadata>>).delete(this);
  }
}
