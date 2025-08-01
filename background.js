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
            'isRunning', 'isPaused', 'autoStart', 'blockingMode'
        ]).then(result => {
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
                        const domain = this.normalizeUrl(request.originalUrl);
                        if (domain) {
                            this.state.overrideDomain = domain;
                            console.log(`[Timer] Override granted for domain: ${this.state.overrideDomain}`);
                        } else {
                            console.error('[Timer] Failed to normalize override URL:', request.originalUrl);
                        }
                    }

                    this.saveState();

                    // Show start notification only
                    this.showOverrideNotification('start', 'Temporary access granted for 1 minute');

                    // Start periodic timer expiration check
                    this.startOverrideExpirationCheck();

                    // Inject floating timer into the active tab
                    if (request.tabId) {
                        this.injectFloatingTimer(request.tabId, 60);
                    }

                    sendResponse({ success: true });
                    break;
                case 'trackBreathingInteraction':
                    this.trackBreathingInteraction(request.interaction);
                    sendResponse({ success: true });
                    break;
                case 'updateBlockingMode':
                    this.updateBlockingModeFromMessage(request.blockingMode);
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

    setupNavigationListener() {
        // Listen for tab updates (navigation events)
        browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            try {
                // Handle navigation away from override tab
                if (changeInfo.status === 'loading' && changeInfo.url) {
                    this.handleTabNavigation(tabId, changeInfo.url);
                }

                // Check for blocked sites during focus mode when tab completes loading
                if (changeInfo.status === 'complete' && tab.url) {
                    this.checkAndRefreshBlockedTab(tabId, tab.url);
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

                // Check if the newly activated tab contains a blocked site
                browser.tabs.get(activeInfo.tabId).then(tab => {
                    if (tab && tab.url) {
                        this.checkAndRefreshBlockedTab(activeInfo.tabId, tab.url);
                    }
                }).catch(error => {
                    // Handle tab access failures and invalid tab IDs
                    if (error.message && error.message.includes('No tab with id')) {
                        console.warn(`[Blocking] Tab ${activeInfo.tabId} no longer exists during activation check`);
                    } else {
                        console.error(`[Blocking] Error getting tab info during activation for tab ${activeInfo.tabId}:`, error);
                    }
                });
            } catch (error) {
                console.error(`[Timer] Error handling tab activation:`, error);
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

    updateBlockingModeFromMessage(newBlockingMode) {
        // Update the settings object
        if (!this.settings) {
            this.settings = {};
        }
        this.settings.blockingMode = newBlockingMode;
        
        // Save to storage
        browser.storage.local.set({ blockingMode: newBlockingMode }).then(() => {
            console.log(`[Blocking] Blocking mode updated to: ${newBlockingMode}`);
            // Immediately apply new blocking behavior
            this.updateBlocking();
        }).catch(error => {
            console.error('[Blocking] Error saving blocking mode:', error);
        });
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

        // Use the blocking decision logic that respects the blocking mode
        const blockingMode = this.getBlockingMode();
        const shouldBlock = this.shouldBlockTab(details.url, this.state, blockingMode);

        if (!shouldBlock) {
            // console.log("[Blocking] Should not block based on blocking mode and timer state");
            // console.groupEnd();
            return;
        }

        // Use enhanced URL matching logic
        const isBlocked = this.isUrlBlocked(details.url, this.blockedSites);
        const hostname = this.normalizeUrl(details.url);
        
        if (!hostname && isBlocked) {
            console.warn("[Blocking] Could not normalize URL but marked as blocked:", details.url);
            // console.groupEnd();
            return;
        }

        if (isBlocked) {
            const blockingMode = this.getBlockingMode();
            const timerRunning = this.state.isRunning;
            const currentPhase = this.state.currentPhase;
            
            const redirectPath = "resources/blocked.html?url=" + encodeURIComponent(details.url) + 
                "&mode=" + encodeURIComponent(blockingMode) +
                "&timerRunning=" + encodeURIComponent(timerRunning) +
                "&phase=" + encodeURIComponent(currentPhase);
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

        const blockingMode = this.getBlockingMode();

        // console.log(`[Blocking] Update conditions: 
        // isRunning: ${this.state.isRunning},
        // currentPhase: ${this.state.currentPhase},
        // blockingMode: ${blockingMode},
        // blockedSites count: ${this.blockedSites.length}`);

        let shouldBlock = false;

        if (this.blockedSites.length > 0) {
            switch (blockingMode) {
                case 'focus-only':
                    // Only block during active focus sessions
                    shouldBlock = this.state.isRunning && this.state.currentPhase === 'focus';
                    break;

                case 'always':
                    // Block at all times when sites are configured
                    shouldBlock = true;
                    break;

                default:
                    // Default to focus-only behavior
                    shouldBlock = this.state.isRunning && this.state.currentPhase === 'focus';
                    break;
            }
        }

        // console.log(`[Blocking] Should block: ${shouldBlock} (mode: ${blockingMode})`);

        if (shouldBlock) {
            // console.log("[Blocking] Enabling blocking");
            this.enableBlocking();
        } else {
            // console.log("[Blocking] Disabling blocking");
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

    showOverrideNotification(type, message) {
        // Only show notifications at start and end of temporary access period
        if (type === 'start') {
            this.showNotification('Temporary Access Granted', message);
        } else if (type === 'end') {
            this.showNotification('Temporary Access Ended', message);
        }
    }

    saveState() {
        browser.storage.local.set({
            ...this.state,
            ...this.settings
        });
    }

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

        try {
            // Show initial notification only - no persistent updates
            this.showOverrideNotification(
                'start',
                `Timer display unavailable on this page. You have ${timeRemaining} seconds of access. The page will refresh automatically when time expires.`
            );

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

            // First, reset the temporary access state
            delete this.state.overrideUntil;
            delete this.state.overrideTabId;
            delete this.state.overrideStartTime;
            delete this.state.overrideDuration;
            delete this.state.overrideDomain;
            this.saveState();

            // Clear the expiration check alarm since override is now expired
            browser.alarms.clear('overrideExpirationCheck');

            // Update blocking to ensure immediate blocking 
            this.updateBlocking();

            // Force refresh the current page to show blocked page 
            await browser.tabs.reload(tabId);

            console.log(`[Timer] Successfully refreshed tab ${tabId} after timer expiration - access now blocked`);

            // Show end notification to inform user
            this.showOverrideNotification('end', 'The website has been blocked again. Focus mode is still active.');
        } catch (error) {
            console.error(`[Timer] Failed to refresh tab ${tabId}:`, error);

            // Even if refresh fails, ensure override state is reset
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
        try {
            // Skip if this tab has an active override
            if (this.state.overrideTabId === tabId && this.state.overrideUntil && Date.now() < this.state.overrideUntil) {
                return;
            }

            // Use the new blocking decision logic
            const blockingMode = this.getBlockingMode();
            const shouldBlock = this.shouldBlockTab(url, this.state, blockingMode);

            if (!shouldBlock) {
                return;
            }

            // Use enhanced URL normalization
            const hostname = this.normalizeUrl(url);
            if (!hostname) {
                console.warn(`[Blocking] Could not normalize URL for tab ${tabId}: ${url}`);
                return;
            }

            console.log(`[Blocking] Detected navigation to blocked site ${hostname} in tab ${tabId}, refreshing to trigger blocking (mode: ${blockingMode})`);

            // Refresh the tab to trigger the blocking mechanism 
            browser.tabs.reload(tabId).then(() => {
                console.log(`[Blocking] Successfully refreshed tab ${tabId} to block ${hostname}`);
            }).catch(error => {
                // Handle tab access failures and invalid tab IDs
                if (error.message && error.message.includes('No tab with id')) {
                    console.warn(`[Blocking] Tab ${tabId} no longer exists, skipping refresh`);
                } else if (error.message && error.message.includes('Cannot access')) {
                    console.warn(`[Blocking] Cannot access tab ${tabId}, may be a privileged page`);
                } else {
                    console.error(`[Blocking] Failed to refresh tab ${tabId}:`, error);
                    // Retry mechanism for failed force refresh operations
                    setTimeout(() => {
                        browser.tabs.reload(tabId).catch(retryError => {
                            console.error(`[Blocking] Retry failed for tab ${tabId}:`, retryError);
                        });
                    }, 1000);
                }
            });
        } catch (error) {
            // Add comprehensive error handling for URL parsing and other failures
            console.error(`[Blocking] Error checking blocked site for tab ${tabId}:`, error);
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
        if (!this.state.overrideUntil || !this.state.overrideTabId) {
            // No active override, clear the alarm
            browser.alarms.clear('overrideExpirationCheck');
            return;
        }

        // Check if override has expired
        if (Date.now() >= this.state.overrideUntil) {
            console.log('[Timer] Override expiration detected by backup check, forcing refresh');

            // Show end notification
            this.showOverrideNotification('end', 'Temporary access has ended. Returning to blocked page.');

            this.forceRefreshTab(this.state.overrideTabId);

            // Clear the expiration check alarm since override is now expired
            browser.alarms.clear('overrideExpirationCheck');
        }
    }
}

new PomodoroBackground();