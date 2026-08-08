// Test harness for expand.user.js — runs under Deno (`deno test`).
// Loads the userscript with mocked XMLHttpRequest/document globals and
// drives fake GraphQL responses through the XHR hook.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SCRIPT_PATH = new URL("../expand.user.js", import.meta.url);
const SCRIPT_SRC = await Deno.readTextFile(SCRIPT_PATH);

// ---------- mocks ----------

class FakeXHR {
  constructor() {
    this.listeners = [];
    this.readyState = 0;
    this.responseType = "";
  }
  addEventListener(type, fn) {
    if (type === "readystatechange") this.listeners.push(fn);
  }
  open() {}
  // Simulate a completed request the way the browser would.
  complete(url, body) {
    this.readyState = 4;
    this.responseURL = url;
    this.response = body;
    this.responseText = body;
    for (const fn of this.listeners) fn.call(this, { target: this });
  }
}

function freshEnvironment() {
  const removedNodes = [];
  const documentMock = {
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: null,
    documentElement: { appendChild: () => {} },
    removedNodes,
  };
  const XHRCtor = function () {
    return new FakeXHR();
  };
  XHRCtor.prototype = FakeXHR.prototype;

  const globals = {
    XMLHttpRequest: XHRCtor,
    document: documentMock,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    window: undefined,
  };
  // Run the userscript with our mocks bound as locals shadowing globals.
  const runner = new Function(
    "XMLHttpRequest",
    "document",
    "MutationObserver",
    "window",
    SCRIPT_SRC
  );
  runner(XHRCtor, documentMock, globals.MutationObserver, globals.window);
  return { XHRCtor, documentMock };
}

function makeXHR(XHRCtor) {
  const xhr = new FakeXHR();
  // The userscript patched XHRCtor.prototype.open (=== FakeXHR.prototype.open)
  xhr.open("GET", "ignored");
  return xhr;
}

const GQL = (op) => `https://x.com/i/api/graphql/AbCdEf123/${op}`;

// ---------- fixtures ----------

const LONG_TEXT =
  "This is the full untruncated note tweet text. ".repeat(10).trim();

function noteTweetResult(id, text = LONG_TEXT, extra = {}) {
  return {
    __typename: "Tweet",
    rest_id: id,
    legacy: {
      full_text: text.slice(0, 280) + "…",
      display_text_range: [0, 281],
      entities: { user_mentions: [], urls: [], hashtags: [], symbols: [] },
    },
    note_tweet: {
      is_expandable: true,
      note_tweet_results: {
        result: {
          text,
          entity_set: {
            user_mentions: [{ screen_name: "someone", indices: [10, 18] }],
            urls: [],
            hashtags: [],
            symbols: [],
          },
        },
      },
    },
    ...extra,
  };
}

function tweetDetailResponse(result) {
  return {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              {
                entryId: "tweet-1",
                content: {
                  entryType: "TimelineTimelineItem",
                  itemContent: { tweet_results: { result } },
                },
              },
            ],
          },
        ],
      },
    },
  };
}

function homeTimelineResponse(result) {
  return {
    data: {
      home: {
        timeline: {
          instructions: [
            {
              type: "TimelineAddEntries",
              entries: [
                {
                  entryId: "tweet-1",
                  content: {
                    entryType: "TimelineTimelineItem",
                    itemContent: { tweet_results: { result } },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  };
}

// ---------- tests ----------

Deno.test("TweetDetail: note tweet text is expanded", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const body = JSON.stringify(tweetDetailResponse(noteTweetResult("1")));
  xhr.complete(GQL("TweetDetail"), body);

  const patched = JSON.parse(xhr.responseText);
  const tweet =
    patched.data.threaded_conversation_with_injections_v2.instructions[0]
      .entries[0].content.itemContent.tweet_results.result;
  assertEquals(tweet.legacy.full_text, LONG_TEXT);
  assertEquals(tweet.legacy.entities.user_mentions.length, 1);
});

Deno.test("HomeTimeline: note tweet text is expanded", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const body = JSON.stringify(homeTimelineResponse(noteTweetResult("2")));
  xhr.complete(GQL("HomeTimeline"), body);

  const tweet =
    JSON.parse(xhr.responseText).data.home.timeline.instructions[0].entries[0]
      .content.itemContent.tweet_results.result;
  assertEquals(tweet.legacy.full_text, LONG_TEXT);
});

Deno.test("quoted note tweet inside a tweet is expanded", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const outer = noteTweetResult("3");
  delete outer.note_tweet;
  outer.quoted_status_result = { result: noteTweetResult("4") };
  xhr.complete(GQL("TweetDetail"), JSON.stringify(tweetDetailResponse(outer)));

  const tweet =
    JSON.parse(xhr.responseText).data.threaded_conversation_with_injections_v2
      .instructions[0].entries[0].content.itemContent.tweet_results.result;
  assertEquals(tweet.quoted_status_result.result.legacy.full_text, LONG_TEXT);
});

Deno.test("non-graphql URLs and unknown operations are left untouched", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const body = JSON.stringify({ hello: "world" });
  xhr.complete("https://x.com/i/api/1.1/jot/client_event.json", body);
  assertEquals(xhr.responseText, body);
});

Deno.test("GraphQL error payload (no data key) does not throw", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const body = JSON.stringify({
    errors: [{ message: "Rate limit exceeded", code: 88 }],
  });
  // Must not throw and must not corrupt the body.
  xhr.complete(GQL("TweetDetail"), body);
  assertEquals(JSON.parse(xhr.responseText).errors[0].code, 88);
});

Deno.test("empty data object on a timeline endpoint does not throw", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const body = JSON.stringify({ data: {} });
  xhr.complete(GQL("HomeTimeline"), body);
  assertEquals(JSON.parse(xhr.responseText).data, {});
});

Deno.test("non-JSON body does not throw", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  xhr.complete(GQL("TweetDetail"), "<html>502 Bad Gateway</html>");
  assertEquals(xhr.responseText, "<html>502 Bad Gateway</html>");
});

Deno.test("TweetWithVisibilityResults wrapper is unwrapped and expanded", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const wrapped = {
    __typename: "TweetWithVisibilityResults",
    tweet: noteTweetResult("5"),
    limitedActionResults: { limited_actions: [] },
  };
  xhr.complete(
    GQL("TweetDetail"),
    JSON.stringify(tweetDetailResponse(wrapped))
  );

  const result =
    JSON.parse(xhr.responseText).data.threaded_conversation_with_injections_v2
      .instructions[0].entries[0].content.itemContent.tweet_results.result;
  assertEquals(result.tweet.legacy.full_text, LONG_TEXT);
});

