document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const blockedUrl = urlParams.get('url');
    if (blockedUrl) {
        document.getElementById('blockedUrl').textContent = blockedUrl;
    }

    /**
     * Validates that the blocked URL is suitable for redirection
     * Requirements: 5.3, 1.2
     */
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

    /**
     * Gets current tab context with error handling
     * Requirements: 5.3, 1.2
     */
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
        { quote: "Where focus goes, energy flows and results show.", author: "Tony Robbins" }
    ];

    const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
    document.getElementById('quote').textContent = `"${randomQuote.quote}"`;
    document.getElementById('author').textContent = `- ${randomQuote.author}`;

    const overrideBtn = document.getElementById('overrideBtn');
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
                overrideBtn.textContent = "I really need to access this (1 min)";
                overrideBtn.style.background = '';
                overrideBtn.disabled = false;
            }, 3000);
        }
    });
});