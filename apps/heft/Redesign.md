This is a proposal for aligning the architecture of Heft to be more compatible with Rush "phased" commands in the interests of improving parallelism, customizability for other tools (esbuild, swc, etc.), reducing Heft aggregate boot time, and optimizing multi-project watching.

# Goal 1: Increased Parallelism and Configurability

## Current state
Today `heft test` runs a sequence of hardcoded pipeline stages:
```
[Clean] (if --clean) -> [Build] (unless --no-build) -> [Test]
```
Where the `Build` stage is further subdivided into hardcoded sub-stages:
```
[Pre-Compile] -> [Compile] -> [Bundle] -> [Post-Build]
```

This limits the ability of Rush to exploit task parallelism to running `heft build --clean` and `heft test --no-build` for each project, i.e. if:
```
A <-(depends on)- B
```
Then the `test` phase for `A` can run concurrently with the `build` phase for `B`.

The `heft.json` file provides event actions and plugins to inject build steps at various points within this pipeline, but the pipeline itself is not particularly customizable.

When run from the command line, Heft loads a single `HeftConfiguration` object and creates a `HeftSession` that corresponds to the command line session.

## Desired state
In future build rigs that exploit the `isolatedModules` contract to allow transpilation of each and every module from TypeScript -> JavaScript to be an independent operation, we instead have stages more like the following, each of which handles cleaning internally:
- **Compile**: Converts TypeScript -> ECMAScript.
  - Dependencies: none
- **SASS**: Convert SASS -> CSS, emit .d.ts files.
  - Dependencies: none
- **Analyze**: Type Check, Lint, emit .d.ts files.
  - Dependencies: Analyze in dependency projects, SASS in current project
- **Test**: Run unit tests.
  - Dependencies: Compile in self and dependency projects
- **Bundle**: Combine ECMAScript/CSS/etc. into more compact bundled form.
  - Dependencies: Compile in self and dependency projects. Potentially bundle in dependency projects.

Custom rigs may require more or fewer stages to accommodate other build steps, and importantly, may alter the dependency relationship between the stages. For example a rig may opt to run its tests on bundled output, and therefore have the "test" stage depend on the "bundle" stage.

# Goal 2: Reduce time booting Heft repeatedly in a large Rush monorepo

## Current state
The initialization time of a Heft process is currently measured in seconds. In a monorepo with 600 projects, even 1 second of overhead is 10 minutes of CPU-time, since for each operation on each project, Rush boots Heft and its CLI parser in a fresh process.

## Desired state
Since Heft is designed to scope state to `HeftSession` objects and closures in plugin taps, it should be possible to reuse a single `Heft` process across multiple operations on multiple projects.

# Goal 3: Multi-project watch

## Current state
Custom watch-mode commands in Rush rely on the underlying command-line script to support efficient incremental execution and are unable to preserve a running process across build passes. Some tools, such as TypeScript or Webpack 5 have support for this model, but others, such as Jest, do not.

## Desired state
Using IPC or stdin/stdout, a Heft (or other compatible tool) process can communicate with Rush to receive a notification of changed inputs and to report the result of the command.

# Design Spec
Instead of a hardcoded pipeline definition, `heft.json` gains the ability to define a list of stages, their dependencies on other stages, and the event actions and plugins required to implement the functionality for each.

