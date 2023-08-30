// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as crypto from 'crypto';
import {
  Async,
  ColorValue,
  InternalError,
  ITerminal,
  NewlineKind,
  Sort,
  Terminal
} from '@rushstack/node-core-library';
import { CollatedTerminal, CollatedWriter } from '@rushstack/stream-collator';
import { DiscardStdoutTransform, TextRewriterTransform } from '@rushstack/terminal';
import { SplitterTransform, TerminalWritable } from '@rushstack/terminal';

import { CollatedTerminalProvider } from '../../utilities/CollatedTerminalProvider';
import { OperationStatus } from './OperationStatus';
import { CobuildLock, ICobuildCompletedState } from '../cobuild/CobuildLock';
import { ProjectBuildCache } from '../buildCache/ProjectBuildCache';
import { RushConstants } from '../RushConstants';
import { IOperationSettings, RushProjectConfiguration } from '../../api/RushProjectConfiguration';
import { getHashesForGlobsAsync } from '../buildCache/getHashesForGlobsAsync';
import { ProjectLogWritable } from './ProjectLogWritable';
import { CobuildConfiguration } from '../../api/CobuildConfiguration';
import { DisjointSet } from '../cobuild/DisjointSet';
import { PeriodicCallback } from './PeriodicCallback';
import { NullTerminalProvider } from '../../utilities/NullTerminalProvider';

import type { Operation } from './Operation';
import type { IOperationRunnerContext } from './IOperationRunner';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import type {
  ICreateOperationsContext,
  IPhasedCommandPlugin,
  PhasedCommandHooks
} from '../../pluginFramework/PhasedCommandHooks';
import type { IPhase } from '../../api/CommandLineConfiguration';
import type { IRawRepoState, ProjectChangeAnalyzer } from '../ProjectChangeAnalyzer';
import { OperationMetadataManager } from './OperationMetadataManager';
import type { BuildCacheConfiguration } from '../../api/BuildCacheConfiguration';
import type { IOperationExecutionResult } from './IOperationExecutionResult';
import type { OperationExecutionRecord } from './OperationExecutionRecord';

const PLUGIN_NAME: 'CacheablePhasedOperationPlugin' = 'CacheablePhasedOperationPlugin';
const PERIODIC_CALLBACK_INTERVAL_IN_SECONDS: number = 10;

export interface IProjectDeps {
  files: { [filePath: string]: string };
  arguments: string;
}

interface IOperationBuildCacheContext {
  isCacheWriteAllowed: boolean;
  isCacheReadAllowed: boolean;
  projectBuildCache: ProjectBuildCache | undefined;
  cobuildLock: CobuildLock | undefined;
  // The id of the cluster contains the operation, used when acquiring cobuild lock
  cobuildClusterId: string | undefined;
  periodicCallback: PeriodicCallback;
  cacheRestored: boolean;

  cacheDisabledReason: string | undefined;
  logPath: string;
  errorLogPath: string;
  operationMetadataManager: OperationMetadataManager;
}

export interface ICacheableOperationPluginOptions {
  allowWarningsInSuccessfulBuild: boolean;
  buildCacheConfiguration: BuildCacheConfiguration;
  cobuildConfiguration: CobuildConfiguration | undefined;
  isIncrementalBuildAllowed: boolean;
  terminal: ITerminal;
}

interface ITerminalAndMaybeProjectLogWritable {
  terminal: ITerminal;
  projectLogWritable?: ProjectLogWritable | undefined;
}

export class CacheableOperationPlugin implements IPhasedCommandPlugin {
  private _buildCacheContextByOperation: Map<
    Operation,
    IOperationBuildCacheContext
  > = new Map();

  private readonly _options: ICacheableOperationPluginOptions;

  public constructor(options: ICacheableOperationPluginOptions) {
    this._options = options;
  }

