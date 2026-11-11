# **GetHookd - Technical Assessment** 

## **Overview** 

GetHookd is an ad-intelligence platform: marketers search millions of ads to find what is working and copy it. A growing share of our traffic no longer comes from people clicking through a UI. It comes from AI agents calling our API and MCP server on a customer's behalf. This assessment is a small, production-minded slice of that work. 

## **The scenario** 

A v0 ad search endpoint shipped in a hurry. Most of its traffic now comes from AI agents, and customers report: 

1. Misspelled or unknown filters return HTTP 200 with unfiltered results, so agents confidently report wrong answers. 
2. Vague errors such as `Invalid request` send agents into retry loops. 
3. Paging while new ads arrive returns duplicates and gaps. 
4. Sorting by “most impressions” puts ads that have no impression data at the top. 
5. Nobody can say exactly how many billable calls a key made, and agents that retry after a timeout are charged twice. 

#### **Build a v1 and an MCP server that fix these, without breaking anyone still calling v0.** 

## **The plan** 

|**Part**|**Focus**|
|---|---|
|0|Build the world: data model, seed, live ingest, v0 endpoint|
|1|v1 search API|
|2|MCP server and model evaluation|
|3|Keys, rate limits, metering|
|4|Developer page, design and AI notes|

The times are a guide, not a contract. If you run out of time, stop, and write down in your README what you would do next and in what order. 

## **Part 0 — Build the world MUST** 

### **0.1 Data model** 

|**Field**|**Type**|**Meaning**|
|---|---|---|
|`id`|integer or string|Stable, unique.|
|`brand_id` ,<br>`brand_name`|int, string|The advertiser. Use at least 300 brands.|
|`headline` ,<br>`body_text`|string|Ad copy, searchable by keyword.|
|`niche`|slug|One of the 12 slugs in the table below.|
|`format`|enum|`image`·<br>`video`·<br>`carousel`|
|`status`|enum|`active`(still running) ·<br>`inactive`(stopped)|
|`start_date`|date|The day the ad started running._Not_the day we found it.|
|`end_date`|date or null|Null if and only if the ad is active.|
|`impression_rank`|int ≥ 1 or null|The ad’s position in_its own brand’s_“most impressions” list,<br>1 being the highest. Null when we have no impression data<br>(about 40% of ads). A rank compares ads within one brand<br>only; rank 1 at a small brand is not comparable to rank 1 at<br>a large one.|
|`countries`|list of ISO-2 codes|Where the ad runs.|
|`discovered_at`|timestamp|When our ingest first saw the ad.|

**`days_active`** is derived, never stored: for an active ad it is `today − start_date` ; for an inactive ad it is `end_date − start_date` , in whole days. v0 and v1 must agree on it for the same ad. 

|**Niche slug**|**Display name**|**Keywords your seed must use in some headlines**|
|---|---|---|
|`skincare`|Skincare|serum, glow, SPF|
|`haircare`|Haircare|shampoo, curls|
|`supplements`|Supplements|protein, gummies|
|`fitness`|Fitness|leggings, dumbbell|
|`pet-supplies`|Pet Supplies|collar, kibble|
|`home-decor`|Home Decor|sofa, candle|
|`kitchen`|Kitchen|blender, knife|
|`apparel`|Apparel|hoodie, denim|
|`jewelry`|Jewelry|necklace, ring|
|`baby-kids`|Baby & Kids|stroller, onesie|
|`outdoor`|Outdoor|tent, backpack|
|`tech-accessories`|Tech Accessories|charger, phone case|

### **0.2 Seed** 

A deterministic seed command that creates at least **20,000 ads** across at least 300 brands and all 12 niches: roughly 60% active, start dates spread over the last two years, about 40% with a null `impression_rank` . Running it twice must produce the same data. 

### **0.3 Live ingest** 

A script that runs until stopped. Every second it inserts 1–5 new ads and deactivates 1–2 active ads (status becomes `inactive` , `end_date` becomes today). **About 30% of new ads have a** **`start_date` up to 90 days in the past** , because in real life we often discover an ad days or weeks after it started running. 

