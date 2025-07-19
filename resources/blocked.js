document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const blockedUrl = urlParams.get('url');
    if (blockedUrl) {
        document.getElementById('blockedUrl').textContent = blockedUrl;
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
    overrideBtn.addEventListener('click', () => {
        browser.runtime.sendMessage({ action: 'overrideBlock' }).then(() => {
            overrideBtn.textContent = "You have 1 minute of access!";
            overrideBtn.disabled = true;
            overrideBtn.style.background = '#27ae60';

            // Redirect back to the original page
            if (blockedUrl) {
                window.location.href = blockedUrl;
            } else {
                window.history.back();
            }
        });
    });
});