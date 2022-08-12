# @rushstack/orchestrator

This library contains a task orchestration engine used by both Rush and Heft. It supports either single pass or continuous watch-mode operation, with the ability to expand or shrink the scope of executing operations while running.
Hooks are provided to customize logging, build cache integration, and reporting.

## Single pass execution
To power commands like `rush build` or `heft build`, the `Engine` class provides the `runAsync()` method, which invalidates operations as needed according to the provided local state vector, then executes all operations until no further operations can be executed, then terminates.

In this mode, state tracking is used for output caching. Cache keys are generated from the `Operation` state hash values and can be used for writing to or reading from a persistent cache. Alternatively, prepopulating the operation states with values read from disk can be used for persistent incremental builds.

## Continuous watch execution
To power commands like `rush start` or `heft build-watch`, callers should be sure to pass a cancellation token to `runAsync()`. When changes are detected, the cancellation token should be invoked, then a new call to `runAsync()` issued with the updated local state vector and a new cancellation token.

## Links

- [CHANGELOG.md](
  https://github.com/microsoft/rushstack/blob/main/libraries/orchestrator/CHANGELOG.md) - Find
  out what's new in the latest version
- [API Reference](https://rushstack.io/pages/api/orchestrator/)

`@rushstack/orchestrator` is part of the [Rush Stack](https://rushstack.io/) family of projects.