## Heft.json
```jsonc
{
  /**
   * Command line aliases to run a set of stages, so that developers can continue to run `heft build` or similar
   */
  "actions": [
    {
      "name": "build",
      "stages": [
        "compile",
        "analyze",
        "bundle"
      ]
    },
    {
      "name": "test",
      "stages": [
        "compile",
        // "analyze" and "bundle" are omitted since they are not necessary for "test" to run
        "test"
      ]
    }
  ],

  /**
   * Individual build steps defined for this project (or rig). Projects will typically inherit from `@rushstack/heft-web-rig` or `@rushstack/heft-node-rig`,
   * but custom rigs or even individual projects may need different stages or different plugins in each stage.
   */
  "stages": [
    {
      "name": "compile",
      /**
       * This build rig uses isolatedModules, so emitting ECMAScript does not depend on typings for other file types.
       */
      "dependsOn": [],
      "eventActions": [
        {
          /**
          * The kind of built-in operation that should be performed.
          * The "deleteGlobs" action deletes files or folders that match the
          * specified glob patterns.
          */
          "actionKind": "deleteGlobs",

          /**
          * The stage of the Heft run during which this action should occur. One of "clean", "beforeRun", "run", "afterRun"
          */
          "heftEvent": "clean",

          "actionId": "defaultClean",

          /**
          * Glob patterns to be deleted. The paths are resolved relative to the project folder.
          */
          "globsToDelete": ["lib/**/*.js", "lib/**/*.js.map", "lib-commonjs/**/*.js", "lib-commonjs/**/*.js.map"]
        }
      ],
      "plugins": [
        {
          /**
           * Plugin that uses TypeScript's transpileModule() API to bulk convert TypeScript -> ECMAScript.
           * Could use a SWC or Babel-based plugin instead.
           */
          "plugin": "@rushstack/heft-typescript-plugin/lib/TranspileOnlyPlugin"
        }
      ]
    },
    {
      "name": "sass",
      /**
       * Compiling SASS does not depend on other stages
       */
      "dependsOn": [],
      "eventActions": [
        {
          /**
          * The kind of built-in operation that should be performed.
          * The "deleteGlobs" action deletes files or folders that match the
          * specified glob patterns.
          */
          "actionKind": "deleteGlobs",

          /**
          * The stage of the Heft run during which this action should occur. One of "clean", "beforeRun", "run", "afterRun"
          */
          "heftEvent": "clean",

          "actionId": "defaultClean",

          /**
          * Glob patterns to be deleted. The paths are resolved relative to the project folder.
          */
          "globsToDelete": ["lib/**/*.css", "temp/sass-ts"]
        }
      ],
      "plugins": [
        {
          /**
           * Plugin that uses TypeScript to type check and emit declaration files, but not transpile to ECMAScript
           */
          "plugin": "@rushstack/heft-typescript-plugin/lib/DeclarationOnlyPlugin"
        }
      ]
    },
    {
      "name": "analyze",
      /**
       * Type checking and Linting can be done in parallel with other stages, but depend on the generated .scss.d.ts files
       */
      "dependsOn": ["sass"],
      "eventActions": [
        {
          /**
          * The kind of built-in operation that should be performed.
          * The "deleteGlobs" action deletes files or folders that match the
          * specified glob patterns.
          */
          "actionKind": "deleteGlobs",

          /**
          * The stage of the Heft run during which this action should occur. One of "clean", "beforeRun", "run", "afterRun"
          */
          "heftEvent": "clean",

          "actionId": "defaultClean",

          /**
          * Glob patterns to be deleted. The paths are resolved relative to the project folder.
          */
          "globsToDelete": ["lib/**/*.d.ts", "lib/**/*.d.ts.map"]
        }
      ],
      "plugins": [
        {
          /**
           * Plugin that uses TypeScript to type check and emit declaration files, but not transpile to ECMAScript
           */
          "plugin": "@rushstack/heft-typescript-plugin/lib/DeclarationOnlyPlugin"
        }
      ]
    },
    {
      "name": "bundle",
      /**
       * The bundler needs the compiled ECMAScript and CSS
       */
      "dependsOn": ["compile", "sass"],
      "eventActions": [
        {
          /**
          * The kind of built-in operation that should be performed.
          * The "deleteGlobs" action deletes files or folders that match the
          * specified glob patterns.
          */
          "actionKind": "deleteGlobs",

          /**
          * The stage of the Heft run during which this action should occur. One of "clean", "beforeRun", "run", "afterRun"
          */
          "heftEvent": "clean",

          "actionId": "defaultClean",

          /**
          * Glob patterns to be deleted. The paths are resolved relative to the project folder.
          */
          "globsToDelete": ["dist"]
        }
      ],
      "plugins": [
        {
          "plugin": "@rushstack/heft-webpack5-plugin"
        }
      ]
    },
    {
      "name": "test",
      /**
       * Jest needs compiled ECMAScript
       */
      "dependsOn": ["compile"],
      "eventActions": [
        {
          /**
          * The kind of built-in operation that should be performed.
          * The "deleteGlobs" action deletes files or folders that match the
          * specified glob patterns.
          */
          "actionKind": "deleteGlobs",

          /**
          * The stage of the Heft run during which this action should occur. One of "clean", "beforeRun", "run", "afterRun"
          */
          "heftEvent": "clean",

          "actionId": "defaultClean",

          /**
          * Glob patterns to be deleted. The paths are resolved relative to the project folder.
          */
          "globsToDelete": ["temp/jest"]
        }
      ],
      "plugins": [
        {
          "plugin": "@rushstack/heft-jest-plugin"
        }
      ]
    }
  ]
}
```

## HeftServer
The `HeftServer` is a new component in Heft that is responsible for handling requests to execute a specific stage in a specific project. Upon receiving a request it will either locate an existing `HeftSession` that corresponds to a prior issuance of that request, or else create a fresh `HeftSession`, then execute the `clean (optional), beforeRun, run, afterRun` hooks in order. The request may also contain an input state object and/or a hint to indicate that the stage will likely be re-executed in the future (for watch mode). When the `HeftServer` has finished executing the stage, it will report back to the caller with a list of warnings/errors, the success/failure of the stage, and potentially additional metadata. It may also pipe logs.

Heft plugins that need to communicate with other Heft plugins--for example to customize the webpack configuration used by `@rushstack/heft-webpack4-plugin`--should use the Plugin accessor mechanism that has already been implemented.

A separate CLI executable will be defined that creates a `HeftServer` and waits for IPC messages.

## Heft CLI
The Heft CLI process reads `heft.json`, identifies the requested action and uses `HeftServer` instances to execute the relevant stages in topological order. If running in `--debug` mode or if the stage topology does not contain any parallelism, the Heft CLI will load the `HeftServer` in the current process, otherwise it may boot multiple external `HeftServer` processes, or potentially be instructed to connect to an existing `HeftServer` process.

## @rushstack/rush-heft-operation-runner-plugin
The `@rushstack/rush-heft-operation-runner-plugin` is a Rush plugin that provides an implementation of the `IOperationRunner` contract (responsible for executing Rush Operations, i.e. a specific phase in a specific Rush project) that executes each Heft stage in the Operation (usually 1) by checking out a `HeftServer` instance from a pool maintained by the plugin and issuing an IPC request. The pool will maintain an affinity mapping of the last `HeftServer` used by each `Operation` identity, such that watch mode execution can re-use the same `HeftServer` process for subsequent build passes when the watcher detects changes. The mapping between `Operation` and Heft `stages` should be defined in an extension of the `rush-project.json` file to prevent Rush from needing to load additional files.