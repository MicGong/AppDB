import Ably from 'https://esm.sh/ably';

export const setup = () => {
  const clientId = 'client_' + Math.random().toString(36).substring(2, 15);
  const ably = new Ably.Realtime("codXNw.EPiBTw:Fu3NmW5QV5OcyOQj7lMQlXITNPpZbJqG6GP8pcnIqno");

  const channel = ably.channels.get("proto-chan");

  channel.subscribe("event", (message) => {
    if (message.data.clientId === clientId) {
      return;
    }
    
    // Create and dispatch a custom event with the message data
    const syncEvent = new CustomEvent('syncMessage', {
      detail: {
        data: message.data,
        timestamp: message.timestamp,
        clientId: message.data.clientId
      }
    });
    
    // Dispatch the event on the window object
    window.dispatchEvent(syncEvent);
  });
  
  return {
    clientId,
    addEventListener: (callback) => {
      window.addEventListener('syncMessage', callback);
    },
    removeEventListener: (callback) => {
      window.removeEventListener('syncMessage', callback);
    }
  }
}