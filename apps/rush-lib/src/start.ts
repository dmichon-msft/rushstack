// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

const Module: any = require('module');
const innerLoad: any = Module._load.bind(Module);
Module._load = (request: string, parent: unknown, isMain: boolean): any => {
  let actualModule: any;

  let defaultTarget = function () {};

  const ensureModule = () => {
    if (!actualModule) {
      actualModule = innerLoad(request, parent, isMain);
      defaultTarget.prototype = actualModule.prototype || null;
    }
    return actualModule;
  };

  const handler = {
    defineProperty: (target: unknown, property: string, descriptor: PropertyDescriptor): boolean => {
      descriptor.configurable = true;
      const actual = ensureModule();
      if (property === 'prototype') {
        Reflect.defineProperty(defaultTarget, property, descriptor);
      }
      return Reflect.defineProperty(actual, property, descriptor);
    },
    deleteProperty: (target: unknown, property: string): boolean => {
      return Reflect.deleteProperty(ensureModule(), property);
    },
    get: (target: unknown, property: string, receiver: any): any => {
      const value = Reflect.get(ensureModule(), property, receiver);
      return value;
    },
    getPrototypeOf: (target: unknown): object => {
      return Reflect.getPrototypeOf(ensureModule());
    },
    getOwnPropertyDescriptor: (target: unknown, property: string): PropertyDescriptor | undefined => {
      const desc = Reflect.getOwnPropertyDescriptor(ensureModule(), property);
      if (desc) {
        desc.configurable = true;
      }

      if (property === 'prototype') {
        return Reflect.getOwnPropertyDescriptor(defaultTarget, property);
      }

      return desc;
    },
    has: (target: unknown, property: string): boolean => {
      if (property === 'prototype') {
        return true;
      }
      return Reflect.has(ensureModule(), property);
    },
    apply: (target: unknown, thisArgument: unknown, argumentsList: ArrayLike<any>): any => {
      return Reflect.apply(ensureModule(), thisArgument, argumentsList);
    },
    construct: (target: unknown, argumentsList: ArrayLike<any>, newTarget: any): any => {
      return Reflect.construct(ensureModule(), argumentsList, newTarget);
    },
    set: (target: unknown, property: string, value: any, receiver: any): boolean => {
      const actual = ensureModule();
      if (property === 'prototype') {
        defaultTarget.prototype = value;
      }
      return Reflect.set(actual, property, value, receiver);
    },
    setPrototypeOf: (target: unknown, proto: any): boolean => {
      return Reflect.setPrototypeOf(ensureModule(), proto);
    },

    ownKeys: (target: unknown): (string | number | symbol)[] => {
      const keys = Reflect.ownKeys(ensureModule());
      if (!keys.includes('prototype')) {
        keys.push('prototype');
      }
      return keys;
    }
  };

  return new Proxy(defaultTarget, handler);
};

const { Rush } = require('./api/Rush');

Rush.launch(Rush.version, { isManaged: false });