  public apply(hooks: PhasedCommandHooks): void {
    const {
      allowWarningsInSuccessfulBuild,
      buildCacheConfiguration,
      cobuildConfiguration,
      isIncrementalBuildAllowed,
      terminal
    } = this._options;

    const { _buildCacheContextByOperation: buildCacheContextByOperation } = this;

    async function beforeExecuteOperationsAsync(
      this: void,
      recordByOperation: Map<Operation, IOperationExecutionResult>,
      context: ICreateOperationsContext
    ): Promise<void> {
      const {
        projectConfigurations,
        projectChangeAnalyzer
      } = context;

      let disjointSet: DisjointSet<Operation> | undefined;
      if (cobuildConfiguration?.cobuildEnabled) {
        disjointSet = new DisjointSet();
      }

      await Async.forEachAsync(recordByOperation, async ([operation, record]: [Operation, IOperationExecutionResult]) => {
        const { associatedProject, associatedPhase, runner } = operation;
        if (!associatedProject || !associatedPhase || !runner) {
          return;
        }

        const { name: phaseName } = associatedPhase;

        const projectConfiguration: RushProjectConfiguration | undefined =
          projectConfigurations.get(associatedProject);

        // This value can *currently* be cached per-project, but in the future the list of files will vary
        // depending on the selected phase.
        const fileHashes: Map<string, string> | undefined =
          await projectChangeAnalyzer._tryGetProjectDependenciesAsync(associatedProject, terminal);

        if (!fileHashes) {
          throw new Error(
            `Build cache is only supported if running in a Git repository. Either disable the build cache or run Rush in a Git repository.`
          );
        }

        const operationMetadataManager: OperationMetadataManager = new OperationMetadataManager({
          phase: associatedPhase,
          rushProject: associatedProject
        });

        const cacheDisabledReason: string | undefined = projectConfiguration
          ? projectConfiguration.getCacheDisabledReason(fileHashes.keys(), phaseName)
          : `Project does not have a ${RushConstants.rushProjectConfigFilename} configuration file, ` +
            'or one provided by a rig, so it does not support caching.';

        const { logPath, errorLogPath } = ProjectLogWritable.getLogFilePaths({
          project: associatedProject,
          logFilenameIdentifier: associatedPhase.logFilenameIdentifier
        });

        const buildCacheContext: IOperationBuildCacheContext = {
          // Supports cache writes by default.
          isCacheWriteAllowed: true,
          isCacheReadAllowed: isIncrementalBuildAllowed,
          projectBuildCache: undefined,
          cobuildLock: undefined,
          cobuildClusterId: undefined,
          periodicCallback: new PeriodicCallback({
            interval: PERIODIC_CALLBACK_INTERVAL_IN_SECONDS * 1000
          }),
          cacheDisabledReason,
          logPath,
          errorLogPath,
          operationMetadataManager,
          cacheRestored: false
        };

        disjointSet?.add(operation);

        // Upstream runners may mutate the property of build cache context for downstream runners
        buildCacheContextByOperation.set(operation, buildCacheContext);

        const operationSettings: IOperationSettings | undefined =
          projectConfiguration?.operationSettingsByOperationName.get(phaseName);

        const additionalProjectOutputFilePaths: ReadonlyArray<string> = operationMetadataManager.relativeFilepaths;

        if (!cacheDisabledReason && operationSettings) {
          const projectOutputFolderNames: ReadonlyArray<string> = operationSettings.outputFolderNames || [];

          const additionalContext: Record<string, string> = {};
          if (operationSettings.dependsOnEnvVars) {
            for (const varName of operationSettings.dependsOnEnvVars) {
              additionalContext['$' + varName] = process.env[varName] || '';
            }
          }

          if (operationSettings.dependsOnAdditionalFiles) {
            const repoState: IRawRepoState | undefined =
              await projectChangeAnalyzer._ensureInitializedAsync(terminal);

            const additionalFiles: Map<string, string> = await getHashesForGlobsAsync(
              operationSettings.dependsOnAdditionalFiles,
              associatedProject.projectFolder,
              repoState
            );

            terminal.writeDebugLine(
              `Including additional files to calculate build cache hash for ${runner.name}:\n  ${Array.from(
                additionalFiles.keys()
              ).join('\n  ')} `
            );

            for (const [filePath, fileHash] of additionalFiles) {
              additionalContext['file://' + filePath] = fileHash;
            }
          }

          buildCacheContext.projectBuildCache = await ProjectBuildCache.tryGetProjectBuildCache({
            project: associatedProject,
            projectOutputFolderNames,
            additionalProjectOutputFilePaths,
            additionalContext,
            buildCacheConfiguration,
            configHash: runner.getConfigHash(),
            projectChangeAnalyzer,
            phaseName,
            terminal
          });
        }
      });

      if (disjointSet) {
        // If disjoint set exists, connect build cache disabled project with its consumers
        for (const [operation, { cacheDisabledReason }] of buildCacheContextByOperation) {
          const { associatedProject: project, associatedPhase: phase } = operation;
          if (project && phase) {
            if (cacheDisabledReason) {
              /**
               * Group the project build cache disabled with its consumers. This won't affect too much in
               * a monorepo with high build cache coverage.
               *
               * The mental model is that if X disables the cache, and Y depends on X, then:
               *   1. Y must be built by the same VM that build X;
               *   2. OR, Y must be rebuilt on each VM that needs it.
               * Approach 1 is probably the better choice.
               */
              for (const consumer of operation.consumers) {
                disjointSet?.union(operation, consumer);
              }
            }
          }
        }

        for (const set of disjointSet.getAllSets()) {
          if (cobuildConfiguration?.cobuildEnabled && cobuildConfiguration.cobuildContextId) {
            // Get a deterministic ordered array of operations, which is important to get a deterministic cluster id.
            const groupedOperations: Operation[] = Array.from(set);
            Sort.sortBy(groupedOperations, (operation: Operation) => {
              return operation.name;
            });

            // Generates cluster id, cluster id comes from the project folder and phase name of all operations in the same cluster.
            const hash: crypto.Hash = crypto.createHash('sha1');
            for (const record of groupedOperations) {
              const { associatedPhase: phase, associatedProject: project } = record;
              if (project && phase) {
                hash.update(project.projectRelativeFolder);
                hash.update(RushConstants.hashDelimiter);
                hash.update(phase.name);
                hash.update(RushConstants.hashDelimiter);
              }
            }
            const cobuildClusterId: string = hash.digest('hex');

            // Assign same cluster id to all operations in the same cluster.
            for (const operation of groupedOperations) {
              const buildCacheContext: IOperationBuildCacheContext | undefined =
                buildCacheContextByOperation.get(operation);
              if (!buildCacheContext) {
                throw new InternalError(`Missing build cache context for "${operation.name}"`);
              }
              buildCacheContext.cobuildClusterId = cobuildClusterId;
            }
          }
        }
      }
    }

    hooks.beforeExecuteOperations.tapPromise(
      PLUGIN_NAME,
      beforeExecuteOperationsAsync
    );

    hooks.beforeExecuteOperation.tapPromise(
      PLUGIN_NAME,
      async (record: IOperationRunnerContext & IOperationExecutionResult): Promise<OperationStatus | undefined> => {
        const {
          operation
        } = record;

        const buildCacheContext: IOperationBuildCacheContext | undefined =
          buildCacheContextByOperation.get(operation);

        if (!buildCacheContext) {
          return;
        }

        const {
          associatedProject: project,
          associatedPhase: phase
        } = operation;

        const cacheable: boolean | undefined = operation.runner?.cacheable;

        if (!cacheable || !project || !phase) {
          return;
        }

        const runBeforeExecute = async ({
          projectChangeAnalyzer,
          buildCacheConfiguration,
          cobuildConfiguration,
          selectedPhases,
          project,
          phase,
          operationMetadataManager,
          buildCacheContext,
          record
        }: {
          projectChangeAnalyzer: ProjectChangeAnalyzer;
          buildCacheConfiguration: BuildCacheConfiguration;
          cobuildConfiguration: CobuildConfiguration | undefined;
          selectedPhases: ReadonlySet<IPhase>;
          project: RushConfigurationProject;
          phase: IPhase;
          operationMetadataManager: OperationMetadataManager | undefined;
          buildCacheContext: IOperationBuildCacheContext;
          record: OperationExecutionRecord;
        }): Promise<OperationStatus | undefined> => {
          const buildCacheTerminal: ITerminal = _getBuildCacheTerminal({
            record,
            buildCacheConfiguration,
            rushProject: project,
            logFilenameIdentifier: phase.logFilenameIdentifier,
            quietMode: record.quietMode,
            debugMode: record.debugMode
          });
          buildCacheContext.buildCacheTerminal = buildCacheTerminal;

          const commandToRun: string = record.runner.getConfigHash() || '';

          // No-op command
          if (!commandToRun) {
            return OperationStatus.NoOp;
          }

          let projectBuildCache: ProjectBuildCache | undefined = await this._tryGetProjectBuildCacheAsync({
            record,
            buildCacheConfiguration,
            rushProject: project,
            phase,
            selectedPhases,
            projectChangeAnalyzer,
            commandToRun,
            terminal: buildCacheTerminal,
            trackedProjectFiles,
            operationMetadataManager
          });

          // Try to acquire the cobuild lock
          let cobuildLock: CobuildLock | undefined;
          if (cobuildConfiguration?.cobuildEnabled) {
            if (
              cobuildConfiguration?.cobuildLeafProjectLogOnlyAllowed &&
              record.consumers.size === 0 &&
              !projectBuildCache
            ) {
              // When the leaf project log only is allowed and the leaf project is build cache "disabled", try to get
              // a log files only project build cache
              projectBuildCache = await this._tryGetLogOnlyProjectBuildCacheAsync({
                buildCacheConfiguration,
                cobuildConfiguration,
                record,
                rushProject: project,
                phase,
                projectChangeAnalyzer,
                commandToRun,
                terminal: buildCacheTerminal,
                trackedProjectFiles,
                operationMetadataManager
              });
              if (projectBuildCache) {
                buildCacheTerminal.writeVerboseLine(
                  `Log files only build cache is enabled for the project "${project.packageName}" because the cobuild leaf project log only is allowed`
                );
              } else {
                buildCacheTerminal.writeWarningLine(
                  `Failed to get log files only build cache for the project "${project.packageName}"`
                );
              }
            }

            cobuildLock = await this._tryGetCobuildLockAsync({
              record,
              projectBuildCache,
              cobuildConfiguration,
              packageName: project.packageName,
              phaseName: phase.name
            });
          }

          // eslint-disable-next-line require-atomic-updates -- we are mutating the build cache context intentionally
          buildCacheContext.cobuildLock = cobuildLock;

          // If possible, we want to skip this operation -- either by restoring it from the
          // cache, if caching is enabled, or determining that the project
          // is unchanged (using the older incremental execution logic). These two approaches,
          // "caching" and "skipping", are incompatible, so only one applies.
          //
          // Note that "caching" and "skipping" take two different approaches
          // to tracking dependents:
          //
          //   - For caching, "isCacheReadAllowed" is set if a project supports
          //     incremental builds, and determining whether this project or a dependent
          //     has changed happens inside the hashing logic.

          const { logPath, errorLogPath } = ProjectLogWritable.getLogFilePaths({
            project,
            logFilenameIdentifier: phase.logFilenameIdentifier
          });
          const restoreCacheAsync = async (
            projectBuildCache: ProjectBuildCache | undefined,
            specifiedCacheId?: string
          ): Promise<boolean> => {
            const restoreFromCacheSuccess: boolean | undefined =
              await projectBuildCache?.tryRestoreFromCacheAsync(buildCacheTerminal, specifiedCacheId);
            if (restoreFromCacheSuccess) {
              buildCacheContext.cacheRestored = true;
              // Restore the original state of the operation without cache
              await operationMetadataManager?.tryRestoreAsync({
                terminal: buildCacheTerminal,
                logPath,
                errorLogPath
              });
            }
            return !!restoreFromCacheSuccess;
          };
          if (cobuildLock) {
            // handling rebuilds. "rush rebuild" or "rush retest" command will save operations to
            // the build cache once completed, but does not retrieve them (since the "incremental"
            // flag is disabled). However, we still need a cobuild to be able to retrieve a finished
            // build from another cobuild in this case.
            const cobuildCompletedState: ICobuildCompletedState | undefined =
              await cobuildLock.getCompletedStateAsync();
            if (cobuildCompletedState) {
              const { status, cacheId } = cobuildCompletedState;

              const restoreFromCacheSuccess: boolean = await restoreCacheAsync(
                cobuildLock.projectBuildCache,
                cacheId
              );

              if (restoreFromCacheSuccess) {
                if (cobuildCompletedState) {
                  return cobuildCompletedState.status;
                }
                return status;
              }
            }
          } else if (buildCacheContext.isCacheReadAllowed) {
            const restoreFromCacheSuccess: boolean = await restoreCacheAsync(projectBuildCache);

            if (restoreFromCacheSuccess) {
              return OperationStatus.FromCache;
            }
          }

          if (buildCacheContext.isCacheWriteAllowed && cobuildLock) {
            const acquireSuccess: boolean = await cobuildLock.tryAcquireLockAsync();
            if (acquireSuccess) {
              const { periodicCallback } = buildCacheContext;
              periodicCallback.addCallback(async () => {
                await cobuildLock?.renewLockAsync();
              });
              periodicCallback.start();
            } else {
              // failed to acquire the lock, mark current operation to remote executing
              return OperationStatus.RemoteExecuting;
            }
          }
        };

        try {
          const earlyReturnStatus: OperationStatus | undefined = await runBeforeExecute({
            projectChangeAnalyzer,
            buildCacheConfiguration,
            cobuildConfiguration,
            selectedPhases,
            project,
            phase,
            operationMetadataManager,
            buildCacheContext,
            record
          });
          return earlyReturnStatus;
        } catch (e) {
          buildCacheContext.buildCacheProjectLogWritable?.close();
          throw e;
        }
      }
    );

    hooks.afterExecuteOperation.tapPromise(
      PLUGIN_NAME,
      async (runnerContext: IOperationRunnerContext): Promise<void> => {
        const record: OperationExecutionRecord = runnerContext as OperationExecutionRecord;
        const {
          status,
          operation,
          stopwatch,
          _operationMetadataManager: operationMetadataManager,
          associatedProject: project,
          associatedPhase: phase
        } = record;

        if (!project || !phase) {
          return;
        }

        // No need to run for the following operation status
        switch (record.status) {
          case OperationStatus.NoOp:
          case OperationStatus.RemoteExecuting: {
            return;
          }
          default: {
            break;
          }
        }

        const buildCacheContext: IOperationBuildCacheContext | undefined =
          buildCacheContextByOperation.get(operation);

        if (!buildCacheContext) {
          return;
        }
        const {
          cobuildLock,
          projectBuildCache,
          isCacheWriteAllowed,
          buildCacheTerminal,
          cacheRestored
        } = buildCacheContext;

        try {
          if (!cacheRestored) {
            // Save the metadata to disk
            const { logFilenameIdentifier } = phase;
            const { duration: durationInSeconds } = stopwatch;
            const { logPath, errorLogPath } = ProjectLogWritable.getLogFilePaths({
              project,
              logFilenameIdentifier
            });
            await operationMetadataManager?.saveAsync({
              durationInSeconds,
              cobuildContextId: cobuildLock?.cobuildConfiguration.cobuildContextId,
              cobuildRunnerId: cobuildLock?.cobuildConfiguration.cobuildRunnerId,
              logPath,
              errorLogPath
            });
          }

          if (!buildCacheTerminal) {
            // This should not happen
            throw new InternalError(`Build Cache Terminal is not created`);
          }

          let setCompletedStatePromiseFunction: (() => Promise<void> | undefined) | undefined;
          let setCacheEntryPromise: (() => Promise<boolean> | undefined) | undefined;
          if (cobuildLock && isCacheWriteAllowed) {
            const { cacheId, contextId } = cobuildLock.cobuildContext;

            const finalCacheId: string =
              status === OperationStatus.Failure ? `${cacheId}-${contextId}-failed` : cacheId;
            switch (status) {
              case OperationStatus.SuccessWithWarning:
              case OperationStatus.Success:
              case OperationStatus.Failure: {
                const currentStatus: ICobuildCompletedState['status'] = status;
                setCompletedStatePromiseFunction = () => {
                  return cobuildLock?.setCompletedStateAsync({
                    status: currentStatus,
                    cacheId: finalCacheId
                  });
                };
                setCacheEntryPromise = () =>
                  cobuildLock.projectBuildCache.trySetCacheEntryAsync(buildCacheTerminal, finalCacheId);
              }
            }
          }

          const taskIsSuccessful: boolean =
            status === OperationStatus.Success ||
            (status === OperationStatus.SuccessWithWarning &&
              record.runner.warningsAreAllowed &&
              allowWarningsInSuccessfulBuild);

          // If the command is successful, we can calculate project hash, and no dependencies were skipped,
          // write a new cache entry.
          if (!setCacheEntryPromise && taskIsSuccessful && isCacheWriteAllowed && projectBuildCache) {
            setCacheEntryPromise = () => projectBuildCache.trySetCacheEntryAsync(buildCacheTerminal);
          }
          if (!cacheRestored) {
            const cacheWriteSuccess: boolean | undefined = await setCacheEntryPromise?.();
            await setCompletedStatePromiseFunction?.();

            if (cacheWriteSuccess === false && status === OperationStatus.Success) {
              record.status = OperationStatus.SuccessWithWarning;
            }
          }
        } finally {
          buildCacheContext.buildCacheProjectLogWritable?.close();
          buildCacheContext.periodicCallback.stop();
        }
      }
    );

    hooks.afterExecuteOperation.tap(PLUGIN_NAME, (record: IOperationExecutionResult): void => {
      const { operation } = record;

      const buildCacheContext: IOperationBuildCacheContext | undefined =
        buildCacheContextByOperation.get(record.operation);

      if (!buildCacheContext) {
        return;
      }

      // Status changes to direct dependents
      let blockCacheWrite: boolean = !buildCacheContext?.isCacheWriteAllowed;

      switch (record.status) {
        case OperationStatus.Skipped: {
          // Skipping means cannot guarantee integrity, so prevent cache writes in dependents.
          blockCacheWrite = true;
          break;
        }
      }

      // Apply status changes to direct dependents
      for (const consumer of operation.consumers) {
        const consumerBuildCacheContext: IOperationBuildCacheContext | undefined =
          buildCacheContextByOperation.get(consumer);
        if (consumerBuildCacheContext) {
          if (blockCacheWrite) {
            consumerBuildCacheContext.isCacheWriteAllowed = false;
          }
        }
      }
    });

    hooks.afterExecuteOperations.tapPromise(PLUGIN_NAME, async () => {
      this._buildCacheContextByOperation.clear();
    });
  }
}

