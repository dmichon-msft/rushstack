// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { CollatedTerminal } from '@rushstack/stream-collator';

import { TaskStatus } from '../TaskStatus';
import { ITaskBuilder, IBuilderContext } from '../ITaskBuilder';

export class MockBuilder implements ITaskBuilder {
  private readonly _action: ((terminal: CollatedTerminal) => Promise<TaskStatus>) | undefined;
  public readonly name: string;
  public readonly hadEmptyScript: boolean = false;
  public readonly isSkipAllowed: boolean = false;

  public constructor(name: string, action?: (terminal: CollatedTerminal) => Promise<TaskStatus>) {
    this.name = name;
    this._action = action;
  }

  public async executeAsync(context: IBuilderContext): Promise<TaskStatus> {
    let result: TaskStatus | void;
    if (this._action) {
      result = await this._action(context.collatedWriter.terminal);
    }
    return result ? result : TaskStatus.Success;
  }
}
