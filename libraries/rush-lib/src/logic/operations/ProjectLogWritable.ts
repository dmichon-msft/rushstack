// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import path from 'path';
import { FileSystem, FileWriter, InternalError } from '@rushstack/node-core-library';
import { TerminalChunkKind, TerminalWritable, ITerminalChunk } from '@rushstack/terminal';
import { CollatedTerminal } from '@rushstack/stream-collator';

const LOG_EXTENSION_REGEX: RegExp = /\.log$/;

export class ProjectLogWritable extends TerminalWritable {
  private readonly _terminal: CollatedTerminal;

  private readonly _logPath: string;
  private readonly _errorLogPath: string;

  private _logWriter: FileWriter | undefined = undefined;
  private _errorLogWriter: FileWriter | undefined = undefined;

  public constructor(logFilePath: string, terminal: CollatedTerminal) {
    super();

    this._terminal = terminal;

    this._logPath = logFilePath;
    this._errorLogPath = logFilePath.replace(LOG_EXTENSION_REGEX, '.error.log');

    const logsDir: string = path.dirname(this._logPath);

    FileSystem.ensureFolder(logsDir);

    FileSystem.deleteFile(this._logPath);
    FileSystem.deleteFile(this._errorLogPath);

    this._logWriter = FileWriter.open(this._logPath);
  }

  protected onWriteChunk(chunk: ITerminalChunk): void {
    if (!this._logWriter) {
      throw new InternalError('Output file was closed');
    }
    // Both stderr and stdout get written to *.<phaseName>.log
    this._logWriter.write(chunk.text);

    if (chunk.kind === TerminalChunkKind.Stderr) {
      // Only stderr gets written to *.<phaseName>.error.log
      if (!this._errorLogWriter) {
        this._errorLogWriter = FileWriter.open(this._errorLogPath);
      }
      this._errorLogWriter.write(chunk.text);
    }
  }

  protected onClose(): void {
    if (this._logWriter) {
      try {
        this._logWriter.close();
      } catch (error) {
        this._terminal.writeStderrLine('Failed to close file handle for ' + this._logWriter.filePath);
      }
      this._logWriter = undefined;
    }

    if (this._errorLogWriter) {
      try {
        this._errorLogWriter.close();
      } catch (error) {
        this._terminal.writeStderrLine('Failed to close file handle for ' + this._errorLogWriter.filePath);
      }
      this._errorLogWriter = undefined;
    }
  }
}
