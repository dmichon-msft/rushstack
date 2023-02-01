const CONTROL_C: '\x03' = '\x03';
const CONTROL_D: '\x04' = '\x04';
const CONTROL_U: '\x15' = '\x15';
const ENTER: '\r' = '\r';

async function watch(
  initialGlobalConfig,
  contexts,
  outputStream,
  hasteMapInstances,
  stdin = process.stdin,
  hooks = new (_jestWatcher().JestHook)(),
  filter
) {
  // `globalConfig` will be constantly updated and reassigned as a result of
  // watch mode interactions.
  let globalConfig = initialGlobalConfig;
  let activePlugin;

  globalConfig = updateGlobalConfig(globalConfig, {
    mode: globalConfig.watch ? 'watch' : 'watchAll',
    passWithNoTests: true
  });

  const updateConfigAndRun = ({
    mode,
    onlyFailures,
    testNamePattern,
    testPathPattern,
    updateSnapshot
  } = {}) => {
    const previousUpdateSnapshot = globalConfig.updateSnapshot;
    globalConfig = updateGlobalConfig(globalConfig, {
      mode,
      onlyFailures,
      testNamePattern,
      testPathPattern,
      updateSnapshot
    });
    startRun(globalConfig);
    globalConfig = updateGlobalConfig(globalConfig, {
      // updateSnapshot is not sticky after a run.
      updateSnapshot: previousUpdateSnapshot === 'all' ? 'none' : previousUpdateSnapshot
    });
  };

  const watchPlugins = INTERNAL_PLUGINS.map(
    (InternalPlugin) =>
      new InternalPlugin({
        stdin,
        stdout: outputStream
      })
  );
  watchPlugins.forEach((plugin) => {
    const hookSubscriber = hooks.getSubscriber();

    if (plugin.apply) {
      plugin.apply(hookSubscriber);
    }
  });

  const failedTestsCache = new _FailedTestsCache.default();
  let searchSources = contexts.map((context) => ({
    context,
    searchSource: new _SearchSource.default(context)
  }));
  let isRunning = false;
  let testWatcher;
  let shouldDisplayWatchUsage = true;
  let isWatchUsageDisplayed = false;

  const emitFileChange = () => {
    if (hooks.isUsed('onFileChange')) {
      const projects = searchSources.map(({ context, searchSource }) => ({
        config: context.config,
        testPaths: searchSource.findMatchingTests('').tests.map((t) => t.path)
      }));
      hooks.getEmitter().onFileChange({
        projects
      });
    }
  };

  emitFileChange();
  hasteMapInstances.forEach((hasteMapInstance, index) => {
    hasteMapInstance.on('change', ({ eventsQueue, hasteFS, moduleMap }) => {
      const validPaths = eventsQueue.filter(({ filePath }) =>
        (0, _isValidPath.default)(globalConfig, filePath)
      );

      if (validPaths.length) {
        const context = (contexts[index] = (0, _createContext.default)(contexts[index].config, {
          hasteFS,
          moduleMap
        }));
        activePlugin = null;
        searchSources = searchSources.slice();
        searchSources[index] = {
          context,
          searchSource: new _SearchSource.default(context)
        };
        emitFileChange();
        startRun(globalConfig);
      }
    });
  });

  const startRun = (globalConfig) => {
    if (isRunning) {
      return Promise.resolve(null);
    }

    testWatcher = new _TestWatcher.default({
      isWatchMode: true
    });

    preRunMessagePrint(outputStream);
    isRunning = true;
    const configs = contexts.map((context) => context.config);
    const changedFilesPromise = (0, _getChangedFilesPromise.default)(globalConfig, configs);
    return runJest({
      changedFilesPromise,
      contexts,
      failedTestsCache,
      filter,
      globalConfig,
      jestHooks: hooks.getEmitter(),
      onComplete: (results) => {
        isRunning = false;
        hooks.getEmitter().onTestRunComplete(results); // Create a new testWatcher instance so that re-runs won't be blocked.
        // The old instance that was passed to Jest will still be interrupted
        // and prevent test runs from the previous run.

        testWatcher = new TestWatcher({
          isWatchMode: true
        });

        outputStream.write('\n');

        failedTestsCache.setTestResults(results.testResults);
      },
      outputStream,
      startRun,
      testWatcher
    }).catch(
      (
        error // Errors thrown inside `runJest`, e.g. by resolvers, are caught here for
      ) =>
        // continuous watch mode execution. We need to reprint them to the
        // terminal and give just a little bit of extra space so they fit below
        // `preRunMessagePrint` message nicely.
        console.error(
          '\n\n' +
            (0, _jestMessageUtil().formatExecError)(error, contexts[0].config, {
              noStackTrace: false
            })
        )
    );
  };

  const onKeypress = (key) => {
    if (key === CONTROL_C || key === CONTROL_D) {
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }

      outputStream.write('\n');
      (0, _exit().default)(0);
      return;
    }

    if (activePlugin != null && activePlugin.onKey) {
      // if a plugin is activate, Jest should let it handle keystrokes, so ignore
      // them here
      activePlugin.onKey(key);
      return;
    } // Abort test run

    const pluginKeys = (0, _watchPluginsHelpers.getSortedUsageRows)(watchPlugins, globalConfig).map((usage) =>
      Number(usage.key).toString(16)
    );

    if (isRunning && testWatcher && ['q', ENTER, 'a', 'o', 'f'].concat(pluginKeys).includes(key)) {
      testWatcher.setState({
        interrupted: true
      });
      return;
    }

    switch (key) {
      case ENTER:
        startRun(globalConfig);
        break;

      case 'a':
        updateConfigAndRun({
          mode: 'watchAll',
          testNamePattern: '',
          testPathPattern: ''
        });
        break;

      case 'c':
        updateConfigAndRun({
          mode: 'watch',
          testNamePattern: '',
          testPathPattern: ''
        });
        break;

      case 'f':
        updateConfigAndRun({
          onlyFailures: !globalConfig.onlyFailures
        });
        break;

      case 'o':
        updateConfigAndRun({
          mode: 'watch',
          testNamePattern: '',
          testPathPattern: ''
        });
        break;

      case '?':
        break;

      case 'w':
        if (!shouldDisplayWatchUsage && !isWatchUsageDisplayed) {
          outputStream.write(usage(globalConfig, watchPlugins));
          isWatchUsageDisplayed = true;
          shouldDisplayWatchUsage = false;
        }

        break;
    }
  };

  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onKeypress);
  }

  startRun(globalConfig);
  return Promise.resolve();
}
