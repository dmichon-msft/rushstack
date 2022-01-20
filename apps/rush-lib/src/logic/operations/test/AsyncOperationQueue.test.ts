// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Operation } from '../Operation';
import { OperationStatus } from '../OperationStatus';
import { MockTaskRunner } from './MockOperationRunner';
import { AsyncOperationQueue, IOperationSortFunction } from '../AsyncOperationQueue';

function addDependency(dependent: Operation, dependency: Operation): void {
  dependent.dependencies.add(dependency);
}

function nullSort(a: Operation, b: Operation): number {
  return 0;
}

describe('AsyncTaskQueue', () => {
  it('iterates tasks in topological order', async () => {
    const tasks = [
      new Operation(new MockTaskRunner('a')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('b')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('c')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('d')!, OperationStatus.Ready)
    ];

    addDependency(tasks[0], tasks[2]);
    addDependency(tasks[3], tasks[1]);
    addDependency(tasks[1], tasks[0]);

    const expectedOrder = [tasks[2], tasks[0], tasks[1], tasks[3]];
    const actualOrder = [];
    const queue: AsyncOperationQueue = new AsyncOperationQueue(tasks, nullSort);
    for await (const task of queue) {
      actualOrder.push(task);
      for (const dependent of task.dependents) {
        dependent.dependencies.delete(task);
      }
    }

    expect(actualOrder).toEqual(expectedOrder);
  });

  it('respects the sort predicate', async () => {
    const tasks = [
      new Operation(new MockTaskRunner('a')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('b')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('c')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('d')!, OperationStatus.Ready)
    ];

    const expectedOrder = [tasks[2], tasks[0], tasks[1], tasks[3]];
    const actualOrder = [];
    const customSort: IOperationSortFunction = (a: Operation, b: Operation): number => {
      return expectedOrder.indexOf(b) - expectedOrder.indexOf(a);
    };

    const queue: AsyncOperationQueue = new AsyncOperationQueue(tasks, customSort);
    for await (const task of queue) {
      actualOrder.push(task);
      for (const dependent of task.dependents) {
        dependent.dependencies.delete(task);
      }
    }

    expect(actualOrder).toEqual(expectedOrder);
  });

  it('detects cyles', async () => {
    const tasks = [
      new Operation(new MockTaskRunner('a')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('b')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('c')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('d')!, OperationStatus.Ready)
    ];

    addDependency(tasks[0], tasks[2]);
    addDependency(tasks[2], tasks[3]);
    addDependency(tasks[3], tasks[1]);
    addDependency(tasks[1], tasks[0]);

    expect(() => {
      new AsyncOperationQueue(tasks, nullSort);
    }).toThrowErrorMatchingSnapshot();
  });

  it('handles concurrent iteration', async () => {
    const tasks = [
      new Operation(new MockTaskRunner('a')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('b')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('c')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('d')!, OperationStatus.Ready),
      new Operation(new MockTaskRunner('e')!, OperationStatus.Ready)
    ];

    // Set up to allow (0,1) -> (2) -> (3,4)
    addDependency(tasks[2], tasks[0]);
    addDependency(tasks[2], tasks[1]);
    addDependency(tasks[3], tasks[2]);
    addDependency(tasks[4], tasks[2]);

    const expectedConcurrency = new Map([
      [tasks[0], 2],
      [tasks[1], 2],
      [tasks[2], 1],
      [tasks[3], 2],
      [tasks[4], 2]
    ]);

    const actualConcurrency: Map<Operation, number> = new Map();
    const queue: AsyncOperationQueue = new AsyncOperationQueue(tasks, nullSort);
    let concurrency: number = 0;

    // Use 3 concurrent iterators to verify that it handles having more than the task concurrency
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for await (const task of queue) {
          ++concurrency;
          await Promise.resolve();

          actualConcurrency.set(task, concurrency);

          await Promise.resolve();

          for (const dependent of task.dependents) {
            dependent.dependencies.delete(task);
          }

          --concurrency;
        }
      })
    );

    for (const [task, taskConcurrency] of expectedConcurrency) {
      expect(actualConcurrency.get(task)).toEqual(taskConcurrency);
    }
  });
});
