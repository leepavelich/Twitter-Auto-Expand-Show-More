// ==UserScript==
// @name         Twitter Auto Expand Tweets
// @namespace    leepavelich
// @version      0.1
// @description  Automatically expands tweets with more than 280 characters
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const fixTweet = tweet => {
        if (!tweet?.legacy) return;

        if (tweet.note_tweet) {
            const noteResults = tweet.note_tweet.note_tweet_results.result;
            tweet.legacy.full_text = noteResults.text;
            tweet.legacy.display_text_range = [0, noteResults.text.length];

            ["user_mentions", "urls", "hashtags", "media", "symbols"].forEach(key => {
                if (noteResults.entity_set[key]) {
                    tweet.legacy.entities[key] = noteResults.entity_set[key];
                }
            });
        }

        tweet.quoted_status_result?.result && fixTweet(tweet.quoted_status_result.result);
        tweet.legacy.retweeted_status_result?.result && fixTweet(tweet.legacy.retweeted_status_result.result);
    };

    const patchApiResult = (apiPath, data) => {
        let timeline;

        if (apiPath === "TweetDetail") {
            timeline = data.data.threaded_conversation_with_injections_v2;
        } else if (["HomeTimeline", "HomeLatestTimeline", "UserTweets", "UserTweetsAndReplies", "UserMedia", "Likes", "SearchTimeline"].includes(apiPath)) {
            timeline = data.data[Object.keys(data.data)[0]].timeline;
        } else {
            return data;
        }

        if (!timeline) return data;

        timeline.instructions?.forEach(instruction => {
            if (instruction.type === "TimelineAddEntries") {
                instruction.entries.forEach(entry => {
                    const content = entry.content?.itemContent?.tweet_results?.result;
                    const items = entry.content?.items;
                    content && fixTweet(content);
                    items?.forEach(item => {
                        const itemContent = item.item?.itemContent?.tweet_results?.result;
                        itemContent && fixTweet(itemContent);
                    });
                });
            }
        });

        removeShowMoreLinks();
        return data;
    };

    const removeShowMoreLinks = () => {
        document.querySelectorAll('[data-testid="tweet-text-show-more-link"]').forEach(link => link.remove());
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
        this.addEventListener('readystatechange', function (event) {
            if (this.readyState === 4) {
                const urlPath = event.target.responseURL ? new URL(event.target.responseURL).pathname : "";
                const apiPath = urlPath.split("/").pop();
                const validPaths = ["UserTweets", "HomeTimeline", "HomeLatestTimeline", "SearchTimeline", "TweetDetail", "UserTweetsAndReplies", "UserMedia", "Likes"];

                if (urlPath.startsWith("/i/api/") && validPaths.includes(apiPath)) {
                    let responseData = JSON.parse(this.responseText);
                    responseData = patchApiResult(apiPath, responseData);
                    Object.defineProperty(this, 'response', { writable: true });
                    Object.defineProperty(this, 'responseText', { writable: true });
                    this.response = this.responseText = JSON.stringify(responseData);
                }
            }
        });
        return originalOpen.apply(this, arguments);
    };
})();
