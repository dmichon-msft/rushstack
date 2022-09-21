// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as child_process from 'child_process';
import { once } from 'events';

import { TerminalChunkKind } from '@rushstack/terminal';

import type { RushConfiguration } from '../../api/RushConfiguration';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { Utilities } from '../../utilities/Utilities';
import { OperationStatus } from './OperationStatus';
import { OperationError } from './OperationError';
import { IOperationRunner, IOperationRunnerContext } from './IOperationRunner';
import type { IPhase } from '../../api/CommandLineConfiguration';
import { EnvironmentConfiguration } from '../../api/EnvironmentConfiguration';

export interface IProjectDeps {
  files: { [filePath: string]: string };
  arguments: string;
}

export interface IOperationRunnerOptions {
  associatedProject: RushConfigurationProject;
  associatedPhase: IPhase;

  rushConfiguration: RushConfiguration;
  commandToRun: string;
  displayName: string;
  isIncrementalBuildAllowed: boolean;
}

type SuccessStatus = OperationStatus.Success | OperationStatus.SuccessWithWarning;

/**
 * An `IOperationRunner` subclass that performs an operation via a shell command.
 */
export class ShellOperationRunner implements IOperationRunner {
  public readonly name: string;

  // This runner supports cache writes by default.
  public isCacheWriteAllowed: boolean = true;
  public isSkipAllowed: boolean;
  public readonly reportTiming: boolean = true;
  public readonly silent: boolean = false;
  public readonly warningsAreAllowed: boolean;

  private readonly _rushProject: RushConfigurationProject;
  private readonly _rushConfiguration: RushConfiguration;
  private readonly _commandToRun: string;

  public constructor(options: IOperationRunnerOptions) {
    const { associatedPhase: phase } = options;

    this.name = options.displayName;
    this._rushProject = options.associatedProject;
    this._rushConfiguration = options.rushConfiguration;
    this._commandToRun = options.commandToRun;
    this.isSkipAllowed = options.isIncrementalBuildAllowed;
    this.warningsAreAllowed =
      EnvironmentConfiguration.allowWarningsInSuccessfulBuild || phase.allowWarningsOnSuccess || false;
  }

  public async executeAsync(context: IOperationRunnerContext): Promise<OperationStatus> {
    try {
      return await this._executeAsync(context);
    } catch (error) {
      throw new OperationError('executing', (error as Error).message);
    }
  }

  /**
   * Runs the underlying command
   */
  private async _executeAsync(context: IOperationRunnerContext): Promise<SuccessStatus> {
    const { terminal, terminalWritable } = context;

    terminal.writeLine(`Invoking: ${this._commandToRun}`);

    const subProcess: child_process.ChildProcess = Utilities.executeLifecycleCommandAsync(
      this._commandToRun,
      {
        rushConfiguration: this._rushConfiguration,
        workingDirectory: this._rushProject.projectFolder,
        initCwd: this._rushConfiguration.commonTempFolder,
        handleOutput: true,
        environmentPathOptions: {
          includeProjectBin: true
        }
      }
    );

    let status: SuccessStatus = OperationStatus.Success;

    // Hook into events, in order to get live streaming of the log
    subProcess.stdout?.on('data', (data: Buffer) => {
      const text: string = data.toString();
      terminalWritable.writeChunk({ text, kind: TerminalChunkKind.Stdout });
    });
    subProcess.stderr?.on('data', (data: Buffer) => {
      const text: string = data.toString();
      terminalWritable.writeChunk({ text, kind: TerminalChunkKind.Stderr });
      status = OperationStatus.SuccessWithWarning;
    });

    // Typings in node 12 for once are wrong
    const code: number = (await once(subProcess, 'close')) as unknown as number;
    if (code !== 0) {
      throw new OperationError('error', `Returned error code: ${code}`);
    }

    return status;
  }
}
