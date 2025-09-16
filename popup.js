class PomodoroTimer {
    constructor() {
        this.initializeElements();
        this.loadSettings();
        this.loadTimerState();
        this.loadBlockingMode();
        this.setupEventListeners();
        this.updateDisplay();
        this.loadBlockList();

        setInterval(() => this.updateDisplay(), 1000);
        
        // Refresh block list periodically and when popup becomes visible
        setInterval(() => this.loadBlockList(), 5000); // Refresh every 5 seconds
        
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.loadBlockList();
            }
        });
    }

    initializeElements() {
        this.timeDisplay = document.getElementById('timeDisplay');
        this.sessionInfo = document.getElementById('sessionInfo');
        this.statusDisplay = document.getElementById('statusDisplay');

        this.startBtn = document.getElementById('startBtn');
        this.pauseBtn = document.getElementById('pauseBtn');
        this.resetBtn = document.getElementById('resetBtn');

        this.focusTimeInput = document.getElementById('focusTime');
        this.breakTimeInput = document.getElementById('breakTime');
        this.longBreakTimeInput = document.getElementById('longBreakTime');
        this.sessionsCountInput = document.getElementById('sessionsCount');
        this.autoStartInput = document.getElementById('autoStart');
        this.saveSettingsBtn = document.getElementById('saveSettings');

        this.blockedSiteInput = document.getElementById('blockedSiteInput');
        this.addSiteBtn = document.getElementById('addSiteBtn');
        this.blockList = document.getElementById('blockList');
        this.blockingModeCheckbox = document.getElementById('blockingModeCheckbox');
        this.overrideTimeInput = document.getElementById('overrideTime');
    }

    setupEventListeners() {
        this.startBtn.addEventListener('click', () => this.startTimer());
        this.pauseBtn.addEventListener('click', () => this.pauseTimer());
        this.resetBtn.addEventListener('click', () => this.resetTimer());
        this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());

        this.addSiteBtn.addEventListener('click', () => this.addBlockedSite());

        // Using event delegation for the remove buttons
        this.blockList.addEventListener('click', (event) => {
            if (event.target.classList.contains('remove-site-btn')) {
                this.removeBlockedSite(event.target.dataset.site);
            }
        });

        this.blockingModeCheckbox.addEventListener('change', () => this.saveBlockingMode());
        this.overrideTimeInput.addEventListener('change', () => this.saveOverrideTime());

        // Handle collapsible sections
        this.setupCollapsibleSections();

        // Handle Enter key in site input
        this.blockedSiteInput.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                this.addBlockedSite();
            }
        });
    }

    setupCollapsibleSections() {
        const sectionHeaders = document.querySelectorAll('.section-header');

        sectionHeaders.forEach(header => {
            header.addEventListener('click', () => {
                const section = header.parentElement;
                const isCollapsed = section.classList.contains('collapsed');

                // Toggle the clicked section
                if (isCollapsed) {
                    section.classList.remove('collapsed');
                } else {
                    section.classList.add('collapsed');
                }
            });
        });

        // Start with settings section expanded and blocker collapsed
        try {
            const settingsSection = document.querySelector('[data-section="settings"]')?.parentElement;
            const blockerSection = document.querySelector('[data-section="blocker"]')?.parentElement;

            if (settingsSection) {
                settingsSection.classList.remove('collapsed');
            }
            if (blockerSection) {
                blockerSection.classList.add('collapsed');
            }
        } catch (error) {
            console.error('Error setting up collapsible sections:', error);
            // Fallback: show all content
            document.querySelectorAll('.section').forEach(section => {
                section.classList.remove('collapsed');
            });
        }
    }

    loadSettings() {
        browser.storage.local.get([
            'focusTime', 'breakTime', 'longBreakTime',
            'sessionsCount', 'autoStart'
        ]).then((result) => {
            this.focusTimeInput.value = result.focusTime || 25;
            this.breakTimeInput.value = result.breakTime || 5;
            this.longBreakTimeInput.value = result.longBreakTime || 15;
            this.sessionsCountInput.value = result.sessionsCount || 4;
            this.autoStartInput.checked = result.autoStart || false;
        });
    }

    loadBlockingMode() {
        browser.storage.local.get(['blockingMode', 'overrideTime']).then((result) => {
            // Default to 'focus-only' mode (checkbox checked)
            const blockingMode = result.blockingMode || 'focus-only';
            this.blockingModeCheckbox.checked = (blockingMode === 'focus-only');
            
            // Load override time (default to 1 minute)
            const overrideTime = result.overrideTime || 1;
            this.overrideTimeInput.value = overrideTime;
        });
    }

    saveBlockingMode() {
        const blockingMode = this.blockingModeCheckbox.checked ? 'focus-only' : 'always';

        browser.storage.local.set({ blockingMode }).then(() => {
            // Send message to background script to update blocking behavior immediately
            browser.runtime.sendMessage({
                action: 'updateBlockingMode',
                blockingMode: blockingMode
            }).then((response) => {
                if (response && response.success) {
                    const modeText = blockingMode === 'focus-only' ? 'focus mode only' : 'always';
                    this.showNotification(`Blocking mode updated to: ${modeText}`);
                } else {
                    this.showNotification('Error updating blocking mode');
                }
            }).catch((error) => {
                console.error('[Popup] Error sending blocking mode update:', error);
                this.showNotification('Error updating blocking mode');
            });
        }).catch((error) => {
            console.error('[Popup] Error saving blocking mode to storage:', error);
            this.showNotification('Error saving blocking mode');
        });
    }

    saveOverrideTime() {
        const overrideTime = parseInt(this.overrideTimeInput.value);
        
        // Validate the input
        if (isNaN(overrideTime) || overrideTime < 1 || overrideTime > 60) {
            this.showNotification('Override time must be between 1 and 60 minutes');
            this.overrideTimeInput.value = 1; // Reset to default
            return;
        }

        browser.storage.local.set({ overrideTime }).then(() => {
            this.showNotification(`Override duration set to ${overrideTime} minute${overrideTime > 1 ? 's' : ''}`);
        }).catch((error) => {
            console.error('[Popup] Error saving override time:', error);
            this.showNotification('Error saving override time');
        });
    }

    loadTimerState() {
        browser.storage.local.get([
            'isRunning', 'isPaused', 'currentSession', 'isBreak',
            'timeLeft', 'totalSessions', 'currentPhase'
        ]).then((result) => {
            this.isRunning = result.isRunning || false;
            this.isPaused = result.isPaused || false;
            this.currentSession = result.currentSession || 1;
            this.isBreak = result.isBreak || false;
            this.timeLeft = result.timeLeft || (parseInt(this.focusTimeInput.value) * 60);
            this.totalSessions = result.totalSessions || parseInt(this.sessionsCountInput.value);
            this.currentPhase = result.currentPhase || 'focus';

            this.updateButtonStates();
        });
    }

    saveSettings() {
        const settings = {
            focusTime: parseInt(this.focusTimeInput.value),
            breakTime: parseInt(this.breakTimeInput.value),
            longBreakTime: parseInt(this.longBreakTimeInput.value),
            sessionsCount: parseInt(this.sessionsCountInput.value),
            autoStart: this.autoStartInput.checked
        };

        browser.storage.local.set(settings).then(() => {
            this.showNotification('Settings saved successfully!');
            setTimeout(() => this.updateDisplay(), 100);
        });

        browser.runtime.sendMessage({
            action: 'updateSettings',
            settings: settings
        }).then((response) => {
            if (response && response.success) {
                this.updateDisplay();
            }
        });
    }

    startTimer() {
        browser.runtime.sendMessage({ action: 'startTimer' }).then((response) => {
            if (response && response.success) {
                this.isRunning = true;
                this.isPaused = false;
                this.updateButtonStates();
            }
        });
    }

    pauseTimer() {
        browser.runtime.sendMessage({ action: 'pauseTimer' }).then((response) => {
            if (response && response.success) {
                this.isRunning = false;
                this.isPaused = true;
                this.updateButtonStates();
            }
        });
    }

    resetTimer() {
        browser.runtime.sendMessage({ action: 'resetTimer' }).then((response) => {
            if (response && response.success) {
                this.isRunning = false;
                this.isPaused = false;
                this.currentSession = 1;
                this.isBreak = false;
                this.currentPhase = 'focus';
                this.timeLeft = parseInt(this.focusTimeInput.value) * 60;
                this.updateButtonStates();
                this.updateDisplay();
            }
        });
    }

    updateButtonStates() {
        if (this.isRunning) {
            this.startBtn.disabled = true;
            this.pauseBtn.disabled = false;
            this.startBtn.textContent = 'Running';
        } else if (this.isPaused) {
            this.startBtn.disabled = false;
            this.pauseBtn.disabled = true;
            this.startBtn.textContent = 'Resume';
        } else {
            this.startBtn.disabled = false;
            this.pauseBtn.disabled = true;
            this.startBtn.textContent = 'Start';
        }
    }

    updateDisplay() {
        browser.storage.local.get([
            'timeLeft', 'currentSession', 'totalSessions',
            'currentPhase', 'isRunning', 'isPaused'
        ]).then((result) => {
            const timeLeft = result.timeLeft || this.timeLeft || 0;
            const currentSession = result.currentSession || 1;
            const totalSessions = result.totalSessions || parseInt(this.sessionsCountInput.value);
            const currentPhase = result.currentPhase || 'focus';
            const isRunning = result.isRunning || false;
            const isPaused = result.isPaused || false;

            const minutes = Math.floor(timeLeft / 60);
            const seconds = timeLeft % 60;
            this.timeDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            this.sessionInfo.textContent = `Session ${currentSession} of ${totalSessions}`;

            let status = '';
            let statusClass = '';

            if (isRunning) {
                if (currentPhase === 'focus') {
                    status = '🎯 Focus Time - Stay concentrated!';
                    statusClass = 'working';
                } else if (currentPhase === 'shortBreak') {
                    status = '☕ Short Break - Relax a bit!';
                    statusClass = 'break';
                } else if (currentPhase === 'longBreak') {
                    status = '🌟 Long Break - Well deserved!';
                    statusClass = 'break';
                }
            } else if (isPaused) {
                status = '⏸️ Paused';
                statusClass = 'paused';
            } else {
                status = '▶️ Ready to start';
                statusClass = '';
            }

            this.statusDisplay.textContent = status;
            this.statusDisplay.className = `status ${statusClass}`;

            this.isRunning = isRunning;
            this.isPaused = isPaused;
            this.updateButtonStates();
        });
    }

    showNotification(message) {
        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed; top: 10px; right: 10px; background: #27ae60;
            color: white; padding: 10px 15px; border-radius: 5px;
            font-size: 12px; z-index: 1000;
        `;
        document.body.appendChild(notification);
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 2000);
    }

    loadBlockList() {
        browser.storage.local.get('blockedSites').then(result => {
            const sites = result.blockedSites || [];
            console.log('[Popup] Loading block list:', sites);
            this.renderBlockList(sites);
        }).catch(error => {
            console.error('[Popup] Error loading block list:', error);
            this.renderBlockList([]);
        });
    }

    addBlockedSite() {
        const input = this.blockedSiteInput.value.trim();
        if (!input) return;

        let site;
        try {
            // Remove protocol if present, but keep path
            site = input.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
            // Remove trailing slash for consistency
            if (site.endsWith('/')) site = site.slice(0, -1);
        } catch (e) {
            site = input.replace(/^www\./i, '');
        }

        if (site) {
            browser.storage.local.get('blockedSites').then(result => {
                const blockedSites = result.blockedSites || [];
                if (!blockedSites.includes(site)) {
                    blockedSites.push(site);
                    browser.storage.local.set({ blockedSites }).then(() => {
                        browser.runtime.sendMessage({ action: 'updateBlocklist' }).then(() => {
                            this.renderBlockList(blockedSites);
                            this.blockedSiteInput.value = '';
                            this.showNotification(`Added ${site} to block list`);
                        }).catch(error => {
                            console.error('Error updating background blocklist:', error);
                            // Still update the UI even if background update fails
                            this.renderBlockList(blockedSites);
                            this.blockedSiteInput.value = '';
                            this.showNotification(`Added ${site} to block list`);
                        });
                    });
                } else {
                    // Site already exists - refresh the display and show notification
                    this.renderBlockList(blockedSites);
                    this.blockedSiteInput.value = '';
                    this.showNotification(`${site} is already in the block list`);
                }
            });
        }
    }

    removeBlockedSite(siteToRemove) {
        // console.log(`[Popup] Removing blocked site: ${siteToRemove}`);
        browser.storage.local.get('blockedSites').then(result => {
            let blockedSites = result.blockedSites || [];
            // console.log("[Popup] Current blocked sites:", blockedSites);

            blockedSites = blockedSites.filter(site => site !== siteToRemove);
            // console.log("[Popup] Updated blocked sites after removal:", blockedSites);

            browser.storage.local.set({ blockedSites }).then(() => {
                // console.log("[Popup] Successfully removed site");

                // Force background to reload sites
                browser.runtime.sendMessage({ action: 'updateBlocklist' }).then(() => {
                    // console.log("[Popup] Background blocklist updated after removal");
                    this.renderBlockList(blockedSites);
                    this.showNotification(`Removed ${siteToRemove} from block list`);
                }).catch(err => {
                    console.error("[Popup] Error updating background blocklist:", err);
                    // Still update the UI even if background update fails
                    this.renderBlockList(blockedSites);
                    this.showNotification(`Removed ${siteToRemove} from block list`);
                });
            }).catch(err => {
                console.error("[Popup] Error saving after removal:", err);
                this.showNotification('Error removing site from block list');
            });
        }).catch(err => {
            console.error("[Popup] Error retrieving blocked sites for removal:", err);
            this.showNotification('Error removing site from block list');
        });
    }

    renderBlockList(sites) {
        console.log('[Popup] Rendering block list with sites:', sites);
        this.blockList.replaceChildren();
        
        if (!sites || sites.length === 0) {
            const p = document.createElement('p');
            p.className = 'blocker-info';
            p.textContent = 'No sites blocked yet.';
            this.blockList.appendChild(p);
            console.log('[Popup] Displayed "No sites blocked yet" message');
            return;
        }

        sites.forEach(site => {
            const div = document.createElement('div');
            div.className = 'blocked-site';

            const span = document.createElement('span');
            span.textContent = site;

            const btn = document.createElement('button');
            btn.className = 'remove-site-btn';
            btn.setAttribute('data-site', site);
            btn.setAttribute('title', `Remove ${site}`);
            btn.textContent = '×';

            div.appendChild(span);
            div.appendChild(btn);
            this.blockList.appendChild(div);
        });
        
        console.log('[Popup] Rendered', sites.length, 'blocked sites');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new PomodoroTimer();
});