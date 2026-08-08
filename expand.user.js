// ==UserScript==
// @name         Twitter Auto Expand Tweets
// @namespace    leepavelich
// @version      0.2
// @description  Automatically expands tweets with more than 280 characters
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const VALID_PATHS = [
        "TweetDetail",
        "HomeTimeline",
        "HomeLatestTimeline",
        "UserTweets",
        "UserTweetsAndReplies",
        "UserMedia",
        "Likes",
        "SearchTimeline",
        "Bookmarks",
        "ListLatestTweetsTimeline",
    ];

    const ENTITY_KEYS = ["user_mentions", "urls", "hashtags", "media", "symbols"];

    const expandNoteTweet = tweet => {
        const note = tweet.note_tweet?.note_tweet_results?.result;
        if (!note?.text || !tweet.legacy) return false;

        tweet.legacy.full_text = note.text;
        // display_text_range is measured in Unicode code points, not UTF-16 units
        tweet.legacy.display_text_range = [0, [...note.text].length];

        tweet.legacy.entities = tweet.legacy.entities ?? {};
        ENTITY_KEYS.forEach(key => {
            if (note.entity_set?.[key]) {
                tweet.legacy.entities[key] = note.entity_set[key];
            }
        });
        return true;
    };

    // Walk the whole response and expand every note tweet found, wherever the
    // endpoint nests them (timelines, pinned entries, modules, quoted tweets,
    // visibility wrappers, ...). Returns the number of tweets expanded.
    const expandAll = node => {
        if (!node || typeof node !== "object") return 0;
        let count = 0;
        if (!Array.isArray(node) && node.note_tweet && node.legacy) {
            count += expandNoteTweet(node) ? 1 : 0;
        }
        Object.values(node).forEach(child => { count += expandAll(child); });
        return count;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
        this.addEventListener('readystatechange', function () {
            if (this.readyState !== 4) return;
            // responseText is only readable when responseType is '' or 'text'
            if (this.responseType && this.responseType !== 'text') return;
            try {
                const urlPath = this.responseURL ? new URL(this.responseURL).pathname : "";
                if (!urlPath.startsWith("/i/api/")) return;
                if (!VALID_PATHS.includes(urlPath.split("/").pop())) return;

                const data = JSON.parse(this.responseText);
                if (expandAll(data) > 0) {
                    const patched = JSON.stringify(data);
                    Object.defineProperty(this, 'response', { value: patched });
                    Object.defineProperty(this, 'responseText', { value: patched });
                }
            } catch {
                // Never let a malformed or unexpected response break the page's
                // own handlers; the tweet just stays truncated.
            }
        });
        return originalOpen.apply(this, arguments);
    };

    // The client may still render a "Show more" link on expanded tweets (it
    // keys off note_tweet, which we leave in place). Remove the links as they
    // are rendered, not just when a response is patched.
    const SHOW_MORE_SELECTOR = '[data-testid="tweet-text-show-more-link"]';
    const startLinkRemover = () => {
        const removeShowMoreLinks = () =>
            document.querySelectorAll(SHOW_MORE_SELECTOR).forEach(link => link.remove());
        removeShowMoreLinks();
        new MutationObserver(removeShowMoreLinks)
            .observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) {
        startLinkRemover();
    } else {
        document.addEventListener('DOMContentLoaded', startLinkRemover);
    }
})();
