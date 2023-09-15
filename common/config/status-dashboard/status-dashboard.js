// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.
self.addEventListener('load', () => {
  const title = document.getElementById('title');
  const subtitle = document.getElementById('subtitle');
  const statusElement = document.getElementById('status');
  const operationsElement = document.getElementById('operations');
  const operationsByName = new Map();
  let status = 'Ready';
  function updateOperationStates(operations) {
    for (const operation of operations) {
      operationsByName.set(operation.name, operation);
    }
    const operationsByStatus = new Map();
    operationsByStatus.set('Failure', []);
    operationsByStatus.set('SuccessWithWarning', []);
    operationsByStatus.set('Executing', []);
    operationsByStatus.set('Ready', []);
    operationsByStatus.set('Waiting', []);
    // Everything else is "Other"
    for (const info of operationsByName.values()) {
      const { status } = info;
      const group = operationsByStatus.get(status);
      if (group) {
        group.push(info);
      } else {
        operationsByStatus.set(status, [info]);
      }
    }
    const fragment = document.createDocumentFragment();
    for (const [status, group] of operationsByStatus) {
      const groupElement = document.createElement('details');
      const summaryElement = document.createElement('summary');
      summaryElement.innerText = `${status} (${group.length})`;
      groupElement.appendChild(summaryElement);
      groupElement.className = 'operation-group';
      groupElement.open = true;
      const listElement = document.createElement('ul');
      for (const info of group) {
        const { startTime, endTime } = info;
        const itemElement = document.createElement('li');
        let text = `${info.name} - ${status}`;
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
  function updateStatus(newStatus) {
    if (status === newStatus) {
      return;
    }
    status = newStatus;
    statusElement.innerText = newStatus;
  }
  function updateSessionInfo(sessionInfo) {
    title.innerText = `rush ${sessionInfo.actionName}`;
    subtitle.innerText = sessionInfo.repositoryIdentifier;
  }
  let socketReopenInterval;
  let socket;
  function openSocket() {
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
      const message = JSON.parse(ev.data);
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
export {};
//# sourceMappingURL=status-dashboard.js.map