### **0.4 The v0 endpoint** 

Implement v0 exactly as specified. It stands in for an integration that real customers already depend on, quirks included. Do not fix it. 

```
GET /api/v0/ads?q=&niche=&format=&status=&page=&per_page=&api_key=
```

```
q         case-insensitive substring match on headline or body_text
niche     slug OR display name, case-insensitive ("Pet Supplies" works)
format    exact match         status   exact match
page      1-based, default 1  per_page default 20; above 100 is silently clamped to 100
sort      start_date descending (no tiebreaker)
api_key   the caller's API key, passed as a query parameter
Unknown parameters are ignored. Invalid filter values are ignored (that filter is not applied).
200 {"data":[{"id":…,"brand":"…","headline":"…","niche":"Pet Supplies",
              "format":"video","status":"active","start_date":"2026-08-01",
              "days_active":65}], "page":1, "total":1234}
400 {"error":"Invalid request"}      (for every error, including a bad key)
```

Write a v0 contract test that pins this behaviour, quirks included. It must still pass when you submit. 

## **Part 1 — v1 search API** 

- **MUST** Search by keyword with filters for `niche` (one or more slugs), `format` , `status` and 
- `started_after` (a date). Two sort orders: `newest` (by `start_date` ) and `impressions` . Ads without 
- impression data always come last, and ties are broken deterministically. 
- **MUST** Reject unknown parameters and invalid values. Say what the allowed values are and, where you 
- can, what the caller probably meant ( `nich` → `niche` , `Skincare` → `skincare` ). Every successful response echoes the filters that were actually applied, after normalisation. 
- **MUST** Cursor pagination that stays correct while the ingest script runs, for both sort orders. Walking 
- every page of a query must never return the same ad twice, and must never skip an ad that existed when the first page was served and still matches the query. Write down what your cursor promises about ads inserted or deactivated mid-walk, and prove it with a test. 
- **MUST** One error shape everywhere, including 401, 404, 422, 429 and 500: a machine-readable code, a 
- human message, what to do next, and whether retrying can help. The MCP server reuses the same codes. 
- **MUST** An OpenAPI spec that is kept true by generation or by a contract test. Write one test per filter 
- that proves the filter changes the results; the test must fail if the filter were silently ignored. 
- **SHOULD** Authenticate with `Authorization: Bearer` . The same key works on v0 (query parameter) and 
- v1 (header). 

## **Part 2 — MCP server and model evaluation** 

This part shows us your MCP experience. We care less about the transport and more about how a model experiences your tools.

- **MUST Build** `search_ads` , `get_ad` and `list_niches` on top of v1 (stdio or Streamable HTTP). The 
- MCP server shares auth, rate limits and metering with REST. 
- **MUST Tool design:** names, descriptions and input schemas that a model uses correctly on the first try. 
- Say what each tool is for, when not to use it, the valid values and where to get them (for example, niche slugs come from `list_niches` ). Be honest about what the data can and cannot answer. 
- **MUST Response design:** compact output sized for a context window, with a clear way to get more (a 
- cursor, or `get_ad` for full detail). State the size budget you chose per result and how you keep to it. 
- **MUST Errors for a literal reader:** what was wrong, the corrected call, and whether retrying will help. A 
- rate-limit error says how long to wait. 
- **MUST Evaluate with a real model** through a real MCP client you already use (Claude Desktop, Claude 
- Code, Cursor, VS Code or similar). Run 5 tasks and record whether the model picked the right tool and arguments on the first try. Two tasks are fixed; you write the other three, and at least one of yours should be ambiguous: 

1. “Find active video ads in skincare that started in the last 30 days.” 
2. “Which pet supplies brand gets the most impressions?” 

- **MUST** `MCP_EVAL.md` : the 5 tasks with results before and after your changes, plus one full transcript 

- where the model misused a tool, the description or error change you made, and the transcript after. **COULD** A script that replays the task set automatically. 

## **Part 3 — Keys, rate limits, metering** 