function _getBuildCacheContextByOperationOrThrow(
  buildCacheContextByOperation: Map<Operation, IOperationBuildCacheContext>,
  operation: Operation
): IOperationBuildCacheContext {
  const buildCacheContext: IOperationBuildCacheContext | undefined =
    buildCacheContextByOperation.get(operation);
  if (!buildCacheContext) {
    // This should not happen
    throw new InternalError(`Build cache context for operation ${operation.name} should be defined`);
  }
  return buildCacheContext;
}

private async _tryGetProjectBuildCacheEnabledAsync({
  buildCacheConfiguration,
  rushProject,
  commandName
}: {
  buildCacheConfiguration: BuildCacheConfiguration;
  rushProject: RushConfigurationProject;
  commandName: string;
}): Promise<boolean> {
  const nullTerminalProvider: NullTerminalProvider = new NullTerminalProvider();
  // This is a silent terminal
  const terminal: ITerminal = new Terminal(nullTerminalProvider);

  if (buildCacheConfiguration && buildCacheConfiguration.buildCacheEnabled) {
    const projectConfiguration: RushProjectConfiguration | undefined =
      await RushProjectConfiguration.tryLoadForProjectAsync(rushProject, terminal);
    if (projectConfiguration && projectConfiguration.disableBuildCacheForProject) {
      const operationSettings: IOperationSettings | undefined =
        projectConfiguration.operationSettingsByOperationName.get(commandName);
      if (operationSettings && !operationSettings.disableBuildCacheForOperation) {
        return true;
      }
    }
  }
  return false;
}

