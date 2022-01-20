// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// The TaskExecutionManager prints "x.xx seconds" in TestRunner.test.ts.snap; ensure that the Stopwatch timing is deterministic
jest.mock('../../../utilities/Utilities');

import colors from 'colors/safe';
import { EOL } from 'os';
import type { CollatedTerminal } from '@rushstack/stream-collator';
import { MockWritable } from '@rushstack/terminal';

import { OperationExecutionManager, ITaskExecutionManagerOptions } from '../OperationExecutionManager';
import { OperationStatus } from '../OperationStatus';
import { Operation } from '../Operation';
import { Utilities } from '../../../utilities/Utilities';
import type { IOperationRunner } from '../IOperationRunner';
import { MockTaskRunner } from './MockOperationRunner';

const mockGetTimeInMs: jest.Mock = jest.fn();
Utilities.getTimeInMs = mockGetTimeInMs;

let mockTimeInMs: number = 0;
mockGetTimeInMs.mockImplementation(() => {
  console.log('CALLED mockGetTimeInMs');
  mockTimeInMs += 100;
  return mockTimeInMs;
});

const mockWritable: MockWritable = new MockWritable();

function createTaskExecutionManager(
  taskExecutionManagerOptions: ITaskExecutionManagerOptions,
  taskRunner: IOperationRunner
): OperationExecutionManager {
  const task: Operation = new Operation(taskRunner, OperationStatus.Ready);

  return new OperationExecutionManager(new Set([task]), taskExecutionManagerOptions);
}

const EXPECTED_FAIL: string = `Promise returned by ${OperationExecutionManager.prototype.executeAsync.name}() resolved but was expected to fail`;

describe(OperationExecutionManager.name, () => {
  let taskExecutionManager: OperationExecutionManager;
  let taskExecutionManagerOptions: ITaskExecutionManagerOptions;

  let initialColorsEnabled: boolean;

  beforeAll(() => {
    initialColorsEnabled = colors.enabled;
    colors.enable();
  });

  afterAll(() => {
    if (!initialColorsEnabled) {
      colors.disable();
    }
  });

  beforeEach(() => {
    mockWritable.reset();
  });

  describe('Constructor', () => {
    it('throwsErrorOnInvalidParallelism', () => {
      expect(
        () =>
          new OperationExecutionManager(new Set(), {
            quietMode: false,
            debugMode: false,
            parallelism: 'tequila',
            changedProjectsOnly: false,
            destination: mockWritable,
            repoCommandLineConfiguration: undefined!
          })
      ).toThrowErrorMatchingSnapshot();
    });
  });

  describe('Error logging', () => {
    beforeEach(() => {
      taskExecutionManagerOptions = {
        quietMode: false,
        debugMode: false,
        parallelism: '1',
        changedProjectsOnly: false,
        destination: mockWritable,
        repoCommandLineConfiguration: undefined!
      };
    });

    it('printedStderrAfterError', async () => {
      taskExecutionManager = createTaskExecutionManager(
        taskExecutionManagerOptions,
        new MockTaskRunner('stdout+stderr', async (terminal: CollatedTerminal) => {
          terminal.writeStdoutLine('Build step 1' + EOL);
          terminal.writeStderrLine('Error: step 1 failed' + EOL);
          return OperationStatus.Failure;
        })
      );

      try {
        await taskExecutionManager.executeAsync();
        fail(EXPECTED_FAIL);
      } catch (err) {
        expect((err as Error).message).toMatchSnapshot();
        const allMessages: string = mockWritable.getAllOutput();
        expect(allMessages).toContain('Error: step 1 failed');
        expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
      }
    });

    it('printedStdoutAfterErrorWithEmptyStderr', async () => {
      taskExecutionManager = createTaskExecutionManager(
        taskExecutionManagerOptions,
        new MockTaskRunner('stdout only', async (terminal: CollatedTerminal) => {
          terminal.writeStdoutLine('Build step 1' + EOL);
          terminal.writeStdoutLine('Error: step 1 failed' + EOL);
          return OperationStatus.Failure;
        })
      );

      try {
        await taskExecutionManager.executeAsync();
        fail(EXPECTED_FAIL);
      } catch (err) {
        expect((err as Error).message).toMatchSnapshot();
        const allOutput: string = mockWritable.getAllOutput();
        expect(allOutput).toMatch(/Build step 1/);
        expect(allOutput).toMatch(/Error: step 1 failed/);
        expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
      }
    });
  });

  describe('Warning logging', () => {
    describe('Fail on warning', () => {
      beforeEach(() => {
        taskExecutionManagerOptions = {
          quietMode: false,
          debugMode: false,
          parallelism: '1',
          changedProjectsOnly: false,
          destination: mockWritable,
          repoCommandLineConfiguration: undefined!
        };
      });

      it('Logs warnings correctly', async () => {
        taskExecutionManager = createTaskExecutionManager(
          taskExecutionManagerOptions,
          new MockTaskRunner('success with warnings (failure)', async (terminal: CollatedTerminal) => {
            terminal.writeStdoutLine('Build step 1' + EOL);
            terminal.writeStdoutLine('Warning: step 1 succeeded with warnings' + EOL);
            return OperationStatus.SuccessWithWarning;
          })
        );

        try {
          await taskExecutionManager.executeAsync();
          fail(EXPECTED_FAIL);
        } catch (err) {
          expect((err as Error).message).toMatchSnapshot();
          const allMessages: string = mockWritable.getAllOutput();
          expect(allMessages).toContain('Build step 1');
          expect(allMessages).toContain('step 1 succeeded with warnings');
          expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
        }
      });
    });

    describe('Success on warning', () => {
      beforeEach(() => {
        taskExecutionManagerOptions = {
          quietMode: false,
          debugMode: false,
          parallelism: '1',
          changedProjectsOnly: false,
          destination: mockWritable,
          repoCommandLineConfiguration: undefined!
        };
      });

      it('Logs warnings correctly', async () => {
        taskExecutionManager = createTaskExecutionManager(
          taskExecutionManagerOptions,
          new MockTaskRunner(
            'success with warnings (success)',
            async (terminal: CollatedTerminal) => {
              terminal.writeStdoutLine('Build step 1' + EOL);
              terminal.writeStdoutLine('Warning: step 1 succeeded with warnings' + EOL);
              return OperationStatus.SuccessWithWarning;
            },
            /* warningsAreAllowed */ true
          )
        );

        await taskExecutionManager.executeAsync();
        const allMessages: string = mockWritable.getAllOutput();
        expect(allMessages).toContain('Build step 1');
        expect(allMessages).toContain('Warning: step 1 succeeded with warnings');
        expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
      });
    });
  });
});
