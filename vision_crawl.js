import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import OpenAI from 'openai';
import readline from 'readline';
import fs from 'fs';

puppeteer.use(StealthPlugin());

const openai = new OpenAI();
const delay = 8000;

async function convertImageToBase64(imagePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(imagePath, (err, data) => {
            if (err) {
                console.error('Error reading the file:', err);
                reject();
                return;
            }

            const base64String = data.toString('base64');
            const base64Image = `data:image/jpeg;base64,${base64String}`;
            resolve(base64Image);
        });
    });
}

async function getUserInput(query) {
    let userResponse;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    await new Promise(resolve => {
        rl.question(query, (response) => {
            userResponse = response;
            rl.close();
            resolve();
        });
    });

    return userResponse;
}

async function pause(duration) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, duration);
    });
}

async function markClickableElements(page) {
    await page.evaluate(() => {
        document.querySelectorAll('[gpt-link-label]').forEach(e => {
            e.removeAttribute("gpt-link-label");
        });
    });

    const elements = await page.$$(
        "a, button, input, textarea, [role=button], [role=treeitem]"
    );

    elements.forEach(async e => {
        await page.evaluate(e => {
            function isVisible(element) {
                if (!element) return false;

                function checkVisibility(element) {
                    const style = window.getComputedStyle(element);
                    return style.width !== '0' &&
                        style.height !== '0' &&
                        style.opacity !== '0' &&
                        style.display !== 'none' &&
                        style.visibility !== 'hidden';
                }

                function isInViewport(element) {
                    const rect = element.getBoundingClientRect();
                    return (
                        rect.top >= 0 &&
                        rect.left >= 0 &&
                        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
                    );
                }

                if (!checkVisibility(element)) {
                    return false;
                }

                let parent = element;
                while (parent) {
                    if (!checkVisibility(parent)) {
                        return false;
                    }
                    parent = parent.parentElement;
                }

                return isInViewport(element);
            }

            e.style.border = "1px solid red";

            const rect = e.getBoundingClientRect();

            if (rect.width > 5 && rect.height > 5 && isVisible(e)) {
                const linkLabel = e.textContent.replace(/[^a-zA-Z0-9 ]/g, '');
                e.setAttribute("gpt-link-label", linkLabel);
            }
        }, e);
    });
}

async function listenForEvent(page, eventName) {
    return page.evaluate(eventName => {
        return new Promise(resolve => {
            document.addEventListener(eventName, () => {
                resolve();
            });
        });
    }, eventName);
}

(async () => {
    console.log("Agent started:");

    const browser = await puppeteer.launch({
        headless: "new",
    });

    const page = await browser.newPage();

    await page.setViewport({
        width: 1200,
        height: 1200,
        deviceScaleFactor: 1.75,
    });

    const chatMessages = [
        {
            "role": "system",
            "content": `You are a web crawler equipped with browsing capabilities. You'll receive instructions to browse websites, and a screenshot will be provided showing the current webpage, with clickable elements highlighted in red. Always base your actions on the screenshot provided, and avoid guessing link names.

To navigate to a specific URL, respond in the following JSON format:
{"url": "desired URL here"}

To click on a link or button, reference the text within it using this JSON format:
{"click": "Text in link"}

Once you've gathered the necessary information from a webpage, respond with a regular message.

Initially, navigate directly to a relevant URL, such as 'https://google.com/search?q=your query' for simple searches. If the user provides a direct URL, start there.`,
        }
    ];

    console.log("GPT: How can I assist you today?");
    const userQuery = await getUserInput("You: ");
    console.log();

    chatMessages.push({
        "role": "user",
        "content": userQuery,
    });

    let currentUrl;
    let screenshotCaptured = false;

    while (true) {
        if (currentUrl) {
            console.log("Navigating to " + currentUrl);
            await page.goto(currentUrl, {
                waitUntil: "domcontentloaded",
            });

            await markClickableElements(page);

            await Promise.race([
                listenForEvent(page, 'load'),
                pause(delay)
            ]);

            await markClickableElements(page);

            await page.screenshot({
                path: "screenshot.jpg",
                quality: 100,
            });

            screenshotCaptured = true;
            currentUrl = null;
        }

        if (screenshotCaptured) {
            const base64Screenshot = await convertImageToBase64("screenshot.jpg");

            chatMessages.push({
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": base64Screenshot,
                    },
                    {
                        "type": "text",
                        "text": "Here's the screenshot of the current webpage. You can click links with {\"click\": \"Link text\"} or navigate to a different URL if needed. If you find the answer to the user's query, respond with a regular message.",
                    }
                ]
            });

            screenshotCaptured = false;
        }

        const response = await fetch('/api/v1/chat_media', {
            method: 'POST',
            headers: {
              "Content-Type": "multipart/form-data"
            },
            body: JSON.stringify({
              "user_id": "text",
              "session_id": "text",
              "chat_data": JSON.stringify(chatMessages),
              "files": [
                "binary"
              ]
            }),
        });

        const assistantMessage = response.choices[0].message;
        const assistantText = assistantMessage.content;

        chatMessages.push({
            "role": "assistant",
            "content": assistantText,
        });

        console.log("GPT: " + assistantText);

        if (assistantText.indexOf('{"click": "') !== -1) {
            let parts = assistantText.split('{"click": "');
            parts = parts[1].split('"}');
            const linkLabel = parts[0].replace(/[^a-zA-Z0-9 ]/g, '');

            console.log("Clicking on " + linkLabel);

            try {
                const elements = await page.$$('[gpt-link-label]');

                let partialMatch;
                let exactMatch;

                for (const element of elements) {
                    const attributeValue = await element.getAttribute('gpt-link-label');

                    if (attributeValue.includes(linkLabel)) {
                        partialMatch = element;
                    }

                    if (attributeValue === linkLabel) {
                        exactMatch = element;
                    }
                }

                if (exactMatch) {
                    await exactMatch.click();
                } else if (partialMatch) {
                    await partialMatch.click();
                } else {
                    throw new Error("Unable to find the link");
                }

                await Promise.race([
                    listenForEvent(page, 'load'),
                    pause(delay)
                ]);

                await markClickableElements(page);

                await page.screenshot({
                    path: "screenshot.jpg",
                    quality: 100,
                });

                screenshotCaptured = true;
            } catch (error) {
                console.log("ERROR: Failed to click on the element");

                chatMessages.push({
                    "role": "user",
                    "content": "ERROR: Unable to click that element",
                });
            }

            continue;
        } else if (assistantText.indexOf('{"url": "') !== -1) {
            let parts = assistantText.split('{"url": "');
            parts = parts[1].split('"}');
            currentUrl = parts[0];

            continue;
        }

        const userQuery = await getUserInput("You: ");
        console.log();

        chatMessages.push({
            "role": "user",
            "content": userQuery,
        });
    }
})();
