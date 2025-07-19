class FloatingTimer {
    constructor(initialTime = 60) {
        this.timeRemaining = initialTime;
        this.timerElement = null;
        this.intervalId = null;
        this.syncIntervalId = null;
        this.isActive = false;
        this.tabId = null;

        // Bind methods to preserve context
        this.updateDisplay = this.updateDisplay.bind(this);
        this.handleExpiration = this.handleExpiration.bind(this);
        this.cleanup = this.cleanup.bind(this);
        this.sendTimerTick = this.sendTimerTick.bind(this);
        this.requestSync = this.requestSync.bind(this);

        this.createTimerWidget();
        this.getTabId();
    }


    createTimerWidget() {
        // Create timer container
        this.timerElement = document.createElement('div');
        this.timerElement.id = 'floating-timer';
        this.timerElement.className = 'timer-widget';

        // Create timer display
        const timerDisplay = document.createElement('div');
        timerDisplay.className = 'timer-display';
        timerDisplay.textContent = this.formatTime(this.timeRemaining);

        // Create timer label
        const timerLabel = document.createElement('div');
        timerLabel.className = 'timer-label';
        timerLabel.textContent = 'Temporary Access';

        // Assemble widget
        this.timerElement.appendChild(timerLabel);
        this.timerElement.appendChild(timerDisplay);

        // Apply basic inline styles for positioning and visibility
        this.applyBasicStyles();

        // Add to page
        document.body.appendChild(this.timerElement);
    }

    applyBasicStyles() {
        if (!this.timerElement) return;

        // Fixed positioning in top-right corner
        this.timerElement.style.position = 'fixed';
        this.timerElement.style.top = '20px';
        this.timerElement.style.right = '20px';
        this.timerElement.style.zIndex = '999999';

        // Semi-transparent background
        this.timerElement.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        this.timerElement.style.color = 'white';
        this.timerElement.style.padding = '12px 16px';
        this.timerElement.style.borderRadius = '8px';
        this.timerElement.style.fontFamily = 'Arial, sans-serif';
        this.timerElement.style.fontSize = '14px';
        this.timerElement.style.fontWeight = 'bold';
        this.timerElement.style.textAlign = 'center';
        this.timerElement.style.minWidth = '120px';
        this.timerElement.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.3)';

        // Ensure it doesn't interfere with page interactions
        this.timerElement.style.pointerEvents = 'none';
        this.timerElement.style.userSelect = 'none';
    }

    startCountdown() {
        if (this.isActive) return;

        this.isActive = true;
        this.updateDisplay(this.timeRemaining);

        // Update every second with timer tick messages
        this.intervalId = setInterval(() => {
            this.timeRemaining--;
            this.updateDisplay(this.timeRemaining);

            // Send timer tick to background script for synchronization
            this.sendTimerTick();

            if (this.timeRemaining <= 0) {
                this.handleExpiration();
            }
        }, 1000);

        // Set up periodic synchronization every 5 seconds to prevent drift
        this.syncIntervalId = setInterval(() => {
            this.requestSync();
        }, 5000);
    }

    updateDisplay(timeRemaining) {
        if (!this.timerElement) return;

        const display = this.timerElement.querySelector('.timer-display');
        if (display) {
            display.textContent = this.formatTime(timeRemaining);

            // Apply urgency styling when less than 10 seconds remain
            if (timeRemaining <= 10 && timeRemaining > 0) {
                this.timerElement.style.backgroundColor = 'rgba(220, 53, 69, 0.9)';
                this.timerElement.style.animation = 'pulse 1s infinite';
            }
        }
    }

    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    handleExpiration() {
        this.isActive = false;

        // Hide timer widget
        if (this.timerElement) {
            this.timerElement.style.display = 'none';
        }

        // Send expiration message to background script
        if (typeof browser !== 'undefined' && browser.runtime) {
            browser.runtime.sendMessage({
                action: 'timerExpired',
                tabId: this.getTabId()
            }).catch(error => {
                console.warn('Failed to send timer expiration message:', error);
            });
        }

        // Clean up resources
        this.cleanup();
    }

    async getTabId() {
        if (this.tabId) {
            return this.tabId;
        }

        try {
            // First try to get from browser tabs API
            if (browser.tabs && browser.tabs.query) {
                const tabs = await browser.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    this.tabId = tabs[0].id;
                    return this.tabId;
                }
            }
        } catch (error) {
            console.warn('[FloatingTimer] Failed to get tab ID from tabs API:', error);
        }

        try {
            // Fallback: try to get from background script
            const response = await browser.runtime.sendMessage({ action: 'getCurrentTabId' });
            if (response && response.tabId) {
                this.tabId = response.tabId;
                return this.tabId;
            }
        } catch (bgError) {
            console.warn('[FloatingTimer] Failed to get tab ID from background:', bgError);
        }

        // Last resort: use a placeholder that won't match
        console.warn('[FloatingTimer] Could not determine tab ID, using placeholder');
        this.tabId = -1;
        return this.tabId;
    }

    cleanup() {
        // Clear countdown interval
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        // Clear sync interval
        if (this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }

        // Remove DOM element
        if (this.timerElement && this.timerElement.parentNode) {
            this.timerElement.parentNode.removeChild(this.timerElement);
            this.timerElement = null;
        }

        // Reset state
        this.isActive = false;
        this.timeRemaining = 0;
        this.tabId = null;
    }

    syncTime(newTimeRemaining) {
        if (newTimeRemaining <= 0) {
            this.handleExpiration();
            return;
        }

        // Only sync if there's a significant difference (more than 1 second)
        if (Math.abs(this.timeRemaining - newTimeRemaining) > 1) {
            console.log(`[FloatingTimer] Syncing time from ${this.timeRemaining}s to ${newTimeRemaining}s`);
            this.timeRemaining = newTimeRemaining;
            this.updateDisplay(this.timeRemaining);
        }
    }

    sendTimerTick() {
        if (!this.tabId || this.tabId === -1) return;

        try {
            // Check if runtime is still available
            if (!browser.runtime || !browser.runtime.sendMessage) {
                console.warn('[FloatingTimer] Runtime not available for timer tick');
                return;
            }

            browser.runtime.sendMessage({
                action: 'timerTick',
                tabId: this.tabId,
                timeRemaining: this.timeRemaining
            }).catch(error => {
                // Handle specific error cases
                if (error.message && error.message.includes('Extension context invalidated')) {
                    console.warn('[FloatingTimer] Extension context invalidated, stopping timer');
                    this.handleExtensionContextLoss();
                } else {
                    console.warn('[FloatingTimer] Failed to send timer tick:', error);
                }
            });
        } catch (error) {
            console.warn('[FloatingTimer] Failed to send timer tick message:', error);
        }
    }

    requestSync() {
        if (!this.tabId || this.tabId === -1) return;

        try {
            // Check if runtime is still available
            if (!browser.runtime || !browser.runtime.sendMessage) {
                console.warn('[FloatingTimer] Runtime not available for sync request');
                return;
            }

            browser.runtime.sendMessage({
                action: 'requestTimerSync',
                tabId: this.tabId,
                currentTime: this.timeRemaining
            }).catch(error => {
                // Handle specific error cases
                if (error.message && error.message.includes('Extension context invalidated')) {
                    console.warn('[FloatingTimer] Extension context invalidated during sync');
                    this.handleExtensionContextLoss();
                } else {
                    console.warn('[FloatingTimer] Failed to request timer sync:', error);
                }
            });
        } catch (error) {
            console.warn('[FloatingTimer] Failed to request sync message:', error);
        }
    }

    handleExtensionContextLoss() {
        console.log('[FloatingTimer] Handling extension context loss');

        // Show a fallback message to user
        if (this.timerElement) {
            const display = this.timerElement.querySelector('.timer-display');
            const label = this.timerElement.querySelector('.timer-label');

            if (display) {
                display.textContent = 'Extension Reloaded';
                display.style.fontSize = '12px';
            }
            if (label) {
                label.textContent = 'Timer may be inaccurate';
                label.style.fontSize = '10px';
            }

            // Change styling to indicate issue
            this.timerElement.style.backgroundColor = 'rgba(255, 193, 7, 0.9)';
            this.timerElement.style.color = 'black';
        }

        // Stop trying to communicate with background
        this.isActive = false;

        // Clear intervals to prevent further errors
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        if (this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
    }
}