private async _tryGetProjectBuildCacheAsync({
  buildCacheConfiguration,
  record,
  rushProject,
  phase,
  selectedPhases,
  projectChangeAnalyzer,
  commandToRun,
  terminal,
  trackedProjectFiles,
  operationMetadataManager
}: {
  record: OperationExecutionRecord;
  buildCacheConfiguration: BuildCacheConfiguration | undefined;
  rushProject: RushConfigurationProject;
  phase: IPhase;
  selectedPhases: Iterable<IPhase>;
  projectChangeAnalyzer: ProjectChangeAnalyzer;
  commandToRun: string;
  terminal: ITerminal;
  trackedProjectFiles: string[] | undefined;
  operationMetadataManager: OperationMetadataManager | undefined;
}): Promise<ProjectBuildCache | undefined> {
  const buildCacheContext: IOperationBuildCacheContext =
    this._getBuildCacheContextByOperationOrThrow(record.operation);
  if (!buildCacheContext.projectBuildCache) {
    if (buildCacheConfiguration && buildCacheConfiguration.buildCacheEnabled) {
      const projectConfiguration: RushProjectConfiguration | undefined =
        await RushProjectConfiguration.tryLoadForProjectAsync(rushProject, terminal);
      if (projectConfiguration) {
        const commandName: string = phase.name;
        projectConfiguration.validatePhaseConfiguration(selectedPhases, terminal);
        if (projectConfiguration.disableBuildCacheForProject) {
          terminal.writeVerboseLine('Caching has been disabled for this project.');
        } else {
          const operationSettings: IOperationSettings | undefined =
            projectConfiguration.operationSettingsByOperationName.get(commandName);
          if (!operationSettings) {
            terminal.writeVerboseLine(
              `This project does not define the caching behavior of the "${commandName}" command, so caching has been disabled.`
            );
          } else if (operationSettings.disableBuildCacheForOperation) {
            terminal.writeVerboseLine(
              `Caching has been disabled for this project's "${commandName}" command.`
            );
          } else {
            const projectOutputFolderNames: ReadonlyArray<string> =
              operationSettings.outputFolderNames || [];
            const additionalProjectOutputFilePaths: ReadonlyArray<string> = [
              ...(operationMetadataManager?.relativeFilepaths || [])
            ];
            const additionalContext: Record<string, string> = {};
            if (operationSettings.dependsOnEnvVars) {
              for (const varName of operationSettings.dependsOnEnvVars) {
                additionalContext['$' + varName] = process.env[varName] || '';
              }
            }

            if (operationSettings.dependsOnAdditionalFiles) {
              const repoState: IRawRepoState | undefined =
                await projectChangeAnalyzer._ensureInitializedAsync(terminal);

              const additionalFiles: Map<string, string> = await getHashesForGlobsAsync(
                operationSettings.dependsOnAdditionalFiles,
                rushProject.projectFolder,
                repoState
              );

              terminal.writeDebugLine(
                `Including additional files to calculate build cache hash:\n  ${Array.from(
                  additionalFiles.keys()
                ).join('\n  ')} `
              );

              for (const [filePath, fileHash] of additionalFiles) {
                additionalContext['file://' + filePath] = fileHash;
              }
            }
            buildCacheContext.projectBuildCache = await ProjectBuildCache.tryGetProjectBuildCache({
              project: rushProject,
              projectOutputFolderNames,
              additionalProjectOutputFilePaths,
              additionalContext,
              buildCacheConfiguration,
              terminal,
              configHash: commandToRun,
              trackedProjectFiles: trackedProjectFiles,
              projectChangeAnalyzer: projectChangeAnalyzer,
              phaseName: phase.name
            });
          }
        }
      } else {
        terminal.writeVerboseLine(
          `Project does not have a ${RushConstants.rushProjectConfigFilename} configuration file, ` +
            'or one provided by a rig, so it does not support caching.'
        );
      }
    }
  }

  return buildCacheContext.projectBuildCache;
}

