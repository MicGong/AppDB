// AppManager Module

import Ably from 'https://esm.sh/ably';

// Event status constants
const EVENT_STATUS = {
  PENDING: 'PENDING',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  FAILED: 'FAILED'
};

const serverUrl = 'https://jgong-persist_db.web.val.run';

const setupSync = (clientId) => {
  console.log('Setting up sync');
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

  console.log('Sync setup complete');
  
  return {
    addEventListener: (callback) => {
      window.addEventListener('syncMessage', callback);
    },
    removeEventListener: (callback) => {
      window.removeEventListener('syncMessage', callback);
    }
  }
}

class AppManager {
  constructor(appName, mergeFunction) {
    this.appName = appName;
    this.clientId = 'client_' + Math.random().toString(36).substring(2, 15);
    this.state = null;
    this.pendingEventsWithState = [];
    this.isOnline = navigator.onLine;
    this.syncClient = null;
    this.retryTimeouts = {};
    this.maxRetryDelay = 30000; // Maximum retry delay in ms (30 seconds)
    
    // Initialize sync client
    this.#initializeSync();

    // Initial state fetch
    this.#fetchInitialState();

    // Register merge function
    this.registerMergeFunction(mergeFunction);
    this.mergeFunction = new Function("return " + mergeFunction)();
    
    // Setup event listeners for online/offline status
    window.addEventListener('online', this.#handleOnlineStatus.bind(this));
    window.addEventListener('offline', this.#handleOnlineStatus.bind(this));
  }
  
  async #initializeSync() {
    const { addEventListener } = setupSync(this.clientId);
    addEventListener((event) => {
      console.log('Received sync event:', event.detail);
      if (event.detail.clientId === this.clientId) {
        console.log('Ignoring sync event from self');
        return;
      }
      this.handleSyncMessage(event);
    })

  }
  
  async #fetchInitialState() {
    try {
      const response = await fetch(`${serverUrl}/state`, {
        headers: {
          'Application-Name': this.appName
        }
      });
      if (!response.ok) throw new Error(`Failed to fetch state: ${response.statusText}`);
      this.state = await response.json();
      return this.state;
    } catch (error) {
      console.error('Error fetching initial state:', error);
      // If offline, we'll start with empty state and sync later
      this.state = this.state || {};
      return this.state;
    }
  }
  
  async registerMergeFunction(mergeFuncString) {
    try {
      const response = await fetch(`${serverUrl}/merge_func`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Application-Name': this.appName
        },
        body: JSON.stringify({ function: mergeFuncString })
      });
      
