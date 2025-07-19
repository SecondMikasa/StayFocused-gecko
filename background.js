class PomodoroBackground {
    constructor() {
        // console.log("[Background] Initializing PomodoroBackground...");
        // Bind the listener method to 'this' to maintain context
        //FIXME: NO CLUE WHAT IT DOES (THANK THE AI GOD THAT MADE IT WORK)
        this.blockingListener = this.blockingListener.bind(this);

        // Initialize error handling state
        this.fallbackNotificationInterval = null;
        this.extensionStartupTime = Date.now();

        this.initializeTimer();
        this.setupMessageListener();
        this.setupAlarmListener();
        this.setupNavigationListener();
        this.setupExtensionLifecycleHandlers();
        this.loadBlockedSites();
        this.performStartupCleanup();
    }

    initializeTimer() {
        browser.storage.local.get([
            'focusTime', 'breakTime', 'longBreakTime', 'sessionsCount',
            'currentSession', 'totalSessions', 'timeLeft', 'currentPhase',
            'isRunning', 'isPaused', 'autoStart'
        ]).then(result => {
            this.settings = {
                focusTime: result.focusTime || 25,
                breakTime: result.breakTime || 5,
                longBreakTime: result.longBreakTime || 15,
                sessionsCount: result.sessionsCount || 4,
                autoStart: result.autoStart || false
            };
            this.state = {
                currentSession: result.currentSession || 1,
                totalSessions: result.totalSessions || this.settings.sessionsCount,
                timeLeft: result.timeLeft || (this.settings.focusTime * 60),
                currentPhase: result.currentPhase || 'focus',
                isRunning: result.isRunning || false,
                isPaused: result.isPaused || false
            };
            this.saveState();
            this.updateBlocking();
        });
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
                    this.state.overrideUntil = Date.now() + 60000;
                    this.state.overrideTabId = request.tabId;
                    this.state.overrideStartTime = Date.now();
                    this.state.overrideDuration = 60000; // 60 seconds in milliseconds
                    
                    // Store the domain that has temporary access for cross-domain navigation handling
                    if (request.originalUrl) {
                        try {
                            const urlObj = new URL(request.originalUrl);
                            this.state.overrideDomain = urlObj.hostname.replace(/^www\./i, '').toLowerCase();
                            console.log(`[Timer] Override granted for domain: ${this.state.overrideDomain}`);
                        } catch (error) {
                            console.error('[Timer] Failed to parse override URL:', error);
                        }
                    }
                    
                    this.saveState();
                    
                    // Start periodic timer expiration check
                    this.startOverrideExpirationCheck();
                    
                    // Inject floating timer into the active tab
                    if (request.tabId) {
                        this.injectFloatingTimer(request.tabId, 60);
                    }
                    
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
            }
        });
    }

    /**
     * Sets up navigation listener to handle cross-domain navigation during override
     * Requirements: 3.4, 5.3, 5.4
     */
    setupNavigationListener() {
        // Listen for tab updates (navigation events)
        browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            try {
                // Handle navigation away from override tab
                if (changeInfo.status === 'loading' && changeInfo.url) {
                    this.handleTabNavigation(tabId, changeInfo.url);
                }
                
                // Only handle completed navigations with URLs for re-injection
                if (changeInfo.status !== 'complete' || !tab.url) {
                    return;
                }

                // Check if this tab has an active override
                if (!this.state.overrideTabId || this.state.overrideTabId !== tabId) {
                    return;
                }

                // Check if override is still active
                if (!this.state.overrideUntil || Date.now() >= this.state.overrideUntil) {
                    console.log(`[Timer] Override expired during navigation for tab ${tabId}`);
                    this.cleanupOverrideForTab(tabId);
                    return;
                }

                // Check if the new URL is on the same domain as the override domain
                if (this.isSameDomainAsOverride(tab.url)) {
                    console.log(`[Timer] Same-domain navigation detected in tab ${tabId}, re-injecting timer`);
                    
                    // Calculate remaining time
                    const elapsed = Date.now() - this.state.overrideStartTime;
                    const timeRemaining = Math.max(0, Math.ceil((this.state.overrideDuration - elapsed) / 1000));
                    
                    if (timeRemaining > 0) {
                        // Re-inject the floating timer for the new page
                        this.injectFloatingTimer(tabId, timeRemaining);
                    } else {
                        // Timer has expired, force refresh
                        this.forceRefreshTab(tabId);
                    }
                } else {
                    // Navigation to different domain, clean up override
                    console.log(`[Timer] Navigation to different domain detected, cleaning up override for tab ${tabId}`);
                    this.cleanupOverrideForTab(tabId);
                }
            } catch (error) {
                console.error(`[Timer] Error handling tab update for tab ${tabId}:`, error);
                // On error, clean up override to prevent stuck state
                if (this.state.overrideTabId === tabId) {
                    this.cleanupOverrideForTab(tabId);
                }
            }
        });

        // Listen for tab removal to clean up override state
        browser.tabs.onRemoved.addListener((tabId, _removeInfo) => {
            try {
                console.log(`[Timer] Tab ${tabId} closed, cleaning up override state`);
                this.cleanupOverrideForTab(tabId);
            } catch (error) {
                console.error(`[Timer] Error handling tab removal for tab ${tabId}:`, error);
            }
        });

        // Listen for window close events
        browser.windows.onRemoved.addListener((windowId) => {
            try {
                console.log(`[Timer] Window ${windowId} closed, checking for override cleanup`);
                this.cleanupOverrideForWindow(windowId);
            } catch (error) {
                console.error(`[Timer] Error handling window removal for window ${windowId}:`, error);
            }
        });

        // Listen for tab activation changes to handle focus switching
        browser.tabs.onActivated.addListener((activeInfo) => {
            try {
                // If user switches away from override tab, ensure timer is still running
                if (this.state.overrideTabId && this.state.overrideTabId !== activeInfo.tabId) {
                    this.validateOverrideState();
                }
            } catch (error) {
                console.error(`[Timer] Error handling tab activation:`, error);
            }
        });
    }

    /**
     * Validates current override state and cleans up if invalid
     * Requirements: 5.3, 5.4
     */
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

    /**
     * Cleans up override state for a specific tab
     * Requirements: 5.3, 5.4
     */
    cleanupOverrideForTab(tabId) {
        // Only clean up if this is the override tab
        if (this.state.overrideTabId !== tabId) {
            return;
        }
        
        console.log(`[Timer] Cleaning up override state for tab ${tabId}`);
        
        try {
            // Clear override state
            delete this.state.overrideUntil;
            delete this.state.overrideTabId;
            delete this.state.overrideStartTime;
            delete this.state.overrideDuration;
            delete this.state.overrideDomain;
            delete this.state.timerInjectionSuccessful;
            
            // Clear alarms
            browser.alarms.clear('overrideExpirationCheck').catch(error => {
                console.warn('[Timer] Error clearing override expiration alarm:', error);
            });
            
            // Clear fallback notifications
            if (this.fallbackNotificationInterval) {
                clearInterval(this.fallbackNotificationInterval);
                this.fallbackNotificationInterval = null;
            }
            
            // Save state
            this.saveState();
            
            // Update blocking
            this.updateBlocking();
            
            console.log(`[Timer] Override cleanup completed for tab ${tabId}`);
            
        } catch (error) {
            console.error(`[Timer] Error during cleanup for tab ${tabId}:`, error);
            
            // Force clear critical state even if other operations fail
            try {
                delete this.state.overrideUntil;
                delete this.state.overrideTabId;
                this.saveState();
                this.updateBlocking();
            } catch (criticalError) {
                console.error('[Timer] Critical error during forced cleanup:', criticalError);
            }
        }
    }

    /**
     * Sets up extension lifecycle event handlers for proper cleanup
     * Requirements: 5.3, 5.4
     */
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

    /**
     * Performs cleanup operations on extension startup
     * Requirements: 5.3, 5.4
     */
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
                        
                        // If injection was successful, try to re-inject timer
                        if (result.timerInjectionSuccessful) {
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

    /**
     * Performs cleanup operations on extension shutdown
     * Requirements: 5.3, 5.4
     */
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

    /**
     * Clears stale override state from storage
     * Requirements: 5.3, 5.4
     */
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

    /**
     * Handles tab navigation events for cleanup
     * Requirements: 5.3, 5.4
     */
    handleTabNavigation(tabId, newUrl) {
        // Check if this is the override tab
        if (this.state.overrideTabId === tabId) {
            // If navigating to a non-injectable URL, clean up override
            if (!this.isInjectableUrl(newUrl)) {
                console.log(`[Timer] Navigation to non-injectable URL ${newUrl}, cleaning up override`);
                this.cleanupOverrideForTab(tabId);
                return;
            }
            
            // If navigating away from override domain, clean up
            if (!this.isSameDomainAsOverride(newUrl)) {
                console.log(`[Timer] Navigation away from override domain, cleaning up override`);
                this.cleanupOverrideForTab(tabId);
            }
        }
    }

    /**
     * Cleans up override state when window is closed
     * Requirements: 5.3, 5.4
     */
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

    blockingListener(details) {
        // console.groupCollapsed(`[Blocking] Request to: ${details.url}`);
        // console.log("Request details:", details);
        // If override is active, check if it's for the same domain
        if (this.state.overrideUntil && Date.now() < this.state.overrideUntil) {
            // If we have an override domain, only allow requests to that domain
            if (this.state.overrideDomain) {
                if (this.isSameDomainAsOverride(details.url)) {
                    // console.log(`[Blocking] Override active for domain ${this.state.overrideDomain} - allowing request to ${details.url}`);
                    // console.groupEnd();
                    return;
                } else {
                    // console.log(`[Blocking] Override active but request is to different domain - blocking`);
                    // Continue with normal blocking logic
                }
            } else {
                // Fallback: allow all requests if no domain is tracked (backward compatibility)
                // console.log(`[Blocking] Override active (no domain tracked) - allowing request`);
                // console.groupEnd();
                return;
            }
        }

        // Only block during focus sessions when timer is running
        if (!this.state.isRunning || this.state.currentPhase !== 'focus') {
            // console.log("[Blocking] Not in focus session - allowing request");
            // console.groupEnd();
            return;
        }

        // Parse the URL to get the hostname
        let hostname;
        try {
            const urlObj = new URL(details.url);
            hostname = urlObj.hostname;

            // Remove www. prefix and convert to lowercase
            hostname = hostname.replace(/^www\./i, '').toLowerCase();
            // console.log(`[Blocking] Normalized hostname: ${hostname}`);
        } catch (e) {
            console.error("[Blocking] Error parsing URL:", e);
            console.groupEnd();
            return;
        }

        // Check if the hostname matches any blocked site
        const isBlocked = this.blockedSites.some(site => {
            const normalizedSite = site.toLowerCase().replace(/^www\./i, '');
            const match = (
                hostname === normalizedSite ||
                hostname.endsWith(`.${normalizedSite}`)
            );

            // console.log(`[Blocking] Checking ${hostname} against ${normalizedSite}: ${match}`);
            return match;
        });

        if (isBlocked) {
            const redirectPath = "resources/blocked.html?url=" + encodeURIComponent(details.url);
            const fullUrl = browser.runtime.getURL(redirectPath);
            // console.log(`[Blocking] Redirecting to: ${fullUrl}`);

            // Verify this URL works by opening it in a new tab for testing:
            // browser.tabs.create({url: fullUrl});

            return { redirectUrl: fullUrl };
        }
        // console.log("[Blocking] Site not in block list - allowing request");
        // console.groupEnd();
    }

    enableBlocking() {
        // console.log("[Blocking] Attempting to enable blocking");
        if (!browser.webRequest.onBeforeRequest.hasListener(this.blockingListener)) {
            // console.log("[Blocking] Adding webRequest listener");
            try {
                browser.webRequest.onBeforeRequest.addListener(
                    this.blockingListener,
                    { urls: ["<all_urls>"], types: ["main_frame"] },
                    ["blocking"]
                );
                // console.log("[Blocking] Listener successfully added");
            } catch (err) {
                console.error("[Blocking] Error adding listener:", err);
            }
        } else {
            console.log("[Blocking] Listener already exists");
        }
    }

    disableBlocking() {
        // console.log("[Blocking] Attempting to disable blocking");
        if (browser.webRequest.onBeforeRequest.hasListener(this.blockingListener)) {
            // console.log("[Blocking] Removing webRequest listener");
            browser.webRequest.onBeforeRequest.removeListener(this.blockingListener);
        } else {
            console.log("[Blocking] No listener to remove");
        }
    }

    updateBlocking() {
        if (!this.state || !this.blockedSites) {
            // console.warn("[Blocking] Cannot update blocking - state or sites not initialized");
            return;
        }

        // console.log(`[Blocking] Update conditions: 
        // isRunning: ${this.state.isRunning},
        // currentPhase: ${this.state.currentPhase},
        // blockedSites count: ${this.blockedSites.length}`);

        const shouldBlock = (
            this.state.isRunning &&
            this.state.currentPhase === 'focus' &&
            this.blockedSites.length > 0
        );

        // console.log(`[Blocking] Should block: ${shouldBlock}`);

        if (shouldBlock) {
            // console.log("[Blocking] Enabling blocking (focus session with blocked sites)");
            this.enableBlocking();
        } else {
            // console.log("[Blocking] Disabling blocking (not in focus or no sites)");
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
        browser.notifications.create({
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/timer-48.png'),
            title: title,
            message: message
        });
    }

    saveState() {
        browser.storage.local.set({
            ...this.state,
            ...this.settings
        });
    }

    /**
     * Injects floating timer content script into the specified tab
     * Requirements: 1.1, 1.2, 5.3
     */
    async injectFloatingTimer(tabId, timeRemaining, retryCount = 0) {
        const maxRetries = 2;
        
        try {
            // Validate tab exists and is accessible
            const tab = await browser.tabs.get(tabId);
            if (!tab || !tab.url) {
                throw new Error('Tab not found or has no URL');
            }

            // Check if tab URL is injectable (not chrome://, about:, etc.)
            if (!this.isInjectableUrl(tab.url)) {
                throw new Error(`Cannot inject into URL: ${tab.url}`);
            }

            // Check if tab is still loading
            if (tab.status === 'loading') {
                console.log(`[Timer] Tab ${tabId} still loading, waiting...`);
                await this.waitForTabComplete(tabId, 5000); // Wait up to 5 seconds
            }

            console.log(`[Timer] Attempting to inject timer into tab ${tabId} (attempt ${retryCount + 1})`);

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

            // Wait for script to initialize with exponential backoff
            const waitTime = Math.min(100 * Math.pow(2, retryCount), 1000);
            await new Promise(resolve => setTimeout(resolve, waitTime));

            // Start the timer with the specified time
            await browser.tabs.sendMessage(tabId, {
                action: 'startTimer',
                initialTime: timeRemaining
            });

            console.log(`[Timer] Successfully injected floating timer into tab ${tabId} with ${timeRemaining} seconds`);
            
            // Mark injection as successful
            this.state.timerInjectionSuccessful = true;
            this.saveState();
            
        } catch (error) {
            console.error(`[Timer] Failed to inject floating timer into tab ${tabId} (attempt ${retryCount + 1}):`, error);
            
            // Retry logic for transient failures
            if (retryCount < maxRetries && this.shouldRetryInjection(error)) {
                console.log(`[Timer] Retrying injection for tab ${tabId} in ${1000 * (retryCount + 1)}ms`);
                setTimeout(() => {
                    this.injectFloatingTimer(tabId, timeRemaining, retryCount + 1);
                }, 1000 * (retryCount + 1));
                return;
            }
            
            // Mark injection as failed and activate fallback
            this.state.timerInjectionSuccessful = false;
            this.saveState();
            
            // Activate fallback notification system
            this.activateFallbackNotificationSystem(timeRemaining);
        }
    }

    /**
     * Waits for a tab to complete loading
     * Requirements: 5.3
     */
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

    /**
     * Determines if injection should be retried based on error type
     * Requirements: 5.3
     */
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

    /**
     * Checks if a URL is injectable for content scripts
     * Requirements: 5.3
     */
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

    /**
     * Activates fallback notification system when content script injection fails
     * Requirements: 5.3
     */
    activateFallbackNotificationSystem(timeRemaining) {
        console.log(`[Timer] Activating fallback notification system for ${timeRemaining} seconds`);
        
        try {
            // Show initial notification with error context
            this.showNotification(
                'Temporary Access Granted (Fallback Mode)',
                `Timer display unavailable on this page. You have ${timeRemaining} seconds of access. The page will refresh automatically when time expires.`
            );
            
            // Set up periodic notifications as fallback timer display
            this.startFallbackNotifications(timeRemaining);
            
        } catch (error) {
            console.error('[Timer] Error activating fallback notification system:', error);
            
            // Last resort: try basic notification
            try {
                this.showBasicNotification(`Temporary access granted for ${timeRemaining} seconds`);
            } catch (basicError) {
                console.error('[Timer] All notification methods failed:', basicError);
            }
        }
    }

    /**
     * Starts periodic fallback notifications to replace floating timer
     * Requirements: 5.3
     */
    startFallbackNotifications(initialTime) {
        // Clear any existing fallback
        if (this.fallbackNotificationInterval) {
            clearInterval(this.fallbackNotificationInterval);
            this.fallbackNotificationInterval = null;
        }
        
        let timeRemaining = initialTime;
        
        // Show notifications at key intervals: 30s, 15s, 10s, 5s, and final countdown
        const notificationTimes = [30, 15, 10, 5, 4, 3, 2, 1];
        
        try {
            this.fallbackNotificationInterval = setInterval(() => {
                try {
                    timeRemaining--;
                    
                    if (notificationTimes.includes(timeRemaining)) {
                        const message = timeRemaining <= 5 
                            ? `${timeRemaining} second${timeRemaining !== 1 ? 's' : ''} remaining!`
                            : `${timeRemaining} seconds of temporary access remaining`;
                            
                        this.showNotification('Temporary Access Timer', message);
                    }
                    
                    if (timeRemaining <= 0) {
                        clearInterval(this.fallbackNotificationInterval);
                        this.fallbackNotificationInterval = null;
                    }
                } catch (error) {
                    console.error('[Timer] Error in fallback notification interval:', error);
                    // Clear the interval on error to prevent repeated failures
                    clearInterval(this.fallbackNotificationInterval);
                    this.fallbackNotificationInterval = null;
                }
            }, 1000);
            
        } catch (error) {
            console.error('[Timer] Error starting fallback notifications:', error);
        }
    }

    /**
     * Shows a basic notification as last resort fallback
     * Requirements: 5.3
     */
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

    /**
     * Handles timer tick messages from content script for synchronization
     * Requirements: 2.3, 3.1, 5.4
     */
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

    /**
     * Handles timer synchronization requests from content script
     * Requirements: 2.3, 5.4
     */
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

    /**
     * Forces refresh of the specified tab when timer expires
     * Requirements: 3.1, 3.2, 3.3
     */
    async forceRefreshTab(tabId) {
        try {
            console.log(`[Timer] Timer expired - blocking access and refreshing tab ${tabId}`);
            
            // First, reset the temporary access state (Requirement 3.3)
            delete this.state.overrideUntil;
            delete this.state.overrideTabId;
            delete this.state.overrideStartTime;
            delete this.state.overrideDuration;
            delete this.state.overrideDomain;
            this.saveState();
            
            // Clear the expiration check alarm since override is now expired
            browser.alarms.clear('overrideExpirationCheck');
            
            // Update blocking to ensure immediate blocking (Requirement 3.1)
            this.updateBlocking();

            // Force refresh the current page to show blocked page (Requirement 3.2)
            await browser.tabs.reload(tabId);
            
            console.log(`[Timer] Successfully refreshed tab ${tabId} after timer expiration - access now blocked`);
            
            // Show notification to inform user
            this.showNotification(
                'Temporary Access Expired',
                'The website has been blocked again. Focus mode is still active.'
            );
        } catch (error) {
            console.error(`[Timer] Failed to refresh tab ${tabId}:`, error);
            
            // Even if refresh fails, ensure override state is reset (Requirement 3.3)
            delete this.state.overrideUntil;
            delete this.state.overrideTabId;
            delete this.state.overrideStartTime;
            delete this.state.overrideDuration;
            delete this.state.overrideDomain;
            this.saveState();
            
            // Clear the expiration check alarm
            browser.alarms.clear('overrideExpirationCheck');
            
            // Still update blocking state
            this.updateBlocking();
            
            // Show error notification
            this.showNotification(
                'Timer Expired',
                'Temporary access has ended. Please refresh the page manually if needed.'
            );
        }
    }

    /**
     * Checks if a URL is on the same domain as the current override domain
     * Requirements: 3.4
     */
    isSameDomainAsOverride(url) {
        if (!this.state.overrideDomain || !url) {
            return false;
        }

        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.replace(/^www\./i, '').toLowerCase();
            
            // Check if it's the same domain or a subdomain
            const isMatch = (
                hostname === this.state.overrideDomain ||
                hostname.endsWith(`.${this.state.overrideDomain}`)
            );
            
            console.log(`[Timer] Checking if ${hostname} matches override domain ${this.state.overrideDomain}: ${isMatch}`);
            return isMatch;
        } catch (error) {
            console.error('[Timer] Error parsing URL for domain check:', error);
            return false;
        }
    }

    /**
     * Starts periodic check for override expiration as a backup mechanism
     * Requirements: 3.1, 3.2, 3.3
     */
    startOverrideExpirationCheck() {
        // Clear any existing expiration check
        browser.alarms.clear('overrideExpirationCheck');
        
        // Set up periodic check every 5 seconds
        browser.alarms.create('overrideExpirationCheck', { 
            periodInMinutes: 5 / 60 // 5 seconds
        });
        
        console.log('[Timer] Started override expiration check alarm');
    }

    /**
     * Checks if override has expired and forces refresh if needed
     * This serves as a backup mechanism in case content script fails
     * Requirements: 3.1, 3.2, 3.3
     */
    checkOverrideExpiration() {
        // Only check if we have an active override
        if (!this.state.overrideUntil || !this.state.overrideTabId) {
            // No active override, clear the alarm
            browser.alarms.clear('overrideExpirationCheck');
            return;
        }

        // Check if override has expired
        if (Date.now() >= this.state.overrideUntil) {
            console.log('[Timer] Override expiration detected by backup check, forcing refresh');
            this.forceRefreshTab(this.state.overrideTabId);
            
            // Clear the expiration check alarm since override is now expired
            browser.alarms.clear('overrideExpirationCheck');
        }
    }


}

new PomodoroBackground();