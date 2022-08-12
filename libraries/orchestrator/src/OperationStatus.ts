// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * Enumeration defining potential states of an operation
 * @beta
 */
export enum OperationStatus {
  /**
   * The Operation is currently in a dirty state
   */
  Ready = 'READY',
  /**
   * The Operation is currently executing
   */
  Executing = 'EXECUTING',
  /**
   * The Operation completed successfully and did not write to standard error
   */
  Success = 'SUCCESS',
  /**
   * The Operation completed successfully, but wrote to standard error
   */
  SuccessWithWarning = 'SUCCESS WITH WARNINGS',
  /**
   * The Operation failed
   */
  Failure = 'FAILURE',
  /**
   * The Operation could not be executed because one or more of its dependencies failed
   */
  Blocked = 'BLOCKED',
  /**
   * The Operation failed due to a retriable, transient issue, and is waiting before re-execution
   */
  WaitingForRetry = 'WAITING FOR RETRY',
  /**
   * The Operation was a no-op (for example, it had an empty script)
   */
  NoOp = 'NO OP'
}
