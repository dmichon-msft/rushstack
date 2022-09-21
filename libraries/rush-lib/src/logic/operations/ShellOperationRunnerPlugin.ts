// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { IPhase } from '../../api/CommandLineConfiguration';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { RushConstants } from '../RushConstants';
import { NullOperationRunner } from './NullOperationRunner';
import { ShellOperationRunner } from './CoreShellOperationRunner';
import { OperationStatus } from './OperationStatus';
import type {
  ICreateOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import { Operation } from './Operation';

const PLUGIN_NAME: 'ShellOperationRunnerPlugin' = 'ShellOperationRunnerPlugin';

/**
 * Core phased command plugin that provides the functionality for executing an operation via shell command.
 */
export class ShellOperationRunnerPlugin implements IPhasedCommandPlugin {
  public apply(hooks: PhasedCommandHooks): void {
    hooks.createOperations.tap(PLUGIN_NAME, createShellOperations);
  }
}

function createShellOperations(
  operations: Set<Operation>,
  context: ICreateOperationsContext
): Set<Operation> {
  const { isIncrementalBuildAllowed, rushConfiguration } = context;

  const customParametersByPhase: Map<IPhase, string[]> = new Map();

  function getCustomParameterValuesForPhase(phase: IPhase): ReadonlyArray<string> {
    let customParameterValues: string[] | undefined = customParametersByPhase.get(phase);
    if (!customParameterValues) {
      customParameterValues = [];
      for (const tsCommandLineParameter of phase.associatedParameters) {
        tsCommandLineParameter.appendToArgList(customParameterValues);
      }

      customParametersByPhase.set(phase, customParameterValues);
    }

    return customParameterValues;
  }

  for (const operation of operations) {
    const { associatedPhase: phase, associatedProject: project } = operation;

    if (phase && project && !operation.runner) {
      // This is a shell command. In the future, may consider having a property on the initial operation
      // to specify a runner type requested in rush-project.json
      const customParameterValues: ReadonlyArray<string> = getCustomParameterValuesForPhase(phase);

      const commandToRun: string | undefined = getScriptToRun(project, phase.name, customParameterValues);

      if (commandToRun === undefined && !phase.ignoreMissingScript) {
        throw new Error(
          `The project '${project.packageName}' does not define a '${phase.name}' command in the 'scripts' section of its package.json`
        );
      }

      const displayName: string = getDisplayName(phase, project);

      if (commandToRun) {
        operation.runner = new ShellOperationRunner({
          commandToRun: commandToRun || '',
          displayName,
          isIncrementalBuildAllowed,
          associatedPhase: phase,
          rushConfiguration,
          associatedProject: project
        });
      } else {
        // Empty build script indicates a no-op, so use a no-op runner
        operation.runner = new NullOperationRunner({
          name: displayName,
          result: OperationStatus.NoOp,
          silent: false
        });
      }
    }
  }

  return operations;
}

/**
 * When running a command from the "scripts" block in package.json, if the command
 * contains Unix-style path slashes and the OS is Windows, the package managers will
 * convert slashes to backslashes.  This is a complicated undertaking.  For example, they
 * need to convert "node_modules/bin/this && ./scripts/that --name keep/this"
 * to "node_modules\bin\this && .\scripts\that --name keep/this", and they don't want to
 * convert ANY of the slashes in "cmd.exe /c echo a/b".  NPM and PNPM use npm-lifecycle for this,
 * but it unfortunately has a dependency on the entire node-gyp kitchen sink.  Yarn has a
 * simplified implementation in fix-cmd-win-slashes.js, but it's not exposed as a library.
 *
 * Fundamentally NPM's whole feature seems misguided:  They start by inviting people to write
 * shell scripts that will be executed by wildly different shell languages (e.g. cmd.exe and Bash).
 * It's very tricky for a developer to guess what's safe to do without testing every OS.
 * Even simple path separators are not portable, so NPM added heuristics to figure out which
 * slashes are part of a path or not, and convert them.  These workarounds end up having tons
 * of special cases.  They probably could have implemented their own entire minimal cross-platform
 * shell language with less code and less confusion than npm-lifecycle's approach.
 *
 * We've deprecated shell operators inside package.json.  Instead, we advise people to move their
 * scripts into conventional script files, and put only a file path in package.json.  So, for
 * Rush's workaround here, we really only care about supporting the small set of cases seen in the
 * unit tests.  For anything that doesn't fit those patterns, we leave the string untouched
 * (i.e. err on the side of not breaking anything).  We could revisit this later if someone
 * complains about it, but so far nobody has.  :-)
 */
export function convertSlashesForWindows(command: string): string {
  // The first group will match everything up to the first space, "&", "|", "<", ">", or quote.
  // The second group matches the remainder.
  const commandRegExp: RegExp = /^([^\s&|<>"]+)(.*)$/;

  const match: RegExpMatchArray | null = commandRegExp.exec(command);
  if (match) {
    // Example input: "bin/blarg --path ./config/blah.json && a/b"
    // commandPart="bin/blarg"
    // remainder=" --path ./config/blah.json && a/b"
    const commandPart: string = match[1];
    const remainder: string = match[2];

    // If the command part already contains a backslash, then leave it alone
    if (commandPart.indexOf('\\') < 0) {
      // Replace all the slashes with backslashes, e.g. to produce:
      // "bin\blarg --path ./config/blah.json && a/b"
      //
      // NOTE: we don't attempt to process the path parameter or stuff after "&&"
      return commandPart.replace(/\//g, '\\') + remainder;
    }
  }

  // Don't change anything
  return command;
}

function getScriptToRun(
  rushProject: RushConfigurationProject,
  commandToRun: string,
  customParameterValues: ReadonlyArray<string>
): string | undefined {
  const { scripts } = rushProject.packageJson;

  const rawCommand: string | undefined | null = scripts?.[commandToRun];

  if (rawCommand === undefined || rawCommand === null) {
    return undefined;
  }

  if (!rawCommand) {
    return '';
  } else {
    const shellCommand: string = `${rawCommand} ${customParameterValues.join(' ')}`;
    return process.platform === 'win32' ? convertSlashesForWindows(shellCommand) : shellCommand;
  }
}

function getDisplayName(phase: IPhase, project: RushConfigurationProject): string {
  if (phase.isSynthetic) {
    // Because this is a synthetic phase, just use the project name because there aren't any other phases
    return project.packageName;
  } else {
    const phaseNameWithoutPrefix: string = phase.name.slice(RushConstants.phaseNamePrefix.length);
    return `${project.packageName} (${phaseNameWithoutPrefix})`;
  }
}