// CSS animation for urgency pulse effect
const style = document.createElement('style');
style.textContent = `
    @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.05); }
        100% { transform: scale(1); }
    }
`;
document.head.appendChild(style);

// Global timer instance
let floatingTimer = null;

// Message listener for background script communication
if (typeof browser !== 'undefined' && browser.runtime) {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        try {
            switch (message.action) {
                case 'startTimer':
                    try {
                        if (floatingTimer) {
                            floatingTimer.cleanup();
                        }
                        floatingTimer = new FloatingTimer(message.initialTime || 60);
                        floatingTimer.startCountdown();
                        sendResponse({ success: true });
                    } catch (error) {
                        console.error('[FloatingTimer] Error starting timer:', error);
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'syncTimer':
                    try {
                        if (floatingTimer) {
                            floatingTimer.syncTime(message.timeRemaining);
                            sendResponse({ success: true });
                        } else {
                            sendResponse({ success: false, error: 'No active timer' });
                        }
                    } catch (error) {
                        console.error('[FloatingTimer] Error syncing timer:', error);
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                case 'stopTimer':
                    try {
                        if (floatingTimer) {
                            floatingTimer.cleanup();
                            floatingTimer = null;
                        }
                        sendResponse({ success: true });
                    } catch (error) {
                        console.error('[FloatingTimer] Error stopping timer:', error);
                        sendResponse({ success: false, error: error.message });
                    }
                    break;

                default:
                    sendResponse({ success: false, error: 'Unknown action' });
                    break;
            }
        } catch (error) {
            console.error('[FloatingTimer] Error handling message:', error);
            sendResponse({ success: false, error: error.message });
        }

        // Return true to indicate we will send a response asynchronously if needed
        return true;
    });
}

