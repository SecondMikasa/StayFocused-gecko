class PomodoroBackground {
    constructor() {
        // console.log("[Background] Initializing PomodoroBackground...");
        // Create the blocking listener using factory method for consistent behavior
        this.blockingListener = this._createBlockingListener();

        // Initialize error handling state
        this.fallbackNotificationInterval = null;
        this.extensionStartupTime = Date.now();
        this.isInitialized = false;
        
        // Detect if running on Android (will be set during initialize)
        this.isAndroid = false;

        // Initialize everything properly with async handling
        this.initialize();
    }
    
    async detectPlatform() {
        try {
            const platformInfo = await browser.runtime.getPlatformInfo();
            this.isAndroid = platformInfo.os === 'android';
            console.log(`[Platform] Running on ${this.isAndroid ? 'Android' : 'Desktop'}`);
        } catch (error) {
            console.warn('[Platform] Could not detect platform, assuming Desktop');
            this.isAndroid = false;
        }
    }

    async initialize() {
        try {
            // Detect platform FIRST before setting up listeners
            await this.detectPlatform();
            
            // console.log("[Background] Starting initialization...");
            await this.initializeTimer();
            this.setupMessageListener();
            this.setupAlarmListener();
            this.setupNavigationListener();
            this.setupExtensionLifecycleHandlers();
            this.setupStorageChangeListener(); // Listen for storage changes
            await this.loadBlockedSites(); // Wait for blocked sites to load
            await this.performStartupCleanup();
            this.isInitialized = true;
            console.log("[Background] ✅ Background script initialized successfully");

            // Set up periodic check
            this.setupPeriodicBlockingCheck();
        } catch (error) {
            console.error("[Background] Error during initialization:", error);
            // Retry initialization after a delay
            setTimeout(() => this.initialize(), 2000);
        }
    }
    
    setupStorageChangeListener() {
        // Listen for storage changes to keep blocking state in sync
        browser.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            
            console.log("[Storage] Storage changed:", Object.keys(changes));
            
            // If blocked sites changed, reload them and update blocking
            if (changes.blockedSites) {
                console.log("[Storage] Blocked sites changed, reloading...");
                this.loadBlockedSites();
            }
            
            // If blocking mode changed, update blocking
            if (changes.blockingMode) {
                console.log("[Storage] Blocking mode changed to:", changes.blockingMode.newValue);
                if (this.settings) {
                    this.settings.blockingMode = changes.blockingMode.newValue;
                }
                this.updateBlocking();
            }
        });
    }

    async initializeTimer() {
        try {
            const result = await browser.storage.local.get([
                'focusTime', 'breakTime', 'longBreakTime', 'sessionsCount',
                'currentSession', 'totalSessions', 'timeLeft', 'currentPhase',
                'isRunning', 'isPaused', 'autoStart', 'blockingMode'
            ])

            this.settings = {
                focusTime: result.focusTime || 25,
                breakTime: result.breakTime || 5,
                longBreakTime: result.longBreakTime || 15,
                sessionsCount: result.sessionsCount || 4,
                autoStart: result.autoStart || false,
                blockingMode: result.blockingMode || 'focus-only'
            };
            this.state = {
                currentSession: result.currentSession || 1,
                totalSessions: result.totalSessions || this.settings.sessionsCount,
                timeLeft: result.timeLeft || (this.settings.focusTime * 60),
                currentPhase: result.currentPhase || 'focus',
                isRunning: result.isRunning || false,
                isPaused: result.isPaused || false
            };

            await this.saveState();
            console.log("[Background] Timer state initialized:", this.state);
        } catch (error) {
            console.error("[Background] Error initializing timer:", error);
            throw error;
        }
    }

    setupMessageListener() {
        browser.runtime.onMessage.addListener((request, _sender, sendResponse) => {
            switch (request.action) {
                case 'startTimer':
                    this.startTimer();
                    sendResponse({ success: true });
                    break;
                case 'pauseTimer':
                    this.pauseTimer();
                    sendResponse({ success: true });
                    break;
                case 'resetTimer':
                    this.resetTimer();
                    sendResponse({ success: true });
                    break;
                case 'updateSettings':
                    this.updateSettings(request.settings);
                    sendResponse({ success: true });
                    break;
                case 'updateBlocklist':
                    this.loadBlockedSites();
                    sendResponse({ success: true });
                    break;
                case 'timerTick':
                    this.handleTimerTick(request.tabId, request.timeRemaining);
                    sendResponse({ success: true });
                    break;
                case 'timerExpired':
                    this.forceRefreshTab(request.tabId);
                    sendResponse({ success: true });
                    break;
                case 'requestTimerSync':
                    this.handleTimerSyncRequest(request.tabId, request.currentTime);
                    sendResponse({ success: true });
                    break;
                case 'getCurrentTabId':
                    // Helper method to get current tab ID for content scripts
                    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
                        if (tabs && tabs.length > 0) {
                            sendResponse({ tabId: tabs[0].id });
                        } else {
                            sendResponse({ tabId: null });
                        }
                    });
                    break;
                case 'overrideBlock':
                    // Handle override block request - Works for both Desktop and Android
                    (async () => {
                        try {
                            // Check if override is already active to prevent duplicate requests
                            if (this.state.overrideUntil && Date.now() < this.state.overrideUntil) {
                                console.log('[Timer] Override already active, returning success');
                                sendResponse({ success: true, overrideSeconds: Math.ceil((this.state.overrideUntil - Date.now()) / 1000) });
                                return;
                            }
                            
                            const result = await browser.storage.local.get('overrideTime');
                            const overrideMinutes = result.overrideTime || 1;
                            const overrideDurationMs = overrideMinutes * 60 * 1000;
                            const currentTime = Date.now();
                            const overrideSeconds = overrideMinutes * 60;

                            // Set override state FIRST - this is checked by blockingListener
                            this.state.overrideUntil = currentTime + overrideDurationMs;
                            this.state.overrideStartTime = currentTime;
                            this.state.overrideDuration = overrideDurationMs;
                            
                            // Store domain for the override
                            if (request.originalUrl) {
                                this.state.overrideDomain = this.normalizeUrl(request.originalUrl);
                                console.log(`[Timer] Override granted for domain: ${this.state.overrideDomain}`);
                            }

                            // Disable blocking listener
                            console.log('[Timer] Disabling blocking for override period');
                            this.disableBlocking();
                            
                            // Save state
                            await this.saveState();
                            
                            // Start expiration check to re-enable blocking
                            this.startOverrideExpirationCheck();

                            // Show notification
                            const timeText = overrideMinutes === 1 ? '1 minute' : `${overrideMinutes} minutes`;
                            this.showOverrideNotification('start', `Temporary access for ${timeText}`);

                            console.log('[Timer] Override active, blocking disabled');
                            
                            // On Desktop: inject floating timer after redirect
                            if (!this.isAndroid) {
                                setTimeout(() => {
                                    this.tryInjectTimerByDomain(overrideSeconds);
                                }, 2000);
                            }
                            
                            sendResponse({ success: true, overrideSeconds: overrideSeconds });
                        } catch (error) {
                            console.error('[Timer] Error processing override request:', error);
                            sendResponse({ success: false, error: error.message });
                        }
                    })();
                    return true; 
                case 'trackBreathingInteraction':
                    this.trackBreathingInteraction(request.interaction);
                    sendResponse({ success: true });
                    break;
                case 'updateBlockingMode':
                    // Handle blocking mode update asynchronously
                    (async () => {
                        try {
                            await this.updateBlockingModeFromMessage(request.blockingMode);
                            sendResponse({ success: true });
                        } catch (error) {
                            console.error('[Background] Error updating blocking mode:', error);
                            sendResponse({ success: false, error: error.message });
                        }
                    })();
                    return true; // Keep message channel open for async response
                    break;
                case 'debugBlockingState':
                    // Debug function to check blocking state
                    this.debugBlockingState();
                    sendResponse({ success: true });
                    break;
            }

            // Return true to indicate async response handling
            return true;
        });
    }

    setupAlarmListener() {
        browser.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === 'pomodoroTick') {
                this.tick();
            } else if (alarm.name === 'overrideExpirationCheck') {
                this.checkOverrideExpiration();
            } else if (alarm.name === 'blockingStateCheck') {
                this.verifyBlockingState();
            }
        });
    }

    setupNavigationListener() {
        // Listen for tab updates (navigation events)
        browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            try {
                // Skip if no URL
                if (!tab.url) return;
                
                // Skip extension pages
                if (tab.url.startsWith('moz-extension://') || tab.url.startsWith('chrome-extension://')) {
                    return;
                }
                
                // If override is active, don't block
                if (this.state.overrideUntil && Date.now() < this.state.overrideUntil) {
                    // On Desktop only: inject floating timer when page loads during override
                    if (!this.isAndroid && changeInfo.status === 'complete' && this.isSameDomainAsOverride(tab.url)) {
                        const elapsed = Date.now() - this.state.overrideStartTime;
                        const timeRemaining = Math.max(0, Math.ceil((this.state.overrideDuration - elapsed) / 1000));
                        if (timeRemaining > 0) {
                            this.injectFloatingTimer(tabId, timeRemaining);
                        }
                    }
                    return; // Don't block during override
                }
                
                // On Android: use tab-based blocking (redirect after page loads)
                // On Desktop: webRequest handles blocking, this is just a backup
                if (changeInfo.status === 'complete') {
                    this.checkAndBlockTab(tabId, tab.url);
                }
            } catch (error) {
                console.error(`[Navigation] Error handling tab update for tab ${tabId}:`, error);
            }
        });

        // Listen for tab removal to clean up override state
        browser.tabs.onRemoved.addListener((tabId, _removeInfo) => {
            try {
                if (this.state.overrideTabId === tabId) {
                    delete this.state.overrideTabId;
                    this.saveState();
                }
            } catch (error) {
                console.error(`[Navigation] Error handling tab removal:`, error);
            }
        });

        // Listen for tab activation changes
        browser.tabs.onActivated.addListener((activeInfo) => {
            try {
                // If override is active, don't do any blocking checks
                if (this.state.overrideUntil && Date.now() < this.state.overrideUntil) {
                    return;
                }

                // Check if the newly activated tab contains a blocked site
                browser.tabs.get(activeInfo.tabId).then(tab => {
                    if (tab && tab.url) {
                        this.checkAndBlockTab(activeInfo.tabId, tab.url);
                    }
                }).catch(error => {
                    // Ignore errors for tabs that no longer exist
                });
            } catch (error) {
                console.error(`[Navigation] Error handling tab activation:`, error);
            }
        });
    }

    async validateOverrideState() {
        if (!this.state.overrideTabId || !this.state.overrideUntil) {
            return;
        }

        try {
            // Check if override has expired
            if (Date.now() >= this.state.overrideUntil) {
                console.log('[Timer] Override expired during validation, cleaning up');
                this.cleanupOverrideForTab(this.state.overrideTabId);
                return;
            }

            // Check if override tab still exists
            const tab = await browser.tabs.get(this.state.overrideTabId);
            if (!tab) {
                console.log('[Timer] Override tab no longer exists during validation, cleaning up');
                this.cleanupOverrideForTab(this.state.overrideTabId);
                return;
            }

            // Check if tab is still on the override domain
            if (tab.url && !this.isSameDomainAsOverride(tab.url)) {
                console.log('[Timer] Override tab navigated away from domain during validation, cleaning up');
                this.cleanupOverrideForTab(this.state.overrideTabId);
                return;
            }

        } catch (error) {
            console.error('[Timer] Error validating override state:', error);
            // On error, clean up to prevent stuck state
            if (this.state.overrideTabId) {
                this.cleanupOverrideForTab(this.state.overrideTabId);
            }
        }
    }

    cleanupOverrideForTab(tabId) {
        // This method is no longer used in the simplified approach
        // Override cleanup is handled by checkOverrideExpiration
        console.log(`[Timer] cleanupOverrideForTab called for tab ${tabId} - no action needed`);
    }

    setupExtensionLifecycleHandlers() {
        // Handle extension startup/install events
        browser.runtime.onStartup.addListener(() => {
            console.log('[Extension] Extension startup detected');
            this.performStartupCleanup();
        });

        browser.runtime.onInstalled.addListener((details) => {
            console.log('[Extension] Extension installed/updated:', details.reason);
            if (details.reason === 'install' || details.reason === 'update') {
                this.performStartupCleanup();
            }
        });

        // Handle extension suspend/shutdown (when possible)
        if (browser.runtime.onSuspend) {
            browser.runtime.onSuspend.addListener(() => {
                console.log('[Extension] Extension suspending, performing cleanup');
                this.performShutdownCleanup();
            });
        }

        // Handle extension context invalidation
        browser.runtime.onConnect.addListener((port) => {
            port.onDisconnect.addListener(() => {
                if (browser.runtime.lastError) {
                    console.log('[Extension] Context invalidated, performing cleanup');
                    this.performShutdownCleanup();
                }
            });
        });
    }

    setupPeriodicBlockingCheck() {
        console.log("[Blocking] Setting up periodic blocking check (every 5 seconds)");
        
        // Using alarms instead of setInterval for more reliable execution
        browser.alarms.create('blockingStateCheck', { periodInMinutes: 5 / 60 }); // Every 5 seconds
        
        // Verifying blocking state when any tab is activated
        browser.tabs.onActivated.addListener(() => {
            // Small delay to avoid race conditions
            setTimeout(() => this.verifyBlockingState(), 500);
        });
        
        // Verifying on window focus changes (user returning to browser)
        browser.windows.onFocusChanged.addListener((windowId) => {
            if (windowId !== browser.windows.WINDOW_ID_NONE) {
                console.log("[Blocking] Window focus changed, verifying blocking state");
                setTimeout(() => this.verifyBlockingState(), 300);
            }
        });
    }
    
    verifyBlockingState() {
        if (!this.isInitialized || !this.state || !this.blockedSites) {
            console.log("[Blocking] Verify skipped - not initialized");
            return;
        }
        
        // Don't do anything during override
        if (this.state.overrideUntil && Date.now() < this.state.overrideUntil) {
            return;
        }
        
        // On Android, we don't use webRequest - skip this check
        if (this.isAndroid) {
            return;
        }

        const blockingMode = this.getBlockingMode();
        
        // For 'always' mode, we should always have the listener if there are blocked sites
        // For 'focus-only' mode, we only need the listener during focus sessions
        let shouldHaveListener = false;
        
        if (this.blockedSites.length > 0) {
            if (blockingMode === 'always') {
                shouldHaveListener = true;
            } else if (blockingMode === 'focus-only') {
                shouldHaveListener = this.state.isRunning && this.state.currentPhase === 'focus';
            }
        }
        
        const hasListener = browser.webRequest.onBeforeRequest.hasListener(this.blockingListener);
        
        // Only log when there's a mismatch or periodically for debugging
        if (shouldHaveListener !== hasListener) {
            if (shouldHaveListener && !hasListener) {
                this.enableBlocking();
            } else if (!shouldHaveListener && hasListener) {
                this.disableBlocking();
            }
        }
    }

    async performStartupCleanup() {
        console.log('[Extension] Performing startup cleanup');

        try {
            // Clear any stale override state from previous session
            const result = await browser.storage.local.get([
                'overrideUntil', 'overrideTabId', 'overrideStartTime',
                'overrideDuration', 'overrideDomain', 'timerInjectionSuccessful'
            ]);

            let needsCleanup = false;

            // Check if there was an active override from previous session
            if (result.overrideUntil) {
                const now = Date.now();
                if (now >= result.overrideUntil) {
                    console.log('[Extension] Found expired override from previous session, cleaning up');
                    needsCleanup = true;
                } else if (result.overrideTabId) {
                    // Check if the override tab still exists
                    try {
                        await browser.tabs.get(result.overrideTabId);
                        console.log('[Extension] Override tab still exists, maintaining state');
                        // Tab exists, restore override state
                        this.state.overrideUntil = result.overrideUntil;
                        this.state.overrideTabId = result.overrideTabId;
                        this.state.overrideStartTime = result.overrideStartTime;
                        this.state.overrideDuration = result.overrideDuration;
                        this.state.overrideDomain = result.overrideDomain;
                        this.state.timerInjectionSuccessful = result.timerInjectionSuccessful;

                        // Restart expiration check
                        this.startOverrideExpirationCheck();
                        
                        // On Desktop: try to re-inject timer if it was successful before
                        // On Android: skip injection (causes loading issues)
                        if (!this.isAndroid && result.timerInjectionSuccessful) {
                            const elapsed = now - result.overrideStartTime;
                            const timeRemaining = Math.max(0, Math.ceil((result.overrideDuration - elapsed) / 1000));
                            if (timeRemaining > 0) {
                                this.injectFloatingTimer(result.overrideTabId, timeRemaining);
                            }
                        }
                    } catch (error) {
                        console.log('[Extension] Override tab no longer exists, cleaning up');
                        needsCleanup = true;
                    }
                }
            }

            if (needsCleanup) {
                await this.clearStaleOverrideState();
            }

            // Clear any stale alarms
            await browser.alarms.clear('overrideExpirationCheck');

        } catch (error) {
            console.error('[Extension] Error during startup cleanup:', error);
        }
    }

    performShutdownCleanup() {
        console.log('[Extension] Performing shutdown cleanup');

        // Clear fallback notification intervals
        if (this.fallbackNotificationInterval) {
            clearInterval(this.fallbackNotificationInterval);
            this.fallbackNotificationInterval = null;
        }

        // Clear all alarms
        browser.alarms.clearAll().catch(error => {
            console.error('[Extension] Error clearing alarms during shutdown:', error);
        });

        // Note: We don't clear override state here as it should persist across extension restarts
        // unless the extension is being uninstalled
    }

    async clearStaleOverrideState() {
        try {
            await browser.storage.local.remove([
                'overrideUntil', 'overrideTabId', 'overrideStartTime',
                'overrideDuration', 'overrideDomain', 'timerInjectionSuccessful'
            ]);

            // Clear from current state
            delete this.state.overrideUntil;
            delete this.state.overrideTabId;
            delete this.state.overrideStartTime;
            delete this.state.overrideDuration;
            delete this.state.overrideDomain;
            delete this.state.timerInjectionSuccessful;

            console.log('[Extension] Stale override state cleared');
        } catch (error) {
            console.error('[Extension] Error clearing stale override state:', error);
        }
    }

    handleTabNavigation(tabId, newUrl) {
        const now = Date.now();
        
        // Android-specific: Don't process navigation events within 30 seconds of override being set
        // This prevents premature cleanup during the redirect process
        if (this.state.overrideStartTime && (now - this.state.overrideStartTime) < 30000) {
            console.log(`[Timer] Ignoring navigation event during override grace period (${now - this.state.overrideStartTime}ms since override)`);
            return;
        }
        
        // Check if this is the override tab
        if (this.state.overrideTabId === tabId) {
            // If navigating to a non-injectable URL, just clear the tab ID but keep domain override
            if (!this.isInjectableUrl(newUrl)) {
                console.log(`[Timer] Navigation to non-injectable URL ${newUrl}, clearing tab ID but keeping domain override`);
                delete this.state.overrideTabId;
                this.saveState();
                return;
            }

            // If navigating away from override domain, clean up override completely
            if (!this.isSameDomainAsOverride(newUrl)) {
                console.log(`[Timer] Navigation away from override domain, cleaning up override`);
                this.cleanupOverrideForTab(tabId);
            }
        }
    }

    async cleanupOverrideForWindow(windowId) {
        if (!this.state.overrideTabId) return;

        try {
            // Check if the override tab was in the closed window
            const tab = await browser.tabs.get(this.state.overrideTabId);
            if (tab && tab.windowId === windowId) {
                console.log(`[Timer] Override tab was in closed window, cleaning up`);
                this.cleanupOverrideForTab(this.state.overrideTabId);
            }
        } catch (error) {
            // Tab doesn't exist anymore, clean up anyway
            console.log(`[Timer] Override tab no longer exists, cleaning up`);
            this.cleanupOverrideForTab(this.state.overrideTabId);
        }
    }

    async loadBlockedSites() {
        // console.log("[Blocking] Loading blocked sites from storage");
        try {
            const result = await browser.storage.local.get('blockedSites');
            this.blockedSites = result.blockedSites || [];
            // console.log("[Blocking] Current blocked sites:", this.blockedSites);

            // Validate the sites array
            if (!Array.isArray(this.blockedSites)) {
                // console.error("[Blocking] Invalid blockedSites format, resetting to empty array");
                this.blockedSites = [];
                await browser.storage.local.set({ blockedSites: [] });
            }

            this.updateBlocking();
            return true;
        } catch (err) {
            // console.error("[Blocking] Error loading blocked sites:", err);
            this.blockedSites = [];
            this.updateBlocking();
            return false;
        }
    }

    getBlockingMode() {
        return this.settings?.blockingMode || 'focus-only';
    }

    async updateBlockingModeFromMessage(newBlockingMode) {
        try {
            // Update the settings object
            if (!this.settings) {
                this.settings = {};
            }
            this.settings.blockingMode = newBlockingMode;

            // Save to storage
            await browser.storage.local.set({ blockingMode: newBlockingMode });
            
            // Immediately apply new blocking behavior
            // This will re-create the listener if needed
            this.updateBlocking();
            
            // Verify the blocking state is correct after update
            setTimeout(() => this.verifyBlockingState(), 100);
        } catch (error) {
            console.error('[Blocking] Error saving blocking mode:', error);
            throw error; // Re-throw so the message handler can catch it
        }
    }

    // Enhanced URL normalization to handle edge cases
    normalizeUrl(url) {
        if (!url || typeof url !== 'string') {
            return null;
        }

        try {
            // Handle URLs without protocol by adding https://
            let normalizedUrl = url.trim();
            if (!/^https?:\/\//i.test(normalizedUrl)) {
                normalizedUrl = 'https://' + normalizedUrl;
            }

            const urlObj = new URL(normalizedUrl);

            // Extract hostname and normalize
            let hostname = urlObj.hostname;

            // Handle special characters and internationalized domain names
            try {
                // Convert to ASCII if possible (handles IDN domains)
                hostname = hostname.toLowerCase();
            } catch (error) {
                console.warn('[URL] Could not normalize hostname with special characters:', hostname);
                hostname = hostname.toLowerCase();
            }

            // Remove www. prefix for consistent matching
            hostname = hostname.replace(/^www\./i, '');

            // Handle edge case of empty hostname after www removal
            if (!hostname) {
                return null;
            }

            return hostname;
        } catch (error) {
            // Handle invalid URLs gracefully
            console.warn('[URL] Invalid URL provided for normalization:', url, error.message);
            return null;
        }
    }

    // Enhanced URL matching with improved subdomain support
    isUrlBlocked(url, blockedSites) {
        if (!url || !blockedSites || !Array.isArray(blockedSites) || blockedSites.length === 0) {
            return false;
        }
        try {
            const urlObj = new URL(url);
            return blockedSites.some(site => {
                if (!site || typeof site !== 'string') return false;

                const [siteDomain, ...sitePathParts] = site.split('/');

                const sitePath = sitePathParts.length ? '/' + sitePathParts.join('/') : '';

                // Normalize domain (remove www.)
                const urlHost = urlObj.hostname.replace(/^www\./i, '');

                const siteHost = siteDomain.replace(/^www\./i, '');

                // Match domain
                if (!urlHost.endsWith(siteHost)) return false;

                // If a path is specified, match the start of the pathname
                if (sitePath && !urlObj.pathname.startsWith(sitePath)) return false;
                return true;
            });
        } catch (e) {
            return false;
        }
    }

    // Extract domain from URL for blocking (enhanced version)
    extractDomain(url) {
        const normalized = this.normalizeUrl(url);
        return normalized;
    }

    shouldBlockTab(url, timerState, blockingMode) {
        // If no URL provided, don't block
        if (!url) {
            return false;
        }

        // If no blocked sites configured, don't block
        if (!this.blockedSites || this.blockedSites.length === 0) {
            return false;
        }

        // Use enhanced URL matching logic
        const isUrlBlocked = this.isUrlBlocked(url, this.blockedSites);

        // If URL is not in blocked list, don't block
        if (!isUrlBlocked) {
            return false;
        }

        // Apply blocking decision matrix based on timer state and blocking mode
        const isTimerRunning = timerState?.isRunning || false;
        const currentPhase = timerState?.currentPhase || 'focus';

        switch (blockingMode) {
            case 'focus-only':
                // Only block during active focus sessions
                return isTimerRunning && currentPhase === 'focus';

            case 'always':
                // Block at all times if URL is in blocked list
                return true;

            default:
                // Default to focus-only behavior
                return isTimerRunning && currentPhase === 'focus';
        }
    }

    enableBlocking() {
        console.log("[Blocking] Attempting to enable blocking");
        
        // Force remove any existing listener first to ensure clean state
        try {
            if (browser.webRequest.onBeforeRequest.hasListener(this.blockingListener)) {
                console.log("[Blocking] Removing existing listener before re-adding");
                browser.webRequest.onBeforeRequest.removeListener(this.blockingListener);
            }
        } catch (err) {
            console.warn("[Blocking] Error checking/removing existing listener:", err);
            // If hasListener fails, the listener reference might be stale - rebind it
            console.log("[Blocking] Re-binding blockingListener due to error");
            this.blockingListener = this._createBlockingListener();
        }
        
        // Now add the listener fresh
        try {
            browser.webRequest.onBeforeRequest.addListener(
                this.blockingListener,
                { urls: ["<all_urls>"], types: ["main_frame"] },
                ["blocking"]
            );
            console.log("[Blocking] Listener successfully added");
            
            // Verify it was actually added
            const verified = browser.webRequest.onBeforeRequest.hasListener(this.blockingListener);
            console.log(`[Blocking] Listener verification: ${verified ? ' CONFIRMED' : 'FAILED'}`);
            
            if (!verified) {
                console.error("[Blocking] Listener was not added successfully, trying with fresh listener");
                // Try one more time with a fresh listener
                this.blockingListener = this._createBlockingListener();
                browser.webRequest.onBeforeRequest.addListener(
                    this.blockingListener,
                    { urls: ["<all_urls>"], types: ["main_frame"] },
                    ["blocking"]
                );
            }
        } catch (err) {
            console.error("[Blocking] Error adding listener:", err);
        }
    }
    
    // Factory method to create a fresh blocking listener bound to this instance
    _createBlockingListener() {
        return (details) => {
            // CRITICAL: Check override state FIRST before any blocking
            if (this.state && this.state.overrideUntil) {
                const now = Date.now();
                if (now < this.state.overrideUntil) {
                    return; // Override is active - allow ALL requests
                }
            }
            
            if (!this.state || !this.blockedSites || this.blockedSites.length === 0) {
                return;
            }
            
            const blockingMode = this.getBlockingMode();
            const shouldBlock = this.shouldBlockTab(details.url, this.state, blockingMode);

            if (!shouldBlock) {
                return;
            }

            const isBlocked = this.isUrlBlocked(details.url, this.blockedSites);

            if (isBlocked) {
                const timerRunning = this.state.isRunning;
                const currentPhase = this.state.currentPhase;

                const redirectPath = "resources/blocked.html?url=" + encodeURIComponent(details.url) +
                    "&mode=" + encodeURIComponent(blockingMode) +
                    "&timerRunning=" + encodeURIComponent(timerRunning) +
                    "&phase=" + encodeURIComponent(currentPhase);
                const fullUrl = browser.runtime.getURL(redirectPath);

                console.log(`[Blocking] Redirecting ${details.url} to blocked page`);
                return { redirectUrl: fullUrl };
            }
        };
    }

    disableBlocking() {
        console.log("[Blocking] Attempting to disable blocking");
        if (browser.webRequest.onBeforeRequest.hasListener(this.blockingListener)) {
            console.log("[Blocking] Removing webRequest listener");
            browser.webRequest.onBeforeRequest.removeListener(this.blockingListener);
            console.log("[Blocking] Listener successfully removed");
        } else {
            console.log("[Blocking] No listener to remove");
        }
    }

    updateBlocking() {
        console.log("[Blocking] updateBlocking called");
        console.log("[Blocking] State:", this.state ? "initialized" : "not initialized");
        console.log("[Blocking] Blocked sites:", this.blockedSites ? this.blockedSites.length : "not loaded");

        if (!this.state || !this.blockedSites) {
            return;
        }

        // On Android, we don't use webRequest blocking - we use tab monitoring instead
        // The navigation listener handles blocking by checking tabs after they load
        if (this.isAndroid) {
            console.log("[Blocking] Android mode - using tab monitoring instead of webRequest");
            return;
        }

        const blockingMode = this.getBlockingMode();

        let shouldBlock = false;

        if (this.blockedSites.length > 0) {
            switch (blockingMode) {
                case 'focus-only':
                    shouldBlock = this.state.isRunning && this.state.currentPhase === 'focus';
                    break;
                case 'always':
                    shouldBlock = true;
                    break;
                default:
                    shouldBlock = this.state.isRunning && this.state.currentPhase === 'focus';
                    break;
            }
        }

        if (shouldBlock) {
            this.enableBlocking();
        } else {
            this.disableBlocking();
        }
    }

    startTimer() {
        if (!this.state.isRunning) {
            this.state.isRunning = true;
            this.state.isPaused = false;
            if (this.state.overrideUntil && Date.now() > this.state.overrideUntil) {
                delete this.state.overrideUntil;
                delete this.state.overrideTabId;
                delete this.state.overrideStartTime;
                delete this.state.overrideDuration;
                delete this.state.overrideDomain;
                browser.alarms.clear('overrideExpirationCheck');
            }
            browser.alarms.create('pomodoroTick', { periodInMinutes: 1 / 60 });
            this.updateBadge();
            this.saveState();
            this.updateBlocking();
            const phaseText = this.state.currentPhase === 'focus' ? 'Focus session' : 'Break time';
            this.showNotification(`${phaseText} started!`, `Session ${this.state.currentSession} of ${this.state.totalSessions}`);
        }
    }

    pauseTimer() {
        if (this.state.isRunning) {
            this.state.isRunning = false;
            this.state.isPaused = true;
            browser.alarms.clear('pomodoroTick');
            this.updateBadge();
            this.saveState();
            this.updateBlocking();
            this.showNotification('Timer paused', 'Click to resume when ready');
        }
    }

    resetTimer() {
        this.state.isRunning = false;
        this.state.isPaused = false;
        this.state.currentSession = 1;
        this.state.currentPhase = 'focus';
        this.state.timeLeft = this.settings.focusTime * 60;
        delete this.state.overrideUntil;
        delete this.state.overrideTabId;
        delete this.state.overrideStartTime;
        delete this.state.overrideDuration;
        delete this.state.overrideDomain;
        browser.alarms.clear('pomodoroTick');
        browser.alarms.clear('overrideExpirationCheck');
        this.updateBadge();
        this.saveState();
        this.updateBlocking();
        this.showNotification('Timer reset', 'Ready for a new session');
    }

    tick() {
        if (!this.state.isRunning) {
            // console.log("[Timer] Ticked but timer not running");
            return;
        }

        // console.log(`[Timer] Tick! Time left: ${this.state.timeLeft}s`);
        this.state.timeLeft--;
        this.updateBadge();
        this.saveState();
        if (this.state.timeLeft <= 0) {
            this.handlePhaseComplete();
        }
    }

    handlePhaseComplete() {
        browser.alarms.clear('pomodoroTick');
        if (this.state.currentPhase === 'focus') {
            this.showNotification('🎉 Focus session completed!', `Great job! Session ${this.state.currentSession} done.`);
            const isLongBreak = this.state.currentSession % 4 === 0;
            this.state.currentPhase = isLongBreak ? 'longBreak' : 'shortBreak';
            this.state.timeLeft = isLongBreak ? this.settings.longBreakTime * 60 : this.settings.breakTime * 60;
        } else {
            const breakType = this.state.currentPhase === 'longBreak' ? 'Long break' : 'Short break';
            this.showNotification(`${breakType} finished!`, 'Ready for the next session?');
            this.state.currentSession++;
            if (this.state.currentSession > this.state.totalSessions) {
                this.showNotification('🏆 All sessions completed!', `Congratulations! You completed ${this.state.totalSessions} focus sessions.`);
                this.resetTimer();
                return;
            }
            this.state.currentPhase = 'focus';
            this.state.timeLeft = this.settings.focusTime * 60;
        }

        if (this.settings.autoStart) {
            this.startTimer();
        } else {
            this.state.isRunning = false;
            const nextPhase = this.state.currentPhase === 'focus' ? 'next focus session' : 'break';
            this.showNotification(`Time for your ${nextPhase}!`, 'Click start when ready');
        }
        this.updateBadge();
        this.saveState();
        this.updateBlocking();
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        this.state.totalSessions = this.settings.sessionsCount;

        if (!this.state.isRunning) {
            if (this.state.currentPhase === 'focus') {
                this.state.timeLeft = newSettings.focusTime * 60;
            } else if (this.state.currentPhase === 'shortBreak') {
                this.state.timeLeft = newSettings.breakTime * 60;
            } else if (this.state.currentPhase === 'longBreak') {
                this.state.timeLeft = newSettings.longBreakTime * 60;
            }
        }

        if (this.state.currentSession > this.settings.sessionsCount) {
            this.state.currentSession = this.settings.sessionsCount;
        }

        browser.storage.local.set({ ...this.settings, totalSessions: this.state.totalSessions });
        this.updateBadge();
        this.saveState();
        this.showNotification('Settings updated!', 'Timer has been updated with new settings');
    }

    updateBadge() {
        const timeLeft = this.state.timeLeft;
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;

        let badgeColor = '#3498db';
        let badgeText = '';

        if (this.state.isRunning) {
            badgeColor = (this.state.currentPhase === 'focus') ? '#e74c3c' : '#27ae60';

            if (minutes > 9) {
                badgeText = `${minutes}`;
            } else if (minutes > 0) {
                badgeText = `${minutes}m`;
            } else {
                badgeText = `${seconds}`;
            }

            badgeText = badgeText.substring(0, 2);
        }
        else if (this.state.isPaused) {
            badgeColor = '#f39c12';
            badgeText = '❚❚';
        }
        else {
            badgeText = '▶';
        }

        browser.action.setBadgeText({ text: badgeText });
        browser.action.setBadgeBackgroundColor({ color: badgeColor });
    }

    showNotification(title, message) {
        // Use a fixed ID to prevent duplicate notifications
        // This will replace any existing notification with the same ID
        browser.notifications.create('pomodoro-override-notification', {
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/timer-48.png'),
            title: title,
            message: message
        });
    }

    showOverrideNotification(type, message) {
        // Only show notifications at start and end of temporary access period
        if (type === 'start') {
            this.showNotification('Temporary Access Granted', message);
        } else if (type === 'end') {
            this.showNotification('Temporary Access Ended', message);
        }
    }

    async saveState() {
        try {
            await browser.storage.local.set({
                ...this.state,
                ...this.settings,
                lastSaved: Date.now()
            });
            console.log('[Background] State saved successfully');
        } catch (error) {
            console.error('[Background] Error saving state:', error);
        }
    }
    
    async navigateCurrentTabTo(url) {
        try {
            // Get the current active tab
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs.length > 0) {
                const tabId = tabs[0].id;
                console.log(`[Navigation] Navigating tab ${tabId} to ${url}`);
                
                // Use tabs.update to navigate - this happens after blocking is disabled
                await browser.tabs.update(tabId, { url: url });
                console.log(`[Navigation] Navigation initiated for tab ${tabId}`);
            } else {
                console.warn('[Navigation] No active tab found');
            }
        } catch (error) {
            console.error('[Navigation] Error navigating tab:', error);
        }
    }

    async tryInjectTimerByDomain(overrideSeconds) {
        try {
            // Check if override is still active
            if (!this.state.overrideUntil || Date.now() >= this.state.overrideUntil) {
                console.log('[Timer] Override no longer active, skipping timer injection');
                return;
            }
            
            if (!this.state.overrideDomain) {
                console.log('[Timer] No override domain set, skipping timer injection');
                return;
            }
            
            // Find tabs matching the override domain (works on Android without relying on specific tabId)
            const allTabs = await browser.tabs.query({});
            const matchingTabs = allTabs.filter(tab => 
                tab.url && this.isSameDomainAsOverride(tab.url)
            );
            
            if (matchingTabs.length === 0) {
                console.log(`[Timer] No tabs found for domain ${this.state.overrideDomain}`);
                return;
            }
            
            // Calculate remaining time
            const elapsed = Date.now() - this.state.overrideStartTime;
            const timeRemaining = Math.max(0, Math.ceil((this.state.overrideDuration - elapsed) / 1000));
            
            if (timeRemaining <= 0) {
                console.log('[Timer] No time remaining, skipping injection');
                return;
            }
            
            // Inject timer into all matching tabs (usually just one)
            for (const tab of matchingTabs) {
                console.log(`[Timer] Injecting timer into tab ${tab.id} (${tab.url}) with ${timeRemaining}s remaining`);
                try {
                    await this.injectFloatingTimer(tab.id, timeRemaining);
                } catch (injectionError) {
                    console.warn(`[Timer] Failed to inject into tab ${tab.id}:`, injectionError);
                }
            }
            
        } catch (error) {
            console.error('[Timer] Error in domain-based timer injection:', error);
        }
    }

    async injectFloatingTimer(tabId, timeRemaining, retryCount = 0) {
        const maxRetries = 1; // Reduced retries for Android

        try {
            // Validate tab exists and is accessible
            const tab = await browser.tabs.get(tabId);
            if (!tab || !tab.url) {
                throw new Error('Tab not found or has no URL');
            }

            // Check if tab URL is injectable (not chrome://, about:, etc.)
            if (!this.isInjectableUrl(tab.url)) {
                console.log(`[Timer] Cannot inject into URL: ${tab.url}, using fallback notification`);
                this.activateFallbackNotificationSystem(timeRemaining);
                return;
            }

            // Android-specific: Skip injection for certain problematic sites
            if (this.isProblematicForAndroid(tab.url)) {
                console.log(`[Timer] Skipping injection for Android-problematic site: ${tab.url}`);
                this.activateFallbackNotificationSystem(timeRemaining);
                return;
            }

            // Check if tab is still loading with shorter timeout for Android
            if (tab.status === 'loading') {
                console.log(`[Timer] Tab ${tabId} still loading, waiting...`);
                await this.waitForTabComplete(tabId, 3000); // Reduced to 3 seconds for Android
            }

            console.log(`[Timer] Attempting to inject timer into tab ${tabId} (attempt ${retryCount + 1})`);

            // Android-specific: Try injection with timeout
            const injectionPromise = this.performInjection(tabId, timeRemaining);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Injection timeout')), 5000)
            );

            await Promise.race([injectionPromise, timeoutPromise]);

            console.log(`[Timer] Successfully injected floating timer into tab ${tabId} with ${timeRemaining} seconds`);

            // Mark injection as successful
            this.state.timerInjectionSuccessful = true;
            this.saveState();

        } catch (error) {
            console.error(`[Timer] Failed to inject floating timer into tab ${tabId} (attempt ${retryCount + 1}):`, error);

            // Android-specific: Don't retry on certain errors
            if (this.isAndroidFatalError(error) || retryCount >= maxRetries) {
                console.log(`[Timer] Using fallback notification for tab ${tabId}`);
                this.state.timerInjectionSuccessful = false;
                this.saveState();
                this.activateFallbackNotificationSystem(timeRemaining);
                return;
            }

            // Retry logic for transient failures
            if (retryCount < maxRetries && this.shouldRetryInjection(error)) {
                console.log(`[Timer] Retrying injection for tab ${tabId} in ${2000}ms`);
                setTimeout(() => {
                    this.injectFloatingTimer(tabId, timeRemaining, retryCount + 1);
                }, 2000);
                return;
            }

            // Final fallback
            this.state.timerInjectionSuccessful = false;
            this.saveState();
            this.activateFallbackNotificationSystem(timeRemaining);
        }
    }

    async performInjection(tabId, timeRemaining) {
        // First inject the CSS with error handling
        try {
            await browser.scripting.insertCSS({
                target: { tabId: tabId },
                files: ['resources/floating-timer.css']
            });
        } catch (cssError) {
            console.warn(`[Timer] CSS injection failed for tab ${tabId}:`, cssError);
            // Continue anyway - JS can apply basic styles
        }

        // Then inject the JavaScript
        await browser.scripting.executeScript({
            target: { tabId: tabId },
            files: ['resources/floating-timer.js']
        });

        // Wait for script to initialize
        await new Promise(resolve => setTimeout(resolve, 500));

        // Start the timer with the specified time
        await browser.tabs.sendMessage(tabId, {
            action: 'startTimer',
            initialTime: timeRemaining
        });
    }

    isProblematicForAndroid(url) {
        const problematicPatterns = [
            'youtube.com',
            'facebook.com',
            'instagram.com',
            'twitter.com',
            'tiktok.com'
        ];
        
        return problematicPatterns.some(pattern => url.includes(pattern));
    }

    isAndroidFatalError(error) {
        const fatalErrors = [
            'Cannot access',
            'Extension context invalidated',
            'Injection timeout',
            'The frame was removed'
        ];
        
        const errorMessage = error.message || error.toString();
        return fatalErrors.some(fatalError => errorMessage.includes(fatalError));
    }

    async waitForTabComplete(tabId, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();

            const checkTab = async () => {
                try {
                    const tab = await browser.tabs.get(tabId);
                    if (tab.status === 'complete') {
                        resolve();
                        return;
                    }

                    if (Date.now() - startTime > timeout) {
                        reject(new Error('Tab loading timeout'));
                        return;
                    }

                    setTimeout(checkTab, 100);
                } catch (error) {
                    reject(error);
                }
            };

            checkTab();
        });
    }

    shouldRetryInjection(error) {
        const retryableErrors = [
            'Could not establish connection',
            'The tab was closed',
            'No tab with id',
            'The frame was removed',
            'The message port closed before a response was received'
        ];

        const errorMessage = error.message || error.toString();
        return retryableErrors.some(retryableError =>
            errorMessage.includes(retryableError)
        );
    }

    isInjectableUrl(url) {
        if (!url) return false;

        const nonInjectableProtocols = [
            'chrome://',
            'chrome-extension://',
            'moz-extension://',
            'about:',
            'data:',
            'file://',
            'ftp://'
        ];

        return !nonInjectableProtocols.some(protocol => url.startsWith(protocol));
    }

    activateFallbackNotificationSystem(timeRemaining) {
        console.log(`[Timer] Activating fallback notification system for ${timeRemaining} seconds`);

        // Prevent multiple fallback notifications
        if (this.state.fallbackNotificationShown) {
            console.log(`[Timer] Fallback notification already shown, skipping`);
            return;
        }

        try {
            // Mark that we've shown the fallback notification
            this.state.fallbackNotificationShown = true;
            this.saveState();

            // Show single notification for Android
            const minutes = Math.ceil(timeRemaining / 60);
            const timeText = minutes === 1 ? '1 minute' : `${minutes} minutes`;
            
            this.showOverrideNotification(
                'start',
                `Temporary access granted for ${timeText}. Page will refresh when time expires.`
            );

        } catch (error) {
            console.error('[Timer] Error activating fallback notification system:', error);
        }
    }



    showBasicNotification(message) {
        try {
            // Try browser notification API first
            if (browser.notifications) {
                browser.notifications.create({
                    type: 'basic',
                    iconUrl: browser.runtime.getURL('icons/timer-48.png'),
                    title: 'Temporary Access',
                    message: message
                });
            } else {
                // Fallback to console log if notifications unavailable
                console.log(`[Timer] Notification: ${message}`);
            }
        } catch (error) {
            console.error('[Timer] Basic notification failed:', error);
        }
    }

    handleTimerTick(tabId, timeRemaining) {
        // Verify this is the correct override tab
        if (this.state.overrideTabId !== tabId) {
            console.warn(`[Timer] Timer tick from unexpected tab ${tabId}, expected ${this.state.overrideTabId}`);
            return;
        }

        // Check if override has already expired
        if (!this.state.overrideUntil || Date.now() >= this.state.overrideUntil) {
            console.log(`[Timer] Override already expired, forcing immediate refresh for tab ${tabId}`);
            this.forceRefreshTab(tabId);
            return;
        }

        // Calculate authoritative time remaining based on start time
        const elapsed = Date.now() - this.state.overrideStartTime;
        const authoritativeTimeRemaining = Math.max(0, Math.ceil((this.state.overrideDuration - elapsed) / 1000));

        // If time has expired (countdown reached zero), immediately block access
        if (authoritativeTimeRemaining <= 0) {
            console.log(`[Timer] Timer reached zero, immediately blocking access for tab ${tabId}`);
            this.forceRefreshTab(tabId);
            return;
        }

        // If there's a significant drift (more than 2 seconds), sync the timer
        if (Math.abs(timeRemaining - authoritativeTimeRemaining) > 2) {
            console.log(`[Timer] Syncing timer: content script shows ${timeRemaining}s, authoritative is ${authoritativeTimeRemaining}s`);

            try {
                browser.tabs.sendMessage(tabId, {
                    action: 'syncTimer',
                    timeRemaining: authoritativeTimeRemaining
                });
            } catch (error) {
                console.error(`[Timer] Failed to sync timer for tab ${tabId}:`, error);
            }
        }
    }

    handleTimerSyncRequest(tabId, currentTime) {
        // Verify this is the correct override tab
        if (this.state.overrideTabId !== tabId) {
            console.warn(`[Timer] Sync request from unexpected tab ${tabId}, expected ${this.state.overrideTabId}`);
            return;
        }

        // Check if override is still active
        if (!this.state.overrideUntil || Date.now() >= this.state.overrideUntil) {
            console.log(`[Timer] Override expired, forcing refresh for tab ${tabId}`);
            this.forceRefreshTab(tabId);
            return;
        }

        // Calculate authoritative time remaining
        const elapsed = Date.now() - this.state.overrideStartTime;
        const authoritativeTimeRemaining = Math.max(0, Math.ceil((this.state.overrideDuration - elapsed) / 1000));

        // Always send sync response for periodic sync requests
        try {
            browser.tabs.sendMessage(tabId, {
                action: 'syncTimer',
                timeRemaining: authoritativeTimeRemaining
            });

            console.log(`[Timer] Sent sync response: ${authoritativeTimeRemaining}s (content script had ${currentTime}s)`);
        } catch (error) {
            console.error(`[Timer] Failed to send sync response to tab ${tabId}:`, error);
        }

        // If time has expired, force refresh
        if (authoritativeTimeRemaining <= 0) {
            this.forceRefreshTab(tabId);
        }
    }

    async forceRefreshTab(tabId) {
        try {
            console.log(`[Timer] Timer expired - blocking access and refreshing tab ${tabId}`);

            // Android-specific: Add delay before clearing state to prevent race conditions
            await new Promise(resolve => setTimeout(resolve, 100));

            // First, reset the temporary access state
            delete this.state.overrideUntil;
            delete this.state.overrideTabId;
            delete this.state.overrideStartTime;
            delete this.state.overrideDuration;
            delete this.state.overrideDomain;
            delete this.state.fallbackNotificationShown; // Clear fallback flag
            
            // Android-specific: Save state multiple times to ensure persistence
            await this.saveState();
            await new Promise(resolve => setTimeout(resolve, 50));
            await this.saveState();

            // Clear the expiration check alarm since override is now expired
            browser.alarms.clear('overrideExpirationCheck');

            // Update blocking to ensure immediate blocking with delay for Android
            this.updateBlocking();
            await new Promise(resolve => setTimeout(resolve, 100));

            // Android-specific: Try to get tab info first to ensure it exists
            try {
                const tab = await browser.tabs.get(tabId);
                if (tab && tab.url) {
                    console.log(`[Timer] Tab ${tabId} exists, proceeding with refresh`);
                    // Force refresh the current page to show blocked page 
                    await browser.tabs.reload(tabId);
                    console.log(`[Timer] Successfully refreshed tab ${tabId} after timer expiration - access now blocked`);
                } else {
                    console.log(`[Timer] Tab ${tabId} has no URL or is invalid, skipping refresh`);
                }
            } catch (tabError) {
                console.warn(`[Timer] Tab ${tabId} no longer exists or is inaccessible:`, tabError);
                // Tab doesn't exist anymore, which is fine - the override is still cleared
            }

            // Show single end notification to inform user
            this.showOverrideNotification('end', 'Temporary access ended. Website blocked again.');
        } catch (error) {
            console.error(`[Timer] Failed to refresh tab ${tabId}:`, error);

            // Even if refresh fails, ensure override state is reset
            delete this.state.overrideUntil;
            delete this.state.overrideTabId;
            delete this.state.overrideStartTime;
            delete this.state.overrideDuration;
            delete this.state.overrideDomain;
            delete this.state.fallbackNotificationShown;
            
            // Android-specific: Multiple saves even in error case
            try {
                await this.saveState();
                await new Promise(resolve => setTimeout(resolve, 50));
                await this.saveState();
            } catch (saveError) {
                console.error(`[Timer] Failed to save state during error recovery:`, saveError);
            }

            // Clear the expiration check alarm
            browser.alarms.clear('overrideExpirationCheck');

            // Still update blocking state
            this.updateBlocking();

            // Show single error notification
            this.showNotification('Override Ended', 'Temporary access ended.');
        }
    }

    trackBreathingInteraction(interaction) {
        try {
            // Store breathing exercise interaction data
            console.log('[BreathingExercise] Tracking interaction:', interaction);

            // Get existing breathing exercise data from storage
            browser.storage.local.get(['breathingExerciseStats']).then(result => {
                const stats = result.breathingExerciseStats || {
                    totalSessions: 0,
                    totalBreaths: 0,
                    totalTime: 0,
                    interactions: []
                };

                // Add new interaction
                stats.interactions.push(interaction);

                // Update aggregated stats if this is a completed session
                if (interaction.action === 'breathing_exercise_completed') {
                    stats.totalSessions++;
                    stats.totalBreaths += interaction.data.breaths || 0;
                    stats.totalTime += interaction.data.duration || 0;
                }

                // Keep only last 100 interactions to prevent storage bloat
                if (stats.interactions.length > 100) {
                    stats.interactions.splice(0, stats.interactions.length - 100);
                }

                // Save updated stats
                browser.storage.local.set({ breathingExerciseStats: stats });

                console.log('[BreathingExercise] Updated stats:', {
                    totalSessions: stats.totalSessions,
                    totalBreaths: stats.totalBreaths,
                    totalTime: stats.totalTime
                });
            }).catch(error => {
                console.warn('[BreathingExercise] Could not save interaction data:', error);
            });

        } catch (error) {
            console.warn('[BreathingExercise] Error tracking interaction:', error);
        }
    }

    checkAndRefreshBlockedTab(tabId, url) {
        // Deprecated - use checkAndBlockTab instead
        this.checkAndBlockTab(tabId, url);
    }
    
    checkAndBlockTab(tabId, url) {
        try {
            // CRITICAL: If override is active, don't block anything
            if (this.state.overrideUntil && Date.now() < this.state.overrideUntil) {
                return;
            }

            // Skip extension pages
            if (url.startsWith('moz-extension://') || url.startsWith('chrome-extension://')) {
                return;
            }
            
            // Skip non-http URLs
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                return;
            }

            // Check if blocking should be active
            const blockingMode = this.getBlockingMode();
            const shouldBlock = this.shouldBlockTab(url, this.state, blockingMode);

            if (!shouldBlock) {
                return;
            }

            // IMPORTANT: Verify webRequest listener is still active
            // If it's not, re-enable it immediately
            if (this.blockedSites && this.blockedSites.length > 0) {
                const hasListener = browser.webRequest.onBeforeRequest.hasListener(this.blockingListener);
                if (!hasListener) {
                    console.warn("[Blocking] Listener lost! Re-enabling blocking immediately");
                    this.enableBlocking();
                }
            }

            // Check if URL is in blocked list
            const isBlocked = this.isUrlBlocked(url, this.blockedSites);
            if (!isBlocked) {
                return;
            }

            console.log(`[Blocking] Tab ${tabId} is on blocked site, redirecting to blocked page`);

            // Redirect to blocked page
            const timerRunning = this.state.isRunning;
            const currentPhase = this.state.currentPhase;
            const redirectPath = "resources/blocked.html?url=" + encodeURIComponent(url) +
                "&mode=" + encodeURIComponent(blockingMode) +
                "&timerRunning=" + encodeURIComponent(timerRunning) +
                "&phase=" + encodeURIComponent(currentPhase);
            const fullUrl = browser.runtime.getURL(redirectPath);

            browser.tabs.update(tabId, { url: fullUrl }).catch(error => {
                console.error(`[Blocking] Failed to redirect tab ${tabId}:`, error);
            });
        } catch (error) {
            console.error(`[Blocking] Error in checkAndBlockTab for tab ${tabId}:`, error);
        }
    }

    isSameDomainAsOverride(url) {
        if (!this.state.overrideDomain || !url) {
            return false;
        }

        const hostname = this.normalizeUrl(url);
        if (!hostname) {
            console.warn('[Timer] Could not normalize URL for domain check:', url);
            return false;
        }

        // Check if it's the same domain or a subdomain
        const isMatch = (
            hostname === this.state.overrideDomain ||
            hostname.endsWith(`.${this.state.overrideDomain}`)
        );

        console.log(`[Timer] Checking if ${hostname} matches override domain ${this.state.overrideDomain}: ${isMatch}`);
        return isMatch;
    }

    startOverrideExpirationCheck() {
        // Clear any existing expiration check
        browser.alarms.clear('overrideExpirationCheck');

        // Set up periodic check every 5 seconds
        browser.alarms.create('overrideExpirationCheck', {
            periodInMinutes: 5 / 60 // 5 seconds
        });

        console.log('[Timer] Started override expiration check alarm');
    }

    checkOverrideExpiration() {
        // Only check if we have an active override
        if (!this.state.overrideUntil) {
            // No active override, clear the alarm
            browser.alarms.clear('overrideExpirationCheck');
            return;
        }

        // Check if override has expired
        if (Date.now() >= this.state.overrideUntil) {
            console.log('[Timer] Override expired - re-enabling blocking');

            // Store domain before clearing for tab refresh
            const expiredDomain = this.state.overrideDomain;
            
            // Clear override state
            delete this.state.overrideUntil;
            delete this.state.overrideTabId;
            delete this.state.overrideStartTime;
            delete this.state.overrideDuration;
            delete this.state.overrideDomain;
            
            // Save state
            this.saveState();
            
            // Re-enable blocking
            this.updateBlocking();

            // Clear the expiration check alarm
            browser.alarms.clear('overrideExpirationCheck');
            
            // Find and refresh all tabs on the expired domain to show blocked page
            this.refreshTabsOnDomain(expiredDomain);

            // Show end notification
            this.showOverrideNotification('end', 'Temporary access ended. Blocking re-enabled.');
            
            console.log(`[Timer] Override for ${expiredDomain} has ended, blocking re-enabled`);
        }
    }
    
    async refreshTabsOnDomain(domain) {
        if (!domain) {
            console.log('[Timer] No domain provided for tab refresh');
            return;
        }
        
        try {
            // Find all tabs that match the expired domain
            const allTabs = await browser.tabs.query({});
            const matchingTabs = allTabs.filter(tab => {
                if (!tab.url) return false;
                const tabDomain = this.normalizeUrl(tab.url);
                return tabDomain === domain || (tabDomain && tabDomain.endsWith(`.${domain}`));
            });
            
            console.log(`[Timer] Found ${matchingTabs.length} tabs on domain ${domain} to refresh`);
            
            // Refresh each matching tab to trigger blocking
            for (const tab of matchingTabs) {
                try {
                    console.log(`[Timer] Refreshing tab ${tab.id} (${tab.url})`);
                    await browser.tabs.reload(tab.id);
                } catch (refreshError) {
                    console.warn(`[Timer] Failed to refresh tab ${tab.id}:`, refreshError);
                }
            }
        } catch (error) {
            console.error('[Timer] Error refreshing tabs on domain:', error);
        }
    }
}

new PomodoroBackground();