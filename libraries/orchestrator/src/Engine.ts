// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { SyncHook } from 'tapable';
import { IOperationResult, Operation } from './Operation';

export class EngineHooks<TMetadata> {
  readonly onOperationStateChanged: SyncHook<[Operation<TMetadata>, IOperationResult]> = new SyncHook([
    'operation',
    'status'
  ]);
  readonly onAllOperationsSettled: SyncHook<[]> = new SyncHook();
}

export class Engine<TMetadata> {
  public readonly hooks: EngineHooks<TMetadata> = new EngineHooks();

  private readonly _operations: Set<Operation<TMetadata>>;

  public constructor(operations: Iterable<Operation<TMetadata>>) {
    this._operations = new Set(operations);
  }

  /**
   * Runs until all tracked operations are in a settled state. The cancellation token can be used to terminate the run early.
   * Note that cancellation is only guaranteed to prevent more operations from starting, all currently extant operations will
   * typically run to completion.
   */
  public async runAsync(cancellationToken: unknown): Promise<void> {}
}