// Get a ProjectBuildCache only cache/restore log files
private async _tryGetLogOnlyProjectBuildCacheAsync({
  record,
  rushProject,
  terminal,
  commandToRun,
  buildCacheConfiguration,
  cobuildConfiguration,
  phase,
  trackedProjectFiles,
  projectChangeAnalyzer,
  operationMetadataManager
}: {
  record: OperationExecutionRecord;
  buildCacheConfiguration: BuildCacheConfiguration;
  cobuildConfiguration: CobuildConfiguration;
  rushProject: RushConfigurationProject;
  phase: IPhase;
  commandToRun: string;
  terminal: ITerminal;
  trackedProjectFiles: string[] | undefined;
  projectChangeAnalyzer: ProjectChangeAnalyzer;
  operationMetadataManager: OperationMetadataManager | undefined;
}): Promise<ProjectBuildCache | undefined> {
  const buildCacheContext: IOperationBuildCacheContext =
    this._getBuildCacheContextByOperationOrThrow(record.operation);
  if (buildCacheConfiguration.buildCacheEnabled) {
    const projectConfiguration: RushProjectConfiguration | undefined =
      await RushProjectConfiguration.tryLoadForProjectAsync(rushProject, terminal);

    let projectOutputFolderNames: ReadonlyArray<string> = [];
    const additionalProjectOutputFilePaths: ReadonlyArray<string> = [
      ...(operationMetadataManager?.relativeFilepaths || [])
    ];
    const additionalContext: Record<string, string> = {
      // Force the cache to be a log files only cache
      logFilesOnly: '1'
    };
    if (cobuildConfiguration.cobuildContextId) {
      additionalContext.cobuildContextId = cobuildConfiguration.cobuildContextId;
    }

    if (projectConfiguration) {
      const commandName: string = phase.name;
      const operationSettings: IOperationSettings | undefined =
        projectConfiguration.operationSettingsByOperationName.get(commandName);
      if (operationSettings) {
        if (operationSettings.outputFolderNames) {
          projectOutputFolderNames = operationSettings.outputFolderNames;
        }
        if (operationSettings.dependsOnEnvVars) {
          for (const varName of operationSettings.dependsOnEnvVars) {
            additionalContext['$' + varName] = process.env[varName] || '';
          }
        }

        if (operationSettings.dependsOnAdditionalFiles) {
          const repoState: IRawRepoState | undefined = await projectChangeAnalyzer._ensureInitializedAsync(
            terminal
          );

          const additionalFiles: Map<string, string> = await getHashesForGlobsAsync(
            operationSettings.dependsOnAdditionalFiles,
            rushProject.projectFolder,
            repoState
          );

          for (const [filePath, fileHash] of additionalFiles) {
            additionalContext['file://' + filePath] = fileHash;
          }
        }
      }
    }

    const projectBuildCache: ProjectBuildCache | undefined =
      await ProjectBuildCache.tryGetProjectBuildCache({
        project: rushProject,
        projectOutputFolderNames,
        additionalProjectOutputFilePaths,
        additionalContext,
        buildCacheConfiguration,
        terminal,
        configHash: commandToRun,
        trackedProjectFiles,
        projectChangeAnalyzer: projectChangeAnalyzer,
        phaseName: phase.name
      });
    buildCacheContext.projectBuildCache = projectBuildCache;
    return projectBuildCache;
  }
}

