document.addEventListener('DOMContentLoaded', () => {
    const quotes = [
        { quote: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
        { quote: "Concentrate all your thoughts upon the work in hand.", author: "Alexander Graham Bell" },
        { quote: "The successful warrior is the average man, with laser-like focus.", author: "Bruce Lee" }
    ];

    const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
    document.getElementById('quote').textContent = `"${randomQuote.quote}"`;
    document.getElementById('author').textContent = `- ${randomQuote.author}`;

    const overrideBtn = document.getElementById('overrideBtn');
    overrideBtn.addEventListener('click', () => {
        browser.runtime.sendMessage({ action: 'overrideBlock' });
        overrideBtn.textContent = "You have 1 minute of access!";
        overrideBtn.disabled = true;
    });
});