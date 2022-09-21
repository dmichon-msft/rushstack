// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { IPhase } from '../../api/CommandLineConfiguration';
import { IOperationRunner } from './IOperationRunner';
import { ProjectChangeAnalyzer } from '../ProjectChangeAnalyzer';
import { RushConstants } from '../RushConstants';
import { PackageNameParsers } from '../../api/PackageNameParsers';
import { OperationStatus } from './OperationStatus';

/**
 * Options for constructing a new Operation.
 * @alpha
 */
export interface IOperationOptions {
  /**
   * The Rush phase associated with this Operation, if any
   */
  phase?: IPhase | undefined;
  /**
   * The Rush project associated with this Operation, if any
   */
  project?: RushConfigurationProject | undefined;
  /**
   * When the scheduler is ready to process this `Operation`, the `runner` implements the actual work of
   * running the operation.
   */
  runner?: IOperationRunner | undefined;
  /**
   * Object that will be used to compute a hash of local inputs. The result will be combined with the hashes
   * of the `Operation`'s dependencies to get the final input state of the operation.
   */
  hasher?: IOperationStateHasher | undefined;
  /**
   * The results of the most recent execution of the operation.
   */
  lastState?: IOperationState;
}

/**
 * Represents the last execution state of an `Operation`.
 * @alpha
 */
export interface IOperationState {
  hash: string;
  status: OperationStatus;
  error: Error | undefined;
}

/**
 * Object responsible for computing the hash of the local inputs
 * @alpha
 */
export interface IOperationStateHasher {
  /**
   * Computes the hash of the local inputs to the operation. The result will be combined with the hashes of the
   * `Operation`'s dependencies to compute the final input state.
   * @param repositoryState - The state of all tracked files in the repository. Used to get the contributions
   *   of directly referenced source files, whether locally or in common directories.
   */
  getStateHashAsync(repositoryState: ProjectChangeAnalyzer): Promise<string>;
}

/**
 * The `Operation` class is a node in the dependency graph of work that needs to be scheduled by the
 * `OperationExecutionManager`. Each `Operation` has a `runner` member of type `IOperationRunner`, whose
 * implementation manages the actual process of running a single operation.
 *
 * The graph of `Operation` instances will be cloned into a separate execution graph after processing.
 *
 * @alpha
 */
export class Operation {
  /**
   * The Rush phase associated with this Operation, if any
   */
  public readonly associatedPhase: IPhase | undefined;

  /**
   * The Rush project associated with this Operation, if any
   */
  public readonly associatedProject: RushConfigurationProject | undefined;

  /**
   * A set of all operations which depend on this operation.
   */
  public readonly consumers: ReadonlySet<Operation> = new Set<Operation>();

  /**
   * A set of all dependencies which must be executed before this operation is complete.
   */
  public readonly dependencies: ReadonlySet<Operation> = new Set<Operation>();

  /**
   * If specified, disable caching for this operation
   */
  public disableCache: boolean = false;

  /**
   * The list of folders emitted by this operation, relative to the project root.
   */
  public outputFolderNames: string[] | undefined;

  /**
   * Object responsible for hashing local file inputs
   */
  public hasher: IOperationStateHasher | undefined;

  /**
   * When the scheduler is ready to process this `Operation`, the `runner` implements the actual work of
   * running the operation.
   */
  public runner: IOperationRunner | undefined;

  /**
   * If set, the scheduler may use this to decide to skip an operation if its inputs have not changed.
   */
  public lastState: IOperationState | undefined;

  /**
   * The weight for this operation. This scalar is the contribution of this operation to the
   * `criticalPathLength` calculation above. Modify to indicate the following:
   * - `weight` === 1: indicates that this operation has an average duration
   * - `weight` &gt; 1: indicates that this operation takes longer than average and so the scheduler
   *     should try to favor starting it over other, shorter operations. An example might be an operation that
   *     bundles an entire application and runs whole-program optimization.
   * - `weight` &lt; 1: indicates that this operation takes less time than average and so the scheduler
   *     should favor other, longer operations over it. An example might be an operation to unpack a cached
   *     output, or an operation using NullOperationRunner, which might use a value of 0.
   */
  public weight: number = 1;

  public constructor(options?: IOperationOptions) {
    this.associatedPhase = options?.phase;
    this.associatedProject = options?.project;
    this.runner = options?.runner;
    this.hasher = options?.hasher;
    this.lastState = options?.lastState;
  }

  /**
   * The name of this operation, for logging.
   */
  public get name(): string | undefined {
    return this.runner?.name;
  }

  /**
   * The path to which the log for this operation will be written.
   * @param defaultLogFolder - If no associated project, write logs to this folder.
   */
  public getLogFilePath(defaultLogFolder: string): string {
    const { associatedPhase, associatedProject } = this;

    const logDir: string = `${associatedProject?.projectFolder ?? defaultLogFolder}/${
      RushConstants.rushLogsFolderName
    }`;
    let logName: string | undefined;

    if (associatedProject) {
      logName = PackageNameParsers.permissive.getUnscopedName(associatedProject.packageName);

      if (associatedPhase) {
        logName += `.${associatedPhase.logFilenameIdentifier}`;
      }
    } else if (associatedPhase) {
      logName = associatedPhase.logFilenameIdentifier;
    } else {
      logName = `${this.name!}`.replace(/[^A-Za-z0-9_.+@-]/g, '_');
    }

    return `${logDir}/${logName}.log`;
  }

  /**
   * Adds the specified operation as a dependency and updates the consumer list.
   */
  public addDependency(dependency: Operation): void {
    // Cast internally to avoid adding the overhead of getters
    (this.dependencies as Set<Operation>).add(dependency);
    (dependency.consumers as Set<Operation>).add(this);
  }

  /**
   * Deletes the specified operation as a dependency and updates the consumer list.
   */
  public deleteDependency(dependency: Operation): void {
    // Cast internally to avoid adding the overhead of getters
    (this.dependencies as Set<Operation>).delete(dependency);
    (dependency.consumers as Set<Operation>).delete(this);
  }
}