async function _tryGetCobuildLockAsync({
  cobuildConfiguration,
  buildCacheContext,
  projectBuildCache,
  packageName,
  phaseName
}: {
  cobuildConfiguration: CobuildConfiguration | undefined;
  buildCacheContext: IOperationBuildCacheContext;
  projectBuildCache: ProjectBuildCache | undefined;
  packageName: string;
  phaseName: string;
}): Promise<CobuildLock | undefined> {
  if (!buildCacheContext.cobuildLock) {
    if (projectBuildCache && cobuildConfiguration && cobuildConfiguration.cobuildEnabled) {
      if (!buildCacheContext.cobuildClusterId) {
        // This should not happen
        throw new InternalError('Cobuild cluster id is not defined');
      }
      buildCacheContext.cobuildLock = new CobuildLock({
        cobuildConfiguration,
        projectBuildCache,
        cobuildClusterId: buildCacheContext.cobuildClusterId,
        lockExpireTimeInSeconds: PERIODIC_CALLBACK_INTERVAL_IN_SECONDS * 3,
        packageName,
        phaseName
      });
    }
  }
  return buildCacheContext.cobuildLock;
}

function _getBuildCacheTerminal({
  record,
  buildCacheEnabled,
  rushProject,
  logFilenameIdentifier,
  quietMode,
  debugMode
}: {
  record: OperationExecutionRecord;
  buildCacheEnabled: boolean;
  rushProject: RushConfigurationProject;
  logFilenameIdentifier: string;
  quietMode: boolean;
  debugMode: boolean;
}): ITerminal {
  const buildCacheContext: IOperationBuildCacheContext =
    this._getBuildCacheContextByOperationOrThrow(record.operation);
  if (!buildCacheContext.buildCacheTerminal) {
    buildCacheContext.buildCacheTerminal = _createBuildCacheTerminal({
      record,
      buildCacheConfiguration,
      rushProject,
      logFilenameIdentifier,
      quietMode,
      debugMode
    });
  } else if (buildCacheContext.buildCacheProjectLogWritable?.isOpen === false) {
    // The ProjectLogWritable is closed, re-create one
    buildCacheContext.buildCacheTerminal = _createBuildCacheTerminal({
      record,
      buildCacheConfiguration,
      rushProject,
      logFilenameIdentifier,
      quietMode,
      debugMode
    });
  }

  return buildCacheContext.buildCacheTerminal;
}

