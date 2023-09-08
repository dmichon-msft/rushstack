// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { ChildProcess } from 'node:child_process';

import {
  TerminalProviderSeverity,
  type ITerminal,
  type ITerminalProvider
} from '@rushstack/node-core-library';
import { IPhase } from '../../api/CommandLineConfiguration';
import { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { OperationStatus } from './OperationStatus';
import { IOperationRunner, IOperationRunnerContext } from './IOperationRunner';
import { RushConfiguration } from '../../api/RushConfiguration';
import { Utilities } from '../../utilities/Utilities';

export interface IHeftOperationRunnerOptions {
  phase: IPhase;
  project: RushConfigurationProject;
  name: string;
  shellCommand: string;
  warningsAreAllowed: boolean;
}

interface IFinishedMessage {
  type: 'finished';
  status: OperationStatus;
}

function isFinishedMessage(message: unknown): message is IFinishedMessage {
  return typeof message === 'object' && (message as IFinishedMessage).type === 'finished';
}

export class HeftOperationRunner implements IOperationRunner {
  public readonly name: string;
  public readonly cacheable: boolean = false;
  public readonly reportTiming: boolean = true;
  public readonly silent: boolean = false;
  public readonly warningsAreAllowed: boolean;

  private readonly _rushConfiguration: RushConfiguration;
  private readonly _shellCommand: string;
  private readonly _workingDirectory: string;
  private _heftProcess: ChildProcess | undefined;

  public constructor(options: IHeftOperationRunnerOptions) {
    this.name = options.name;
    this._rushConfiguration = options.project.rushConfiguration;
    this._shellCommand = options.shellCommand;
    this._workingDirectory = options.project.projectFolder;
    this.warningsAreAllowed = options.warningsAreAllowed;
  }

  public async executeAsync(context: IOperationRunnerContext): Promise<OperationStatus> {
    return await context.withTerminalAsync(
      async (terminal: ITerminal, terminalProvider: ITerminalProvider): Promise<OperationStatus> => {
        if (!this._heftProcess || typeof this._heftProcess.exitCode === 'number') {
          // Run the operation
          terminal.writeLine('Invoking: ' + this._shellCommand);

          this._heftProcess = Utilities.executeLifecycleCommandAsync(this._shellCommand, {
            rushConfiguration: this._rushConfiguration,
            workingDirectory: this._workingDirectory,
            initCwd: this._rushConfiguration.commonTempFolder,
            handleOutput: true,
            environmentPathOptions: {
              includeProjectBin: true
            },
            ipc: true
          });
        }
        const subProcess: ChildProcess = this._heftProcess;
        let hasWarningOrError: boolean = false;

        function onStdout(data: Buffer): void {
          const text: string = data.toString();
          terminalProvider.write(text, TerminalProviderSeverity.log);
        }
        function onStderr(data: Buffer): void {
          const text: string = data.toString();
          terminalProvider.write(text, TerminalProviderSeverity.error);
          hasWarningOrError = true;
        }

        // Hook into events, in order to get live streaming of the log
        subProcess.stdout?.on('data', onStdout);
        subProcess.stderr?.on('data', onStderr);

        const status: OperationStatus = await new Promise((resolve, reject) => {
          function messageHandler(message: unknown): void {
            if (isFinishedMessage(message)) {
              terminal.writeLine('Received finish notification');
              subProcess.off('message', messageHandler);
              subProcess.stdout?.off('data', onStdout);
              subProcess.stderr?.off('data', onStderr);
              subProcess.off('error', reject);
              subProcess.off('exit', reject);
              terminal.writeLine('Disconnected from Heft process');
              resolve(message.status);
            }
          }

          subProcess.on('message', messageHandler);
          subProcess.on('error', reject);
          subProcess.on('exit', reject);

          terminal.writeLine('Notifying the Heft process to start the build...');
          subProcess.send('run');
        });

        return status === OperationStatus.Success && hasWarningOrError
          ? OperationStatus.SuccessWithWarning
          : status;
      },
      true
    );
  }

  public getConfigHash(): string {
    return this._shellCommand;
  }
}
