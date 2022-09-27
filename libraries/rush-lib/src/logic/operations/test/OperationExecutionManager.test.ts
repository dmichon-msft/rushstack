// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// The TaskExecutionManager prints "x.xx seconds" in TestRunner.test.ts.snap; ensure that the Stopwatch timing is deterministic
jest.mock('../../../utilities/Utilities');

import { EOL } from 'os';

import colors from 'colors/safe';

import { ITerminal, Terminal } from '@rushstack/node-core-library';
import { CollatedTerminal } from '@rushstack/stream-collator';
import { MockWritable } from '@rushstack/terminal';

import { OperationExecutionManager, IOperationExecutionManagerOptions } from '../OperationExecutionManager';
import { _printOperationStatus } from '../OperationResultSummarizerPlugin';
import { _printTimeline } from '../ConsoleTimelinePlugin';
import { OperationStatus } from '../OperationStatus';
import { Operation } from '../Operation';
import { Utilities } from '../../../utilities/Utilities';
import type { IOperationRunner } from '../IOperationRunner';
import { MockOperationRunner } from './MockOperationRunner';
import type { IExecutionResult, IOperationExecutionResult } from '../IOperationExecutionResult';
import { CollatedTerminalProvider } from '../../../utilities/CollatedTerminalProvider';
import { IPhase } from '../../../api/CommandLineConfiguration';

const mockGetTimeInMs: jest.Mock = jest.fn();
Utilities.getTimeInMs = mockGetTimeInMs;

let mockTimeInMs: number = 0;
mockGetTimeInMs.mockImplementation(() => {
  console.log('CALLED mockGetTimeInMs');
  mockTimeInMs += 100;
  return mockTimeInMs;
});

const mockWritable: MockWritable = new MockWritable();
const mockTerminal: Terminal = new Terminal(new CollatedTerminalProvider(new CollatedTerminal(mockWritable)));

const defaultPhase: IPhase = {
  name: '_phase:foo',
  isSynthetic: false,
  ignoreMissingScript: true,
  logFilenameIdentifier: 'foo',
  allowWarningsOnSuccess: false,
  associatedParameters: new Set(),
  dependencies: {
    self: new Set(),
    upstream: new Set()
  }
};

function createExecutionManager(
  executionManagerOptions: IOperationExecutionManagerOptions,
  operationRunner: IOperationRunner
): OperationExecutionManager {
  const operation: Operation = new Operation({
    phase: defaultPhase,
    project: undefined!,
    runner: operationRunner
  });

  return new OperationExecutionManager(new Set([operation]), executionManagerOptions);
}