function _createBuildCacheTerminal({
  record,
  buildCacheEnabled,
  logFilenameIdentifier,
  quietMode,
  debugMode
}: {
  record: IOperationRunnerContext & IOperationExecutionResult;
  buildCacheEnabled: boolean;
  logFilenameIdentifier: string;
  quietMode: boolean;
  debugMode: boolean;
}): ITerminalAndMaybeProjectLogWritable {
  if (record.operation.runner?.silent) {
    const nullTerminalProvider: NullTerminalProvider = new NullTerminalProvider();
    return {
      terminal: new Terminal(nullTerminalProvider)
    };
  }

  const {
    associatedProject: rushProject
  } = record.operation;

  // This creates the writer, only do this if necessary.
  const collatedWriter: CollatedWriter = record.collatedWriter;
  const projectLogWritable: ProjectLogWritable | undefined = buildCacheEnabled ? new ProjectLogWritable(
    rushProject!,
    collatedWriter,
    logFilenameIdentifier,
  ) : undefined;

  let cacheConsoleWritable: TerminalWritable = collatedWriter;
  if (quietMode) {
    const discardTransform: DiscardStdoutTransform = new DiscardStdoutTransform({
      destination: collatedWriter
    });
    const normalizeNewlineTransform: TextRewriterTransform = new TextRewriterTransform({
      destination: discardTransform,
      normalizeNewlines: NewlineKind.Lf,
      ensureNewlineAtEnd: true
    });
    cacheConsoleWritable = normalizeNewlineTransform;
  }

  const cacheCollatedTerminal: CollatedTerminal = new CollatedTerminal(projectLogWritable ? new SplitterTransform({
    destinations: [cacheConsoleWritable, projectLogWritable]
  }) : cacheConsoleWritable);

  const buildCacheTerminalProvider: CollatedTerminalProvider = new CollatedTerminalProvider(
    cacheCollatedTerminal,
    {
      debugEnabled: debugMode
    }
  );
  const terminal: ITerminal = new Terminal(buildCacheTerminalProvider);
  return {
    terminal,
    projectLogWritable
  };
}