- **MUST** API keys stored hashed and shown exactly once. Each key has a visible prefix so a user can tell 
- keys apart, one or more scopes (at least `search:read` and `keys:manage` ), and can be revoked. A revoked key fails on its very next call, on REST and MCP alike. 
- **MUST** A per-key rate limit (use 60 requests per minute) shared across v0, v1 and MCP, returning 429 
- with an accurate `Retry-After` . 
- **MUST** Define what counts as a billable call, write the rule down, and count it exactly. Requests sent 
- with the same `Idempotency-Key` within 24 hours are billed once. Decide, and explain, how an MCP client’s retries are handled. Include a test that fires concurrent requests and proves the count is exact. 
- **SHOULD** A monthly plan quota (use 1,000 billable calls). Going over it returns a distinct, non-retryable 
- error that says when the quota resets. 

## **Part 4 — Developer page and notes** 

- **MUST** A React page to create keys (secret shown once, with a copy button), list them (prefix, scopes, 
- created, last used) and revoke them, and to see usage against the plan quota for the current period. Usage must come from the same meter that bills; do not keep a second counter. A single hard-coded local user is fine; no login is needed. 
- **SHOULD** A “Connect your AI tool” panel: a copy-paste MCP config for one client, and a check that tells 
- the user whether their first MCP call has arrived. A non-technical marketer should be able to finish setup in under five minutes. 
- **MUST** `DESIGN.md` (one page): your trade-offs; how v0 and v1 coexist; how you would ship a breaking 
- change to v1; what comes next. Our production archive is about 110 million ads, of which about 5–6 million are active. Name the first two parts of your design that would break at that size, and what you would do about them. 
- **MUST** `AI_NOTES.md` , described in the next section.

## **How you work with AI** 

We use AI tools every day and expect you to. We want to see how you direct them, check their output, and when you overrule them. 

- Work with any tools you like (Claude Code, Cursor, Copilot, ChatGPT or others). 

- Commit the instruction files you give your agents, such as `CLAUDE.md` , `AGENTS.md` , `.cursorrules` or prompt files. They are part of the submission. 

- Keep commits small and unsquashed so we can follow how the work evolved. 

- Write `AI_NOTES.md` (one page): 

- time spent per part, and which tools you used for each; 

- two or three moments when the AI got something wrong: what it produced, how you caught it, what you did instead; 

- one thing you chose not to delegate to AI, and why; 

- how you checked that AI-written tests would fail if the feature broke. 

- **COULD** One raw session export or log showing a non-trivial exchange. 

## **What to submit** 

A private repository shared with us, with small unsquashed commits. 

- `README.md` : the one command to run everything; how to start the ingest script; how to run the tests; how 

- to connect an MCP client; what is unfinished and what you would do next. 

- `DESIGN.md` , `MCP_EVAL.md` , `AI_NOTES.md` and your agent instruction files. 

## **How we assess** 

|**Area**|**Weight**|**What we look for**|
|---|---|---|
|Correctness and|30%|v1 behaves as specified; v0 is untouched; pagination holds up while ingest|
|contracts||runs;<br>`days_active`and the impressions sort are right.|
|Agent experience|25%|Tool descriptions, response size, errors a model can act on, and an<br>evaluation that honestly shows what changed.|
|Tests that catch<br>regressions|15%|We will break a few things on purpose and see whether your tests notice.|
|Security and metering|15%|Key handling, scopes, revocation, exact counting under concurrency and<br>retries.|
|Judgment and<br>communication|15%|What you chose to cut, your design notes, your AI notes and commit history.|



We run every submission from a clean clone. If the one command does not work, we will ask you to fix it before we review anything else. 

## **What happens next** 

If your submission moves forward, we schedule a 60-minute call. You walk us through it for 15 minutes; then, with your own AI tools and screen shared, you extend your code with a small change of the kind we make every week. Be ready to explain any line in your repository. 

Use synthetic data only; do not scrape any real ad library. Model usage for the evaluation should cost a few dollars at most. If something in this document is ambiguous, make a reasonable assumption, write it in your README, and keep going. That counts in your favour. 

