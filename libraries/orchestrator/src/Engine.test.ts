// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Engine } from './Engine';
import { IOperationResult, Operation } from './Operation';
import { OperationStatus } from './OperationStatus';

interface IBriefStateUpdate {
  key: string | undefined;
  version: string | undefined;
  status: OperationStatus;
  error?: string | undefined;
}

async function testSinglePassAsync(operations: Iterable<Operation<unknown>>) {
  const engine: Engine<unknown> = new Engine(operations);

  const stateChanges: IBriefStateUpdate[] = [];
  engine.hooks.onOperationStateChanged.tap(
    'test-logger',
    (operation: Operation<unknown>, state: IOperationResult) => {
      stateChanges.push({
        key: operation.name,
        version: state.quickStateHash,
        status: state.status,
        error: state.error?.message
      });
    }
  );

  await engine.runOnceAsync();

  expect(stateChanges).toMatchSnapshot();
}

describe(Engine.name, () => {
  it('Does a single pass', async () => {
    await testSinglePassAsync([]);
  });
});
