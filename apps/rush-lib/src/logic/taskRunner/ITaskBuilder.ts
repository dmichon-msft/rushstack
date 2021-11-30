// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { StdioSummarizer } from '@rushstack/terminal';
import { CollatedWriter } from '@rushstack/stream-collator';

import { TaskStatus } from './TaskStatus';
import { CommandLineConfiguration } from '../../api/CommandLineConfiguration';

export interface IBuilderContext {
  repoCommandLineConfiguration: CommandLineConfiguration | undefined;
  collatedWriter: CollatedWriter;
  stdioSummarizer: StdioSummarizer;
  quietMode: boolean;
  debugMode: boolean;
}

/**
 * The `Task` class is a node in the dependency graph of work that needs to be scheduled by the `TaskRunner`.
 * Each `Task` has an `ITaskBuilder` member, whose subclass manages the actual operations for building a single
 * project.
 */
export interface ITaskBuilder {
  /**
   * Name of the task definition.
   */
  readonly name: string;

  /**
   * This flag determines if the task is allowed to be skipped if up to date.
   */
  isSkipAllowed: boolean;

  /**
   * Assigned by execute().  True if the build script was an empty string.  Operationally an empty string is
   * like a shell command that succeeds instantly, but e.g. it would be odd to report build time statistics for it.
   */
  hadEmptyScript: boolean;

  /**
   * Method to be executed for the task.
   */
  executeAsync(context: IBuilderContext): Promise<TaskStatus>;
}