Deno.test("note tweet without entity_set does not throw", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const t = noteTweetResult("6");
  delete t.note_tweet.note_tweet_results.result.entity_set;
  xhr.complete(GQL("TweetDetail"), JSON.stringify(tweetDetailResponse(t)));

  const tweet =
    JSON.parse(xhr.responseText).data.threaded_conversation_with_injections_v2
      .instructions[0].entries[0].content.itemContent.tweet_results.result;
  assertEquals(tweet.legacy.full_text, LONG_TEXT);
});

Deno.test("display_text_range counts code points, not UTF-16 units", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const emojiText = "long tweet with emoji 🎉🎉🎉 end";
  const codePoints = [...emojiText].length; // 28
  const utf16Units = emojiText.length; // 31
  assert(codePoints !== utf16Units, "fixture must contain astral chars");

  const t = noteTweetResult("7", emojiText);
  xhr.complete(GQL("TweetDetail"), JSON.stringify(tweetDetailResponse(t)));

  const tweet =
    JSON.parse(xhr.responseText).data.threaded_conversation_with_injections_v2
      .instructions[0].entries[0].content.itemContent.tweet_results.result;
  assertEquals(tweet.legacy.display_text_range, [0, codePoints]);
});

Deno.test("TimelinePinEntry (pinned tweet) is expanded", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const body = {
    data: {
      user: {
        result: { timeline: null },
      },
    },
  };
  // UserTweets shape: first key -> .timeline (v2 uses timeline_v2 in some
  // deployments; script reads whatever the first key's .timeline is)
  body.data.user.result = undefined;
  body.data.user = {
    timeline: {
      instructions: [
        {
          type: "TimelinePinEntry",
          entry: {
            entryId: "tweet-pin-1",
            content: {
              entryType: "TimelineTimelineItem",
              itemContent: { tweet_results: { result: noteTweetResult("8") } },
            },
          },
        },
      ],
    },
  };
  xhr.complete(GQL("UserTweets"), JSON.stringify(body));

  const tweet =
    JSON.parse(xhr.responseText).data.user.timeline.instructions[0].entry
      .content.itemContent.tweet_results.result;
  assertEquals(tweet.legacy.full_text, LONG_TEXT);
});

Deno.test("module items (e.g. conversation modules) are expanded", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const body = {
    data: {
      home: {
        timeline: {
          instructions: [
            {
              type: "TimelineAddEntries",
              entries: [
                {
                  entryId: "conv-1",
                  content: {
                    entryType: "TimelineTimelineModule",
                    items: [
                      {
                        entryId: "conv-1-tweet-1",
                        item: {
                          itemContent: {
                            tweet_results: { result: noteTweetResult("9") },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    },
  };
  xhr.complete(GQL("HomeTimeline"), JSON.stringify(body));

  const tweet =
    JSON.parse(xhr.responseText).data.home.timeline.instructions[0].entries[0]
      .content.items[0].item.itemContent.tweet_results.result;
  assertEquals(tweet.legacy.full_text, LONG_TEXT);
});

Deno.test("SearchTimeline: timeline nested under search_timeline is expanded", () => {
  // Real SearchTimeline responses nest as
  // data.search_by_raw_query.search_timeline.timeline — not first-key.timeline.
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  const body = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  {
                    entryId: "tweet-1",
                    content: {
                      entryType: "TimelineTimelineItem",
                      itemContent: {
                        tweet_results: { result: noteTweetResult("11") },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
  xhr.complete(GQL("SearchTimeline"), JSON.stringify(body));

  const tweet =
    JSON.parse(xhr.responseText).data.search_by_raw_query.search_timeline
      .timeline.instructions[0].entries[0].content.itemContent.tweet_results
      .result;
  assertEquals(tweet.legacy.full_text, LONG_TEXT);
});

Deno.test("json responseType is left alone (responseText would throw in-browser)", () => {
  const { XHRCtor } = freshEnvironment();
  const xhr = makeXHR(XHRCtor);
  xhr.responseType = "json";
  // In a real browser, touching responseText with responseType 'json' throws
  // InvalidStateError. Simulate by making responseText a throwing getter.
  const parsed = tweetDetailResponse(noteTweetResult("10"));
  xhr.readyState = 4;
  xhr.responseURL = GQL("TweetDetail");
  xhr.response = parsed;
  Object.defineProperty(xhr, "responseText", {
    configurable: true,
    get() {
      throw new DOMException(
        "responseText only available for text",
        "InvalidStateError"
      );
    },
  });
  // Must not throw out of the listener.
  for (const fn of xhr.listeners) fn.call(xhr, { target: xhr });
});
