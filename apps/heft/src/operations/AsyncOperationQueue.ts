// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { OperationStatus } from './OperationStatus';
import { OperationExecutionRecord } from './OperationExecutionRecord';

/**
 * Implmentation of the async iteration protocol for a collection of IOperation objects.
 * The async iterator will wait for an operation to be ready for execution, or terminate if there are no more operations.
 *
 * @remarks
 * If the caller does not update dependencies prior to invoking `next()` on the iterator again,
 * it must manually invoke `assignOperations()` after performing the updates, otherwise iterators will
 * stall until another operations completes.
 */
export class AsyncOperationQueue
  implements AsyncIterable<OperationExecutionRecord>, AsyncIterator<OperationExecutionRecord>
{
  private readonly _queue: OperationExecutionRecord[];
  private readonly _pendingIterators: ((result: IteratorResult<OperationExecutionRecord>) => void)[];

  /**
   * @param operations - The set of operations to be executed
   * @param sortFn - A function that sorts operations in reverse priority order:
   *   - Returning a positive value indicates that `a` should execute before `b`.
   *   - Returning a negative value indicates that `b` should execute before `a`.
   *   - Returning 0 indicates no preference.
   */
  public constructor(operations: Iterable<OperationExecutionRecord>, sortFn: IOperationSortFunction) {
    this._queue = computeTopologyAndSort(operations, sortFn);
    this._pendingIterators = [];
  }

  /**
   * For use with `for await (const operation of taskQueue)`
   * @see {AsyncIterator}
   */
  public next(): Promise<IteratorResult<OperationExecutionRecord>> {
    const { _pendingIterators: waitingIterators } = this;

    const promise: Promise<IteratorResult<OperationExecutionRecord>> = new Promise(
      (resolve: (result: IteratorResult<OperationExecutionRecord>) => void) => {
        waitingIterators.push(resolve);
      }
    );

    this.assignOperations();

    return promise;
  }

  /**
   * Routes ready operations with 0 dependencies to waiting iterators. Normally invoked as part of `next()`, but
   * if the caller does not update operation dependencies prior to calling `next()`, may need to be invoked manually.
   */
  public assignOperations(): void {
    const { _queue: queue, _pendingIterators: waitingIterators } = this;

    // By iterating in reverse order we do less array shuffling when removing operations
    for (let i: number = queue.length - 1; waitingIterators.length > 0 && i >= 0; i--) {
      const operation: OperationExecutionRecord = queue[i];

      if (operation.status === OperationStatus.Blocked || operation.status === OperationStatus.Cancelled) {
        // It shouldn't be on the queue, remove it
        queue.splice(i, 1);
      } else if (operation.status !== OperationStatus.Ready) {
        // Sanity check
        throw new Error(
          `Unexpected status ${JSON.stringify(operation.status)} for queued operation: ${operation.name}`
        );
      } else if (operation.dependencies.size === 0) {
        // This task is ready to process, hand it to the iterator.
        queue.splice(i, 1);
        // Needs to have queue semantics, otherwise tools that iterate it get confused
        waitingIterators.shift()!({
          value: operation,
          done: false
        });
      }
      // Otherwise operation is still waiting
    }

    if (queue.length === 0) {
      // Queue is empty, flush
      for (const resolveAsyncIterator of waitingIterators.splice(0)) {
        resolveAsyncIterator({
          value: undefined,
          done: true
        });
      }
    }
  }

  /**
   * Returns this queue as an async iterator, such that multiple functions iterating this object concurrently
   * receive distinct iteration results.
   */
  public [Symbol.asyncIterator](): AsyncIterator<OperationExecutionRecord> {
    return this;
  }
}

export interface IOperationSortFunction {
  /**
   * A function that sorts operations in reverse priority order:
   * Returning a positive value indicates that `a` should execute before `b`.
   * Returning a negative value indicates that `b` should execute before `a`.
   * Returning 0 indicates no preference.
   */
  (a: OperationExecutionRecord, b: OperationExecutionRecord): number;
}

