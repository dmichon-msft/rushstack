// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/// <reference lib="dom" />

import type {
  IOperationInfo,
  IRushSessionInfo,
  IWebSocketEventMessage,
  ReadableOperationStatus
} from './api.types';

self.addEventListener('load', () => {
  const title: HTMLHeadingElement = document.getElementById('title') as HTMLHeadingElement;
  const subtitle: HTMLHeadingElement = document.getElementById('subtitle') as HTMLHeadingElement;
  const statusElement: HTMLHeadingElement = document.getElementById('status') as HTMLHeadingElement;

  const operationsElement: HTMLDivElement = document.getElementById('operations') as HTMLDivElement;

  const operationsByName: Map<string, IOperationInfo> = new Map();
  let status: ReadableOperationStatus = 'Ready';

  function updateOperationStates(operations: Iterable<IOperationInfo>): void {
    for (const operation of operations) {
      operationsByName.set(operation.name, operation);
    }

    const operationsByStatus: Map<ReadableOperationStatus, IOperationInfo[]> = new Map();
    operationsByStatus.set('Failure', []);
    operationsByStatus.set('SuccessWithWarning', []);
    operationsByStatus.set('Executing', []);
    operationsByStatus.set('Ready', []);
    operationsByStatus.set('Waiting', []);
    // Everything else is "Other"

    for (const info of operationsByName.values()) {
      const { status } = info;
      const group: IOperationInfo[] | undefined = operationsByStatus.get(status);
      if (group) {
        group.push(info);
      } else {
        operationsByStatus.set(status, [info]);
      }
    }

    const fragment: DocumentFragment = document.createDocumentFragment();

    for (const [status, group] of operationsByStatus) {
      const groupElement: HTMLDetailsElement = document.createElement('details');
      const summaryElement: HTMLElement = document.createElement('summary');
      summaryElement.innerText = `${status} (${group.length})`;
      groupElement.appendChild(summaryElement);
      groupElement.className = 'operation-group';
      groupElement.open = true;
      const listElement: HTMLElement = document.createElement('ul');
      for (const info of group) {
        const { startTime, endTime } = info;
        const itemElement: HTMLElement = document.createElement('li');
        let text: string = `${info.name} - ${status}`;
        if (startTime && endTime) {
          text += ` (${(endTime - startTime) / 1000} s)`;
        }
        itemElement.innerText = text;
        listElement.appendChild(itemElement);
      }
      groupElement.appendChild(listElement);
      fragment.appendChild(groupElement);
    }

    operationsElement.innerHTML = '';
    operationsElement.appendChild(fragment);
  }

  function updateStatus(newStatus: ReadableOperationStatus): void {
    if (status === newStatus) {
      return;
    }

    status = newStatus;

    statusElement.innerText = newStatus;
  }

  function updateSessionInfo(sessionInfo: IRushSessionInfo): void {
    title.innerText = `rush ${sessionInfo.actionName}`;
    subtitle.innerText = sessionInfo.repositoryIdentifier;
  }

  let socketReopenInterval: number | undefined;
  let socket: WebSocket | undefined;

  function openSocket(): void {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      return;
    }

    console.log(`Opening web socket connection.`);

    socket = new WebSocket(`wss://${location.host}`);

    socket.addEventListener('open', () => {
      if (socketReopenInterval) {
        self.clearInterval(socketReopenInterval);
        socketReopenInterval = undefined;
      }
    });

    socket.addEventListener('close', () => {
      console.log(`Web socket connection lost. Attempting to reopen...`);

      socketReopenInterval = self.setInterval(openSocket, 5000);
    });

    socket.addEventListener('message', (ev) => {
      const message: IWebSocketEventMessage = JSON.parse(ev.data);

      switch (message.event) {
        case 'before-execute': {
          updateStatus('Executing');
          break;
        }

        case 'status-change': {
          const { operations } = message;
          updateOperationStates(operations);
          break;
        }

        case 'after-execute': {
          updateStatus(message.status);
          break;
        }

        case 'sync': {
          operationsByName.clear();
          updateOperationStates(message.operations);
          updateSessionInfo(message.sessionInfo);
          updateStatus(message.status);
          break;
        }
      }
    });
  }

  openSocket();
});
