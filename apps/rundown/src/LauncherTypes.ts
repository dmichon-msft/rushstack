// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// eslint-disable-next-line @typescript-eslint/typedef
export const LauncherAction = {
  Snapshot: 'snapshot',
  Inspect: 'inspect'
} as const;
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace LauncherAction {
  export type Snapshot = typeof LauncherAction.Snapshot;
  export type Inspect = typeof LauncherAction.Inspect;
}
export type LauncherAction = typeof LauncherAction[keyof typeof LauncherAction];

export interface IIpcTraceRecord {
  importedModule: string;
  callingModule: string;
}

export interface IIpcTrace {
  id: 'trace';
  records: IIpcTraceRecord[];
}

export interface IIpcDone {
  id: 'done';
}

export type IpcMessage = IIpcTrace | IIpcDone;