describe(OperationExecutionManager.name, () => {
  let executionManager: OperationExecutionManager;
  let executionManagerOptions: IOperationExecutionManagerOptions;

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

  describe('Error logging', () => {
    beforeEach(() => {
      executionManagerOptions = {
        quietMode: false,
        debugMode: false,
        parallelism: 1,
        changedProjectsOnly: false,
        destination: mockWritable
      };
    });

    it('printedStderrAfterError', async () => {
      executionManager = createExecutionManager(
        executionManagerOptions,
        new MockOperationRunner('stdout+stderr', async (terminal: ITerminal) => {
          terminal.writeLine('Build step 1' + EOL);
          terminal.writeErrorLine('Error: step 1 failed' + EOL);
          return OperationStatus.Failure;
        })
      );

      const result: IExecutionResult = await executionManager.executeAsync();
      await _printOperationStatus(mockTerminal, result);
      expect(result.status).toEqual(OperationStatus.Failure);
      expect(result.operationResults.size).toEqual(1);
      const firstResult: IOperationExecutionResult = result.operationResults.values().next().value;
      expect(firstResult.status).toEqual(OperationStatus.Failure);

      const allMessages: string = mockWritable.getAllOutput();
      expect(allMessages).toContain('Error: step 1 failed');
      expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
    });

    it('printedStdoutAfterErrorWithEmptyStderr', async () => {
      executionManager = createExecutionManager(
        executionManagerOptions,
        new MockOperationRunner('stdout only', async (terminal: ITerminal) => {
          terminal.writeLine('Build step 1' + EOL);
          terminal.writeLine('Error: step 1 failed' + EOL);
          return OperationStatus.Failure;
        })
      );

      const result: IExecutionResult = await executionManager.executeAsync();
      await _printOperationStatus(mockTerminal, result);
      expect(result.status).toEqual(OperationStatus.Failure);
      expect(result.operationResults.size).toEqual(1);
      const firstResult: IOperationExecutionResult = result.operationResults.values().next().value;
      expect(firstResult.status).toEqual(OperationStatus.Failure);

      const allOutput: string = mockWritable.getAllOutput();
      expect(allOutput).toMatch(/Build step 1/);
      expect(allOutput).toMatch(/Error: step 1 failed/);
      expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
    });
  });

  describe('Warning logging', () => {
    describe('Fail on warning', () => {
      beforeEach(() => {
        executionManagerOptions = {
          quietMode: false,
          debugMode: false,
          parallelism: 1,
          changedProjectsOnly: false,
          destination: mockWritable
        };
      });

      it('Logs warnings correctly', async () => {
        executionManager = createExecutionManager(
          executionManagerOptions,
          new MockOperationRunner('success with warnings (failure)', async (terminal: ITerminal) => {
            terminal.writeLine('Build step 1' + EOL);
            terminal.writeWarningLine('Warning: step 1 succeeded with warnings' + EOL);
            return OperationStatus.SuccessWithWarning;
          })
        );

        const result: IExecutionResult = await executionManager.executeAsync();
        await _printOperationStatus(mockTerminal, result);
        expect(result.status).toEqual(OperationStatus.SuccessWithWarning);
        expect(result.operationResults.size).toEqual(1);
        const firstResult: IOperationExecutionResult = result.operationResults.values().next().value;
        expect(firstResult.status).toEqual(OperationStatus.SuccessWithWarning);

        const allMessages: string = mockWritable.getAllOutput();
        expect(allMessages).toContain('Build step 1');
        expect(allMessages).toContain('step 1 succeeded with warnings');
        expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
      });
    });

    describe('Success on warning', () => {
      beforeEach(() => {
        executionManagerOptions = {
          quietMode: false,
          debugMode: false,
          parallelism: 1,
          changedProjectsOnly: false,
          destination: mockWritable
        };
      });

      it('Logs warnings correctly', async () => {
        executionManager = createExecutionManager(
          executionManagerOptions,
          new MockOperationRunner(
            'success with warnings (success)',
            async (terminal: ITerminal) => {
              terminal.writeLine('Build step 1' + EOL);
              terminal.writeWarningLine('Warning: step 1 succeeded with warnings' + EOL);
              return OperationStatus.SuccessWithWarning;
            },
            /* warningsAreAllowed */ true
          )
        );

        const result: IExecutionResult = await executionManager.executeAsync();
        await _printOperationStatus(mockTerminal, result);
        expect(result.status).toEqual(OperationStatus.Success);
        expect(result.operationResults.size).toEqual(1);
        const firstResult: IOperationExecutionResult = result.operationResults.values().next().value;
        expect(firstResult.status).toEqual(OperationStatus.SuccessWithWarning);
        const allMessages: string = mockWritable.getAllOutput();
        expect(allMessages).toContain('Build step 1');
        expect(allMessages).toContain('Warning: step 1 succeeded with warnings');
        expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
      });

      it('logs warnings correctly with --timeline option', async () => {
        executionManager = createExecutionManager(
          executionManagerOptions,
          new MockOperationRunner(
            'success with warnings (success)',
            async (terminal: ITerminal) => {
              terminal.writeLine('Build step 1' + EOL);
              terminal.writeWarningLine('Warning: step 1 succeeded with warnings' + EOL);
              return OperationStatus.SuccessWithWarning;
            },
            /* warningsAreAllowed */ true
          )
        );

        const result: IExecutionResult = await executionManager.executeAsync();
        _printTimeline(mockTerminal, result);
        await _printOperationStatus(mockTerminal, result);
        const allMessages: string = mockWritable.getAllOutput();
        expect(allMessages).toContain('Build step 1');
        expect(allMessages).toContain('Warning: step 1 succeeded with warnings');
        expect(mockWritable.getFormattedChunks()).toMatchSnapshot();
      });
    });
  });
});