// Cleanup on page unload and other events
window.addEventListener('beforeunload', () => {
    try {
        if (floatingTimer) {
            floatingTimer.cleanup();
        }
    } catch (error) {
        console.error('[FloatingTimer] Error during beforeunload cleanup:', error);
    }
});

// Additional cleanup on page hide (for mobile browsers)
window.addEventListener('pagehide', () => {
    try {
        if (floatingTimer) {
            floatingTimer.cleanup();
        }
    } catch (error) {
        console.error('[FloatingTimer] Error during pagehide cleanup:', error);
    }
});

// Cleanup on visibility change (when tab becomes hidden)
document.addEventListener('visibilitychange', () => {
    try {
        if (document.visibilityState === 'hidden' && floatingTimer) {
            // Don't cleanup completely, but stop sync to save resources
            if (floatingTimer.syncIntervalId) {
                clearInterval(floatingTimer.syncIntervalId);
                floatingTimer.syncIntervalId = null;
            }
        } else if (document.visibilityState === 'visible' && floatingTimer && floatingTimer.isActive) {
            // Resume sync when tab becomes visible again
            floatingTimer.syncIntervalId = setInterval(() => {
                floatingTimer.requestSync();
            }, 5000);
        }
    } catch (error) {
        console.error('[FloatingTimer] Error during visibility change:', error);
    }
});

// Handle extension context invalidation
if (browser.runtime && browser.runtime.onConnect) {
    const port = browser.runtime.connect({ name: 'floating-timer' });
    port.onDisconnect.addListener(() => {
        if (browser.runtime.lastError) {
            console.log('[FloatingTimer] Extension context invalidated');
            if (floatingTimer) {
                floatingTimer.handleExtensionContextLoss();
            }
        }
    });
}