import Ably from 'https://esm.sh/ably';

export const setup = () => {
  console.log('Setting up sync');
  const clientId = 'client_' + Math.random().toString(36).substring(2, 15);
  const ably = new Ably.Realtime("codXNw.EPiBTw:Fu3NmW5QV5OcyOQj7lMQlXITNPpZbJqG6GP8pcnIqno");

  const channel = ably.channels.get("proto-chan");

  channel.subscribe("event", (message) => {
    console.log('Received sync message:', message.data);
    if (message.data.clientId === clientId) {
      console.log('Ignoring sync message from self');
      return;
    }
    
    // Create and dispatch a custom event with the message data
    const detail = {
      data: message.data,
      timestamp: message.timestamp,
      clientId: message.data.clientId
    }
    const syncEvent = new CustomEvent('syncMessage', {
      detail
    });
    
    // Dispatch the event on the window object
    window.dispatchEvent(syncEvent);
    console.log(`Sync message dispatched: ${detail}`);
  });

  console.log('Setup complete');
  
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