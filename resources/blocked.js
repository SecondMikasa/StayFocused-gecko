document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const blockedUrl = urlParams.get('url');
    const blockingMode = urlParams.get('mode') || 'focus-only';
    const timerRunning = urlParams.get('timerRunning') === 'true';
    const currentPhase = urlParams.get('phase') || 'focus';
    
    if (blockedUrl) {
        document.getElementById('blockedUrl').textContent = blockedUrl;
    }
    
    // Show appropriate blocking reason message
    updateBlockingReasonDisplay(blockingMode, timerRunning, currentPhase);

    function updateBlockingReasonDisplay(mode, isTimerRunning, phase) {
        const focusModeMessage = document.getElementById('focusModeMessage');
        const alwaysModeMessage = document.getElementById('alwaysModeMessage');
        
        // Hide both messages initially
        focusModeMessage.style.display = 'none';
        alwaysModeMessage.style.display = 'none';
        
        if (mode === 'focus-only') {
            // Show focus mode message with current timer state
            focusModeMessage.style.display = 'block';
            if (isTimerRunning && phase === 'focus') {
                focusModeMessage.innerHTML = '<span class="mode-icon">⏰</span> Blocked during active focus session';
            } else if (isTimerRunning && phase !== 'focus') {
                focusModeMessage.innerHTML = '<span class="mode-icon">⏰</span> Blocked during timer session';
            } else {
                focusModeMessage.innerHTML = '<span class="mode-icon">⏰</span> Blocked during focus mode';
            }
        } else if (mode === 'always') {
            // Show always mode message
            alwaysModeMessage.style.display = 'block';
            alwaysModeMessage.innerHTML = '<span class="mode-icon">🚫</span> Always blocked';
        }
    }

    function validateRedirectionUrl(url) {
        if (!url) {
            throw new Error('No URL provided for redirection');
        }
        
        if (typeof url !== 'string' || url.trim().length === 0) {
            throw new Error('URL must be a non-empty string');
        }
        
        try {
            const urlObj = new URL(url);
            // Ensure it's a valid HTTP/HTTPS URL
            if (!['http:', 'https:'].includes(urlObj.protocol)) {
                throw new Error(`Invalid protocol for redirection: ${urlObj.protocol}`);
            }
            
            // Ensure the URL has a valid hostname
            if (!urlObj.hostname || urlObj.hostname.length === 0) {
                throw new Error('URL must have a valid hostname');
            }
            
            return true;
        } catch (error) {
            throw new Error(`Invalid URL for redirection: ${error.message}`);
        }
    }

    async function getCurrentTabContext() {
        try {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs.length > 0) {
                const tab = tabs[0];
                
                // Validate that we have a valid tab ID
                if (!tab.id || tab.id < 0) {
                    console.error('[TabContext] Invalid tab ID received:', tab.id);
                    throw new Error('Invalid tab ID received from browser API');
                }
                
                console.log(`[TabContext] Found active tab: ID=${tab.id}, URL=${tab.url}`);
                return {
                    id: tab.id,
                    url: tab.url,
                    windowId: tab.windowId
                };
            } else {
                console.warn('[TabContext] No active tab found in current window');
                throw new Error('No active tab found in current window');
            }
        } catch (error) {
            console.error('[TabContext] Failed to get current tab context:', error);
            throw new Error(`Failed to get tab context: ${error.message}`);
        }
    }

    const quotes = [
        { quote: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
        { quote: "The secret of getting ahead is getting started.", author: "Mark Twain" },
        { quote: "Concentrate all your thoughts upon the work in hand.", author: "Alexander Graham Bell" },
        { quote: "The successful warrior is the average man, with laser-like focus.", author: "Bruce Lee" },
        { quote: "Focus is a matter of deciding what things you're not going to do.", author: "John Carmack" },
        { quote: "Where focus goes, energy flows and results show.", author: "Tony Robbins" },
        { quote: "The art of being wise is knowing what to overlook.", author: "William James" },
        { quote: "Concentration is the secret of strength.", author: "Ralph Waldo Emerson" },
        { quote: "The successful person has the habit of doing the things failures don't like to do.", author: "Thomas Edison" },
        { quote: "You are what you do, not what you say you'll do.", author: "Carl Jung" },
        { quote: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
        { quote: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
        { quote: "The future depends on what you do today.", author: "Mahatma Gandhi" },
        { quote: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
        { quote: "What we plant in the soil of contemplation, we shall reap in the harvest of action.", author: "Meister Eckhart" },
        { quote: "The mind is everything. What you think you become.", author: "Buddha" },
        { quote: "Your limitation—it's only your imagination.", author: "Unknown" },
        { quote: "Push yourself, because no one else is going to do it for you.", author: "Unknown" },
        { quote: "Great things never come from comfort zones.", author: "Unknown" },
        { quote: "Dream it. Wish it. Do it.", author: "Unknown" },
        { quote: "Success doesn't just find you. You have to go out and get it.", author: "Unknown" },
        { quote: "The harder you work for something, the greater you'll feel when you achieve it.", author: "Unknown" },
        { quote: "Dream bigger. Do bigger.", author: "Unknown" },
        { quote: "Don't stop when you're tired. Stop when you're done.", author: "Unknown" },
        { quote: "Wake up with determination. Go to bed with satisfaction.", author: "Unknown" },
        { quote: "Do something today that your future self will thank you for.", author: "Sean Patrick Flanery" },
        { quote: "Little things make big days.", author: "Unknown" },
        { quote: "It's going to be hard, but hard does not mean impossible.", author: "Unknown" },
        { quote: "Don't wait for opportunity. Create it.", author: "Unknown" },
        { quote: "Sometimes we're tested not to show our weaknesses, but to discover our strengths.", author: "Unknown" }
    ];

    const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
    document.getElementById('quote').textContent = `"${randomQuote.quote}"`;
    document.getElementById('author').textContent = `- ${randomQuote.author}`;
    
    // Visual Enhancements Class
    class VisualEnhancements {
        constructor() {
            this.focusStartTime = Date.now();
            
            this.initializeElements();
            this.startFocusTimer();
            this.addInteractionEffects();
            this.createSparkleEffect();
        }
        
        initializeElements() {
            this.focusTimeElement = document.getElementById('focusTime');
        }
        
        startFocusTimer() {
            setInterval(() => {
                const elapsed = Math.floor((Date.now() - this.focusStartTime) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                this.focusTimeElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            }, 1000);
        }
        
        addInteractionEffects() {
            // Add click effects to interactive elements
            document.querySelectorAll('.interactive-element').forEach(element => {
                element.addEventListener('click', (e) => {
                    this.createRippleEffect(e);
                });
            });
            
            // Add hover effects to animated icons
            document.querySelectorAll('.animated-icon').forEach(icon => {
                icon.addEventListener('mouseenter', () => {
                    this.createSparkles(icon);
                });
            });
        }
        
        createRippleEffect(event) {
            const button = event.currentTarget;
            const rect = button.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = event.clientX - rect.left - size / 2;
            const y = event.clientY - rect.top - size / 2;
            
            const ripple = document.createElement('div');
            ripple.style.cssText = `
                position: absolute;
                width: ${size}px;
                height: ${size}px;
                left: ${x}px;
                top: ${y}px;
                background: rgba(255, 255, 255, 0.3);
                border-radius: 50%;
                transform: scale(0);
                animation: ripple 0.6s ease-out;
                pointer-events: none;
            `;
            
            button.appendChild(ripple);
            setTimeout(() => ripple.remove(), 600);
        }
        
        createSparkles(element) {
            const rect = element.getBoundingClientRect();
            
            for (let i = 0; i < 3; i++) {
                setTimeout(() => {
                    const sparkle = document.createElement('div');
                    sparkle.className = 'sparkle';
                    
                    const x = rect.left + Math.random() * rect.width;
                    const y = rect.top + Math.random() * rect.height;
                    
                    sparkle.style.left = x + 'px';
                    sparkle.style.top = y + 'px';
                    
                    document.body.appendChild(sparkle);
                    
                    setTimeout(() => sparkle.remove(), 1500);
                }, i * 100);
            }
        }
        
        createSparkleEffect() {
            // Periodic sparkle effect on the main container
            setInterval(() => {
                const container = document.querySelector('.container');
                if (container && Math.random() < 0.3) { // 30% chance every interval
                    this.createSparkles(container);
                }
            }, 5000);
        }
    }
    
    // Initialize visual enhancements
    const visualEnhancements = new VisualEnhancements();
    
    const overrideBtn = document.getElementById('overrideBtn');
    
    // Load and set the dynamic override time
    let overrideMinutes = 1; // Default
    
    // Function to update button text
    function updateButtonText(minutes) {
        const timeText = minutes === 1 ? '1 min' : `${minutes} min`;
        overrideBtn.innerHTML = `🔓 I really need to access this (${timeText})`;
    }
    
    // Load override time and update button
    browser.storage.local.get('overrideTime').then(result => {
        overrideMinutes = result.overrideTime || 1;
        updateButtonText(overrideMinutes);
    }).catch(error => {
        console.error('Error loading override time:', error);
        updateButtonText(1);
    });
    
    overrideBtn.addEventListener('click', async () => {
        try {
            // Disable button immediately to prevent double-clicks
            overrideBtn.disabled = true;
            overrideBtn.textContent = "Requesting access...";
            overrideBtn.style.background = '#f39c12';

            // Validate that we have a blocked URL to redirect to
            if (!blockedUrl) {
                throw new Error('No original URL available for redirection');
            }

            // Validate the URL is suitable for redirection
            validateRedirectionUrl(blockedUrl);

            // Get current tab information with better error handling
            const currentTab = await getCurrentTabContext();
            
            // Ensure we have valid tab context before proceeding
            if (!currentTab || !currentTab.id) {
                throw new Error('Unable to determine current tab context for override request');
            }
            
            // Send override request with tab context and original URL
            const overrideRequest = {
                action: 'overrideBlock',
                tabId: currentTab.id,
                originalUrl: blockedUrl,
                timestamp: Date.now() // Add timestamp for debugging
            };
            
            console.log('[Override] Sending override request:', overrideRequest);
            
            // Add timeout to override request
            const response = await Promise.race([
                browser.runtime.sendMessage(overrideRequest),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Override request timeout')), 5000)
                )
            ]);
            
            if (response && response.success) {
                // Update button to show success
                overrideBtn.textContent = "Access granted! Redirecting...";
                overrideBtn.style.background = '#27ae60';
                
                // Validate the URL one more time before redirecting
                try {
                    validateRedirectionUrl(blockedUrl);
                } catch (validationError) {
                    throw new Error(`Cannot redirect: ${validationError.message}`);
                }
                
                // Brief delay to show success message before redirect
                setTimeout(() => {
                    console.log(`[Override] Redirecting to: ${blockedUrl}`);
                    console.log(`[Override] Tab ID: ${currentTab.id} will receive floating timer`);
                    
                    // Perform the redirection
                    window.location.href = blockedUrl;
                }, 500);
            } else {
                const errorMsg = response && response.error ? response.error : 'Override request was not successful';
                throw new Error(errorMsg);
            }
            
        } catch (error) {
            console.error('[Override] Failed to request override:', error);
            
            // Reset button state and show error
            overrideBtn.disabled = false;
            
            // Show specific error messages
            let errorText = "Error - try again";
            if (error.message.includes('timeout')) {
                errorText = "Timeout - try again";
            } else if (error.message.includes('Extension context invalidated')) {
                errorText = "Extension reloaded - try again";
            } else if (error.message.includes('Invalid URL')) {
                errorText = "Invalid URL";
            } else if (error.message.includes('tab context')) {
                errorText = "Tab error - refresh page";
            }
            
            overrideBtn.textContent = errorText;
            overrideBtn.style.background = '#e74c3c';
            
            // Reset button after a delay
            setTimeout(() => {
                updateButtonText(overrideMinutes);
                overrideBtn.style.background = '';
                overrideBtn.disabled = false;
            }, 3000);
        }
    });
});