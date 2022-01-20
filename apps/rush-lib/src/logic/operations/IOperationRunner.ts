// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { StdioSummarizer } from '@rushstack/terminal';
import type { CollatedWriter } from '@rushstack/stream-collator';

import type { OperationStatus } from './OperationStatus';
import type { CommandLineConfiguration } from '../../api/CommandLineConfiguration';

export interface IOperationRunnerContext {
  repoCommandLineConfiguration: CommandLineConfiguration;
  collatedWriter: CollatedWriter;
  stdioSummarizer: StdioSummarizer;
  quietMode: boolean;
  debugMode: boolean;
}

/**
 * The `ITaskRunner` interface describes an object that can perform the actual work for an `Operation`.
 */
export interface IOperationRunner {
  /**
   * Name of the Operation definition.
   */
  readonly name: string;

  /**
   * This flag determines if the Operation is allowed to be skipped if up to date.
   */
  isSkipAllowed: boolean;

  /**
   * Assigned by execute().  True if the script was an empty string.  Operationally an empty string is
   * like a shell command that succeeds instantly, but e.g. it would be odd to report time statistics for it.
   */
  hadEmptyScript: boolean;

  /**
   * If set to true, a warning result should not make Rush exit with a nonzero
   * exit code
   */
  warningsAreAllowed: boolean;

  /**
   * Indicates if the output of this Operation may be written to the cache
   */
  isCacheWriteAllowed: boolean;

  /**
   * Method to be executed for the Operation.
   */
  executeAsync(context: IOperationRunnerContext): Promise<OperationStatus>;
}