/**
 * Performs a depth-first search to topologically sort the operations, subject to override via sortFn
 */
function computeTopologyAndSort(
  operations: Iterable<OperationExecutionRecord>,
  sortFn: IOperationSortFunction
): OperationExecutionRecord[] {
  // Clone the set of operations as an array, so that we can sort it.
  const queue: OperationExecutionRecord[] = Array.from(operations);

  // Create a collection for detecting visited nodes
  const cycleDetectorStack: Set<OperationExecutionRecord> = new Set();
  for (const operation of queue) {
    calculateCriticalPathLength(operation, cycleDetectorStack);
  }

  return queue.sort(sortFn);
}

function calculateShortestPath(
  startOperation: OperationExecutionRecord,
  endOperation: OperationExecutionRecord
): OperationExecutionRecord[] {
  const visitedOperations: Set<OperationExecutionRecord> = new Set([startOperation]);
  const parentOperations: Map<OperationExecutionRecord, OperationExecutionRecord> = new Map();
  const distanceMap: Map<OperationExecutionRecord, number> = new Map([[startOperation, 0]]);

  // Run a breadth-first search to find the shortest path between the start and end operations
  const queue: OperationExecutionRecord[] = [startOperation];
  for (const operation of queue) {
    for (const dependencyOperation of operation.dependencies) {
      if (visitedOperations.has(dependencyOperation)) {
        continue;
      }
      visitedOperations.add(dependencyOperation);
      const calculatedDistance: number = (distanceMap.get(operation) ?? Number.MAX_SAFE_INTEGER) + 1;
      distanceMap.set(dependencyOperation, calculatedDistance);
      parentOperations.set(dependencyOperation, operation);
      if (dependencyOperation === endOperation) {
        break;
      }
      queue.push(dependencyOperation);
    }
  }

  // Walk back up the path from the end operation to the start operation
  let currentOperation: OperationExecutionRecord = endOperation;
  const path: OperationExecutionRecord[] = [];
  while (currentOperation !== startOperation) {
    path.unshift(currentOperation);
    currentOperation = parentOperations.get(currentOperation)!;
  }
  path.unshift(startOperation);
  return path;
}

/**
 * Perform a depth-first search to find critical path length.
 * Cycle detection comes at minimal additional cost.
 */
function calculateCriticalPathLength(
  operation: OperationExecutionRecord,
  dependencyChain: Set<OperationExecutionRecord>
): number {
  if (dependencyChain.has(operation)) {
    // Find where the first cycle occurs
    let firstDetectedCycle: OperationExecutionRecord | undefined;
    for (const dependency of [...dependencyChain]) {
      if (dependency.dependencies.has(operation)) {
        firstDetectedCycle = dependency;
      }
    }

    // Ensure we have the shortest path to the cycle
    const shortestPath: OperationExecutionRecord[] = calculateShortestPath(operation, firstDetectedCycle!);

    throw new Error(
      'A cyclic dependency was encountered:\n  ' +
        shortestPath.map((visitedTask) => visitedTask.name).join('\n  -> ')
    );
  }

  let { criticalPathLength } = operation;

  if (criticalPathLength !== undefined) {
    // This has been visited already
    return criticalPathLength;
  }

  criticalPathLength = 0;
  if (operation.consumers.size) {
    dependencyChain.add(operation);
    for (const consumer of operation.consumers) {
      criticalPathLength = Math.max(
        criticalPathLength,
        calculateCriticalPathLength(consumer, dependencyChain)
      );
    }
    dependencyChain.delete(operation);
  }
  // Include the contribution from the current operation
  operation.criticalPathLength = criticalPathLength + operation.weight;

  // Directly writing operations to an output collection here would yield a topological sorted set
  // However, we want a bit more fine-tuning of the output than just the raw topology

  return criticalPathLength;
}