      if (!response.ok) throw new Error(`Failed to register merge function: ${response.statusText}`);
      return true;
    } catch (error) {
      console.error('Error registering merge function:', error);
      return false;
    }
  }
  
  // Apply an event locally and queue for server sync
  applyEvent(eventData) {
    // Generate a unique ID for this event if not provided
    const eventId = eventData.id || `event_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const event = {
      ...eventData,
      id: eventId,
      timestamp: Date.now(),
      clientId: this.clientId,
      status: EVENT_STATUS.PENDING
    };
    
    // Store the current state before applying the event
    const stateBeforeEvent = { ...this.state };
    
    // Apply optimistic update locally
    this.applyEventToLocalState(event);
    
    // Add to pending events queue with the state it will be applied on
    this.pendingEventsWithState.push({
      event: event,
      state: stateBeforeEvent
    });
    
    // Attempt to sync with server if online
    if (this.isOnline) {
      this.syncEventWithServer(event);
    }
    
    return eventId;
  }
  
  // Apply the event to local state using merge function
  applyEventToLocalState(event) {
    this.state = this.mergeFunction(this.state, event);
  }
  
  async syncEventWithServer(event) {
    try {
      const response = await fetch(`${serverUrl}/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Application-Name': this.appName
        },
        body: JSON.stringify(event)
      });
      
      if (!response.ok) throw new Error(`Server rejected event: ${response.statusText}`);
      
      // Update event status to acknowledged
      this.#updateEventStatus(event.id, EVENT_STATUS.ACKNOWLEDGED);
      
      // Remove from pending queue
      this.pendingEventsWithState = this.pendingEventsWithState.filter(e => e.event.id !== event.id);
      
      return true;
    } catch (error) {
      console.error(`Failed to sync event ${event.id}:`, error);
      
      // Mark as failed
      this.#updateEventStatus(event.id, EVENT_STATUS.FAILED);
      
      // Schedule retry with exponential backoff
      this.scheduleRetry(event);
      
      return false;
    }
  }
  
  #updateEventStatus(eventId, status) {
    this.pendingEventsWithState = this.pendingEventsWithState.map(item => {
      if (item.event.id === eventId) {
        return {
          ...item,
          event: { ...item.event, status }
        };
      }
      return item;
    });
  }
  
  scheduleRetry(event) {
    // Clear any existing retry for this event
    if (this.retryTimeouts[event.id]) {
      clearTimeout(this.retryTimeouts[event.id]);
    }
    
    // Calculate backoff time based on number of attempts
    const attempts = event.retryAttempts || 0;
    const delay = Math.min(Math.pow(2, attempts) * 1000, this.maxRetryDelay);
    
    // Schedule retry
    this.retryTimeouts[event.id] = setTimeout(() => {
      // Update retry attempts
      const updatedEvent = {
        ...event,
        retryAttempts: attempts + 1,
        status: EVENT_STATUS.PENDING
      };
      
      // Update in pending queue
      this.pendingEventsWithState = this.pendingEventsWithState.map(item => 
        item.event.id === event.id 
          ? { ...item, event: updatedEvent }
          : item
      );
      
      // Attempt sync again
      this.syncEventWithServer(updatedEvent);
    }, delay);
  }
  
  #handleOnlineStatus() {
    const currentOnline = navigator.onLine;
    
    // If status hasn't changed, do nothing
    if (this.isOnline === currentOnline) return;
    
    this.isOnline = currentOnline;
    
    if (currentOnline) {
      console.log('Connection restored. Syncing pending events...');
      this.#syncPendingEvents();
    } else {
      console.log('Connection lost. Operating in offline mode.');
      // Notify UI about offline status
      this.#notifyConnectionChange(false);
    }
  }
  
  #syncPendingEvents() {
    // Process all pending and failed events in chronological order
    const eventsToSync = this.pendingEventsWithState
      .filter(item => item.event.status === EVENT_STATUS.PENDING || item.event.status === EVENT_STATUS.FAILED)
      .sort((a, b) => a.event.timestamp - b.event.timestamp);
    
    // Sync each event with slight delay to prevent overwhelming the server
    eventsToSync.forEach((item, index) => {
      setTimeout(() => {
        this.syncEventWithServer(item.event);
      }, index * 100); // 100ms between each event
    });
    
    // Notify UI about online status
    this.#notifyConnectionChange(true);
  }
  
  handleSyncMessage(event) {
    const { data: dataRaw } = event.detail;
    const data = JSON.parse(dataRaw);
    if (this.pendingEventsWithState.length > 0) {
      // Temporarily revert all pending local events
      const serverState = this.pendingEventsWithState.at(0)?.state;
      // Apply the server event to the state
      this.state = this.mergeFunction(serverState, data);
      // Re-apply all pending local events
      this.pendingEventsWithState.forEach(item => {
        this.applyEventToLocalState(item.event);
      });
    } else {
      this.state = this.mergeFunction(this.state, data);
    }
    
  }
  
  #notifyConnectionChange(isOnline) {
    // Dispatch custom event with connection status
    const connectionEvent = new CustomEvent('connectionChange', {
      detail: { isOnline }
    });
    window.dispatchEvent(connectionEvent);
  }
  
  // Public API methods
  getState() {
    return this.state;
  }
  
  subscribeToConnectionChanges(callback) {
    window.addEventListener('connectionChange', callback);
    return () => window.removeEventListener('connectionChange', callback);
  }
  
  forceSync() {
    if (!this.isOnline) {
      console.warn('Cannot force sync while offline');
      return false;
    }
    
    this.#syncPendingEvents();
    return true;
  }
}

export { AppManager };