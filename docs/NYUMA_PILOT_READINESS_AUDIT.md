# Nyuma pilot readiness and usability audit

Audit date: 3 November 2026.
Scope: the existing browser prototype only. No application behaviour was changed for this audit.
Pilot context: watermelon coordination on the Kitui–Nairobi route, about 20 informal traders, with farmers and buyers. Nyuma is intended to be WhatsApp-first. The current product is a single-browser demonstration.

## 1. Executive summary

The prototype can show a scripted watermelon scenario and can record listings, buyer requirements, agreements, purchases, exposure, and outcomes in the browser that created them. A person who is shown the sample accounts can sign in, and each role sees a different workspace. The decision-support figures for the default watermelon scenario are consistent with the engine: 800 kg, 700 kg matched, 100 kg unallocated, 87.5 percent coverage, and indicative gross sales of KSh 28,000 at the asking price. That figure is not profit.

The product is ready for a controlled prototype demonstration, and for a small facilitated usability test on phones. It is not ready for a real multi-user pilot. It requires further product work before any deployment with about 20 traders.

The blocking reasons are architectural and practical, not a failed test suite:

- Records live in `localStorage` on one browser profile. Twenty traders on twenty phones cannot see one another’s listings, requirements, or purchases. Refreshing the same browser keeps that browser’s records. It does not share them.
- Sign-in is a demonstration catalogue. Passwords are in the client and are printed on the login screen. These accounts must not be issued as real user accounts.
- A trader’s home screen, “Buyer demand”, and “Matches” describe a fixed demonstration scenario. Saved buyer requirements live in a different store and are not what those screens show. Farmer and buyer “Matches” stay empty even when a compatible listing and requirement exist.
- A mistaken purchase or outcome cannot be corrected in the product.
- Several remainder figures are calculated correctly and still easy to misread: still exposed, still unaccounted for, and kilograms with no outcome record.

No double-counting error was found in the surplus or outcome formulas. Dashboard purchase totals count each purchase once, and confirmed totals include only agreements whose status is `confirmed`. The trust risk is that a user can treat a demonstration match as a deal, an agreement as a purchase, unaccounted kilograms as spoilage, or browser records as the whole market.

## 2. Current product capabilities

Nyuma is a Vite and React single-page application. There is no backend, database, service worker, or WhatsApp connection. Routing is by URL hash.

| Capability | What the product actually does |
|---|---|
| Homepage | Marketing page, “Know your market before harvest.” The dashboard is not on this page. |
| Sign-in | Four sample accounts. A wrong password stays on the login screen. Sign-out returns to `#top` and clears the session key only. |
| Farmer | Own listings, all open buyer requirements in this browser, agreements, purchases, exposure, and outcomes. |
| Trader | Decision-support scenario plus own coordination listings, agreements, purchases, exposure, and outcomes. |
| Buyer | Own requirements, all open “available now” listings, agreements, purchases, and sold outcomes linked to those purchases. |
| Administrator | Read-only view of sample accounts and of coordination records in this browser. |
| Listings | Draft, open, close, or withdraw. Expected harvest is not treated as produce ready to collect. Commodity cannot be changed after create. |
| Buyer requirements | Open, close, or withdraw. Publishing a requirement does not create an order. There is no demand draft. |
| Agreements | Created only when someone confirms quantity and price. A match does not create one. Status in the form is `confirmed`. |
| Purchases | Recorded against a confirmed agreement, up to the remaining agreed quantity. A purchase does not change the agreement status or the listing quantity. |
| Exposure | Derived, not stored. Alerts are warnings or notes. They do not contact anyone. |
| Outcomes | Sold, recovered, spoiled, donated, or disposed, recorded explicitly. They do not create purchases or change the listing quantity. |
| Decision support | Trader-only scenario. Default load is watermelon, 800 kg, KSh 40/kg, Kitui, 3 hours. |

Storage keys, kept separate:

- `nyuma.decisionSupport.scenario.v1` — the trader demonstration scenario.
- `nyuma.coordination.v1` — listings, requirements, agreements, purchases, and outcomes.
- `nyuma.session.v1` — the signed-in sample account. The password is not stored.

`matchListingToDemand` in `src/domain/matchListing.ts` can reproduce the engine for one listing and a set of requirements. The interface does not call it. Only `src/domain/matchListing.test.ts` imports it.

## 3. Assessment of the four user journeys

Each journey is judged as a person opening Nyuma for the first time, on a phone, without a coach.

### Farmer

| Step | Can they do it? | What gets in the way |
|---|---|---|
| Sign in | Yes | The login screen says this is a demonstration and lists the password. That is appropriate for a demo and unsafe as real authentication. |
| Understand the dashboard | Partly | Counts are tied to this browser and distinguish open listings, confirmed agreements, and purchases. “Checking this browser” is honest and still unexplained for someone who expects one shared market. |
| Create a listing | Yes | The form is short. Required fields are marked. Expected harvest and available now are separate choices, with plain labels. |
| Distinguish expected harvest from available produce | Yes, on the form and on exposure | Exposure leaves expected harvest out of “still exposed” and says it is not ready for collection. The outcomes page can still show a large “still unaccounted” number for that harvest. A farmer can read that as unsold fruit sitting in the field. |
| Understand buyer requirements | Partly | “Buyer opportunities” lists every open requirement in this browser and says they are not confirmed orders. It does not limit the list to the farmer’s crop or collection window. |
| View commitments | Yes | The navigation says “Commitments”. The page talks about agreements and says an agreement is not a purchase. |
| Understand actual purchases | Yes | Purchases are a separate section. Each purchase is counted once. |
| Record outcomes | Yes | The form asks for listing, what happened, quantity, and date. Notes are optional. The page says a recovered quantity is not proof that loss was avoided. |
| Understand unaccounted quantity | Partly | The number is defined, and the page lists it beside sold, spoiled, purchased-but-not-recorded, and “no outcome record”. Three different remainders on one card is a lot to hold on a market day. |

Unnecessary or confusing pieces: “Matches” never calculates a match. “Messages” and the notification bell open an empty messages page. “Profile” only restates the sample account.

### Trader

This is the primary pilot user. The journey is possible, and it is not quick.

| Step | Can they do it? | What gets in the way |
|---|---|---|
| Sign in | Yes | Same demonstration login. |
| Understand the dashboard | Partly, if they already know it is a scenario | “Welcome back, Winnie” opens on the 800 kg watermelon scenario: 700 kg could be matched, 100 kg unallocated, 87.5 percent, KSh 28,000. A note says the buyers are sample records and a match is not a sale. The same page also has links to saved-listing exposure and outcomes. A trader can still think the 700 kg is today’s agreed trade. |
| Create a produce listing | Yes | “Add produce” is not in the main menu. It is reached from My listings. The form says it does not change the demonstration scenario. That sentence is accurate and easy to miss. |
| Review buyer requirements | No, not the saved ones | The menu item “Buyer demand” (`#buyers`) shows Nairobi Fresh Produce, City Market Traders, and Green Basket Wholesale from the scenario. On the exposure page, “Review buyer requirements” goes to that same scenario page. A watermelon requirement saved by the sample buyer is not that list. |
| Understand potential matches | Only for the scenario | “Matches” (`#allocation`) allocates the scenario load. It does not match the trader’s saved mango listing, or any other saved listing, to saved requirements. |
| Distinguish a match from an agreement | The words are present | Scenario copy says “Possible match, not a sale”. Agreements live under “Transactions”. The overview still leads with the match. On a phone this is the first thing after sign-in. |
| Record a confirmed agreement | Yes, with hunting | “Record an agreement” is not a main menu item. The person needs an open listing and an open requirement, then the agreement form, including the checkbox that the quantity and price were agreed. The form does not create the agreement from the scenario match. |
| Record actual purchases | Yes | The purchase form is tied to a confirmed agreement. Quantity cannot exceed what is left on that agreement. There is no edit or delete if the kilograms were wrong. |
| Identify exposed produce | Yes, for saved available listings | “Exposure” uses saved listings, not the 800 kg scenario. The trader’s mango listing correctly showed 120 kg available, 0 kg purchased, and 120 kg still exposed, with no compatible open requirement. The page title still says the quantity is “not yet purchased”, while the figure also subtracts outcomes that are not linked to a purchase. |
| Understand coordination alerts | Partly | The mango alert says it needs a decision, states the kilograms, and says a possible match is not an agreement. The suggested actions point at the listing, the scenario buyers, and agreements. Nothing is sent to a buyer. |
| Record final outcomes | Yes | The outcomes page is separate from the scenario and says so. It is a long page for a phone: eight summary figures, then a line-by-line account, then the form. |

The trader menu has nine items behind one Menu button: Overview, My listings, Buyer demand, Matches, Transactions, Exposure, Outcomes, Messages, and Analytics. Messages does nothing. Analytics repeats the scenario. Buyer demand and Matches are the scenario. The work of the day — listing, agreement, purchase, exposure, outcome — is split across the other items, and two of the most important actions are not in the menu.

A trader cannot realistically keep this up to date between calls on a market morning. The scenario screen invites tinkering with sample buyers. The coordination screens ask for a second, separate record of the same load.

### Buyer

| Step | Can they do it? | What gets in the way |
|---|---|---|
| Sign in | Yes | Demonstration account only. |
| Publish a requirement | Yes | “Submit a requirement” says it is not a confirmed order. The form is short. |
| Understand that a requirement is not an order | Yes, if they read the note | The overview and opportunities language support this. “Matches” then says “A requirement does not create a match. Matches are not recorded yet.” That second sentence stays true even when an open watermelon listing exists, so the buyer cannot see that the product understood the requirement. |
| View compatible available produce | No | “Available produce” lists every open listing marked available now. It hides expected harvest, which is correct, and it does not filter by crop or collection window. A watermelon buyer also sees the mango listing. The page does not say these listings are compatible. |
| Understand potential matches | No | The matches page is a fixed empty state. Compatibility is not calculated. |
| Confirm an agreement | Yes | Same agreement form as the other roles, on the buyer’s own open requirement. It requires an explicit confirmation. It is not in the main menu. |
| Record an actual purchase | Yes | Against a confirmed agreement only. A purchase is not created by confirming the agreement. |
| View purchase history | Yes | “Purchase history” lists recorded purchases. It is not the outcomes page. |

The four words a buyer must keep apart are easy to collapse:

- Requirement: what the buyer hopes to buy. Not an order.
- Match: in this product, either the trader’s scenario or an empty page. Not an agreement.
- Agreement: a confirmed quantity and price. Not a purchase. The menu calls it a commitment.
- Purchase: kilograms actually bought. Not a full account of what happened to the listing.

### Administrator

An administrator can open Users, Listings, Buyer demand, Matches, Transactions, Exposure, Outcomes, and Activity. There is no save action on outcomes, and agreement screens say the page is view only. Direct links into another role’s editing pages are refused. That part of the journey holds.

The framing does not hold:

- The menu and page title say “Platform overview”.
- Listings, buyer demand, transactions, and activity are described as “recorded on the platform” in `src/lib/access.ts`.
- Exposure and outcomes, on the page itself, say the figures are records in this browser and are not county, national, or platform-wide totals.
- Users are the four built-in sample accounts, not people who have joined Nyuma.
- Matches stays empty. A scenario result is not listed as a platform match, which is correct, and the empty page can look like a broken report.
- Activity does not send alerts. When records exist, it points at transactions.

An administrator who treats this screen as the pilot dashboard will under-count or over-claim. The records are whatever was saved in that browser profile.

## 4. Mobile usability assessment

Checked in the browser at about 360, 390, and 430 pixels wide, with a phone-sized viewport. No forms were submitted. Scenario Save, Reset, and Load saved were not used.

| Width | Pages checked | Horizontal overflow |
|---|---|---|
| 360 px | Homepage, trader overview, trader outcomes, trader exposure | None. `clientWidth` and `scrollWidth` were both 360. |
| 390 px | Homepage, trader add-produce form, open workspace menu | None. Both widths were 390. The menu fitted inside the screen. |
| 430 px | Login, trader add-produce form | None. Both widths were 430. |

What is comfortable:

- At these widths the marketing header and the workspace sidebar collapse behind a Menu button. The menu opens and lists the section names.
- Listing fields stack in one column. Produce, expected versus available, quantity, location, collection window, and optional price are visible without a sideways scroll.
- Body text and the listing quantity field computed at 16 px, so the field is large enough to read. The login email field was also 16 px.
- Expected harvest and available now are full sentences, not codes.
- Primary actions on the listing form say “Save draft” and “Open listing”.

What will be awkward on an ordinary Android phone:

- Menu, Log out, Save draft, and Open listing were about 37 px tall. A thumb target nearer 44 px would be safer on a moving vehicle or in a market.
- The trader overview is a long decision-support page. The controls for the scenario sit in that scroll. It is easy to pass the note that separates the scenario from saved listings.
- The outcomes page leads with eight statistics, then every listing line, then the form. Recording “20 kg spoiled” takes more reading than the event deserves.
- The notification bell is always visible and always means “no new notifications”, because messages are not implemented.
- Leaving a form by opening the menu or another section drops what was typed. Nothing warns the person.

The main coordination workflows can be completed on a phone. They are not comfortable enough for a trader who is also on a call, in a vehicle, or between market stalls.

## 5. WhatsApp-first strategy assessment

The current product is a web dashboard with a login. WhatsApp is not implemented, and this audit does not add it. Nothing in the interface captures a chat, a voice note, or a shared phone.

What should happen in WhatsApp once a shared record exists:

- A trader or farmer states today’s load once: crop, place, kilograms, whether it is ready now or still expected, asking price if they have one, and how long it can wait.
- A buyer states a requirement once: crop, kilograms, place, when they can collect, and the price they have in mind.
- A short reply can show compatible open supply or demand, labelled as a suggestion. That reply must not create an agreement.
- An agreement is an explicit confirmation of quantity and price, not a detected keyword and not a match.
- A purchase is a later message for what was actually taken.
- End of day, only if something is still unresolved: kilograms left, spoiled, donated, disposed, or sold outside Nyuma.

What still needs the dashboard, or a facilitator sitting with the user:

- Correcting a wrong purchase or outcome.
- Reading the full account of one listing when the chat history is messy.
- The administrator’s review during a pilot.
- The demonstration scenario, if it is kept as training. It should not be the screen a trader lands on during a live market day.

What is too burdensome to ask on every load:

- Re-entering the same watermelon load in a scenario form and again as a listing.
- Choosing among nine menu items to record one collection.
- Filling notes, collection windows, and prices when the person has not set them.
- Recording an outcome for every kilogram on the same day as the sale. Purchases already account for collected kilograms. An outcome is for what the purchase did not cover, or for an explicit sold, spoiled, donated, or disposed record.

On a Kitui–Nairobi watermelon day, the few facts that matter are: how many kilograms are actually on the vehicle or at the farm, whether they must move today, the asking price, which buyer agreed, how many kilograms that buyer took, and what is still on the ground at the end of the run. Location names matter as words the traders already use. They are not a transport-cost calculation. The engine already records location and does not price transport. A future workflow should keep that limit visible.

A realistic later workflow, not built here:

1. The trader sends one message, or a facilitator types it from a call: “Watermelon, Kitui, 800 kg ready now, KSh 40, collect within 3 hours.”
2. Nyuma stores one listing. It does not also create an 800 kg scenario.
3. Open buyer requirements for watermelon that can collect in that window are listed as suggestions. Names are shown only where the buyer has agreed to be contacted.
4. The trader and buyer confirm in words: “Agreed 200 kg at KSh 40, collect tomorrow.” Both sides, or a facilitator speaking to both, confirm. The product stores a `confirmed` agreement and nothing else.
5. After collection: “Took 80 kg at KSh 40.” That is one purchase. The agreement stays open until the remaining kilograms are bought or the agreement is cancelled. The product does not mark it fulfilled by guessing.
6. If fruit is left: “100 kg still here” or “20 kg spoiled”. That is the outcome. Unaccounted kilograms are not called spoiled.

Limits that have to be designed before this is real:

- WhatsApp automation cannot reliably hear a busy market call, a voice note in Sheng or Kamba, or a message that mixes two crops. A person must be able to correct the captured line.
- Storing chat content needs consent, a stated purpose, and a way to stop. A pilot facilitator reading a trader’s phone is not a substitute for that.
- Suggestion messages will be wrong when quantities are stale. The product should prefer a short “reply 1 if this load is still 800 kg” over a silent assumption.
- None of this works on `localStorage`. The message, the listing, and the buyer’s phone have to meet in a shared backend. Until then, WhatsApp and the dashboard are two private notebooks.

## 6. Data accuracy and trustworthiness

The formulas were read in `src/lib/surplus.ts`, `src/lib/outcomeAccounting.ts`, `src/lib/coordinationActivity.ts`, and `src/lib/decisionEngine.ts`, and compared with their tests. This audit did not change them.

### Figures that match their rules

- Expected harvest is `quantityKind: expected`. Exposure sets `exposedKg` to null. The card is “Upcoming supply — not ready for collection.” Closed, withdrawn, and draft listings are omitted.
- Available open exposure is listed kilograms, minus purchases on that listing counted once, minus outcomes that are not linked to a purchase. A confirmed agreement is not subtracted again. A sold outcome that points at a purchase is not subtracted again.
- Hold rule: a proposed or confirmed agreement holds its agreed quantity. A fulfilled agreement holds only what was purchased. A cancelled agreement holds nothing. Recording a purchase does not itself change the agreement status.
- Unaccounted kilograms are the listing quantity minus every outcome and minus purchase kilograms that no sold outcome already covers.
- “No outcome record” is the listing quantity minus outcome quantities only. A purchase can sit inside that number and still be counted in “accounted”.
- Buyer demand remaining is the requested quantity minus the hold. Confirmed dashboard totals ignore proposed, fulfilled, and cancelled agreements. Purchase totals add each purchase once.
- The default scenario, confirmed again on the trader overview during this audit: watermelon, Kitui, 800 kg, KSh 40/kg, 3 hours, surplus, all three sample buyers included. The page showed 700 kg matched, 100 kg unallocated, and 87.5 percent. Indicative gross sales use the asking price, so 700 × 40 = KSh 28,000. The page says this is not profit and excludes transport, commissions, and market fees. The allocated average at buyer prices is KSh 39.71/kg, KSh 0.29/kg below the asking price. The allocation total is KSh 27,800. Legend shares rounded independently can add to 100.1 percent. That is rounding, not a second calculation.
- Worked exposure example from `src/lib/surplus.test.ts`: a 200 kg available listing, an 80 kg purchase, a sold outcome of 80 kg linked to that purchase, and 20 kg spoiled. Exposed is 100 kg. The 80 kg is not removed twice.
- Worked fulfilled example from the same tests: 100 kg listed, a fulfilled agreement of 100 kg, and a 60 kg purchase. Held is 60, purchased is 60, uncommitted is 40, exposed is 40.

### An inspected coordination example

In the browser used for this audit, saved coordination records included a farmer watermelon listing of 750 kg marked as expected harvest, a confirmed agreement of 200 kg, a cancelled agreement of 20 kg, and purchases of 80 kg and 40 kg. No outcomes were saved. The cancelled 20 kg does not hold quantity. Purchased kilograms are 120. Unaccounted kilograms are 630. Kilograms with no outcome record are 750, because a purchase is not an outcome. Exposed kilograms are not shown as ready surplus, because the listing is an expected harvest. The trader’s separate mango listing of 120 kg, available now in Nairobi, showed 120 kg still exposed and no compatible open watermelon requirement. That produce mismatch is correct.

A farmer reading “630 kg still unaccounted for” on an expected harvest can think the fruit is already unsold and ready, or already spoiled. The page also says the harvest is not ready for collection. The two sentences have to be read together. On a phone, the large number will win.

### Where a user can mistake one figure for another

| Mistake | Where it happens | Is the maths wrong? |
|---|---|---|
| Match treated as an agreement | Trader overview and Matches. The warning text is there. The match is the first result. | No. The stores are separate on purpose. The presentation still leads with the match. |
| Agreement treated as a purchase | Commitments versus the purchase form. Copy distinguishes them. A fully purchased agreement stays `confirmed` because the interface never sets `fulfilled`. | No. The status label stays “confirmed” after the kilograms are bought, which feels like the purchase did not count. |
| Purchase treated as the full outcome | Outcomes say a purchase is not copied unless the user records a sold outcome. “No outcome record” still includes those purchased kilograms. | No. The two lines are both true and easy to combine into “nothing has been recorded”. |
| Expected harvest treated as available produce | The listing form and exposure cards separate them. Unaccounted kilograms do not. | No. |
| Unaccounted treated as spoiled | Unaccounted is a gap in the account, not a spoilage record. Spoiled has its own total. | No. |
| Recovered treated as proof of loss reduction | The outcomes page refuses that claim in a paragraph above the figures. The homepage still says “Reduce waste” and “Turn more of the harvest into a sale.” | The outcome rule is intact. The marketing line is stronger than the evidence. |

### Wording that is wider than the current formula

`src/lib/access.ts` describes farmer and trader exposure as quantity “not yet purchased”. `src/components/coordination/SurplusDesk.tsx` captions “Still exposed” as “Not purchased, and not recorded under another outcome.” With no such outcomes the numbers match. After a spoiled or external-sale outcome, the page description is the older sentence. `src/lib/workspaceContent.ts` still contains unused sentences that say adding a listing or a requirement “comes in a later step”. The forms exist. Those unused strings are not on the live pages. The farmer matches empty state in `FarmerWorkspace.tsx` is more careful than the unused `EMPTY.farmerMatches` text.

Dashboard cards for confirmed kilograms and purchased kilograms use the same helpers as the detail pages. They do not display exposed or unaccounted kilograms, so they cannot drift from those pages. They also cannot answer “what is left?”. The trader overview’s 800 / 700 / 100 answers a different question, about the scenario, and sits above the saved-record cards.

### Calculation defects

None found in the implemented formulas. One boundary is worth recording so it is not mistaken for a UI bug later: `src/domain/relationships.ts` caps outcomes on a listing, and caps a sold outcome linked to one purchase, but the overlap between an uncovered purchase and a non-linked outcome is enforced in `outcomeBlock` in `src/lib/outcomeAccounting.ts` before the workflow saves. A direct repository call can still overlap. The screens go through the workflow.

## 7. Technical and architectural limitations

- One browser profile, one coordination document. A second phone, a second browser, or a cleared site data store has a different set of records. There is no account sync.
- There is no service worker and no offline mode. The first load needs the network. After the script is loaded, writes go to `localStorage`. A refresh reloads those keys if the browser still has them. Navigating away from a form discards unsaved React state. Sign-out does not delete coordination records or the scenario. The session does not expire on a timer. If `localStorage` throws, the in-memory change is rolled back and the user is told the browser blocked storage. That path was not re-triggered in this audit. It is implemented in the repository client and covered by tests.
- Authentication compares the password to `src/lib/sampleUsers.ts` in the browser. The login card prints every sample email and password. A session that does not match the catalogue is rejected. That is a gate for the demonstration, not a security boundary. Anyone using that browser can read `nyuma.coordination.v1`, including outcome notes, from developer tools.
- Role checks in the interface and in the workflow stop the sample farmer, buyer, and administrator from using one another’s actions. They do not protect data on a shared computer. The administrator is read-only in the workflow. The JSON is still on the device.
- Purchases and outcomes cannot be edited or deleted. A wrong number stands. An agreement with a purchase cannot be cancelled. There is no control that marks an agreement fulfilled.
- Farmer opportunities and buyer available produce are not limited to compatible crop and window. The compatibility rule exists in `agreementBlock` and is used for exposure alerts and for creating an agreement. It is not used to build the lists people browse.
- The homepage offers Farmers, Traders, Processors, and Value addition. There is no processor workspace.
- “Watch how it works” goes to a page, not a video.
- Tests render static markup. They do not run a phone browser. This audit’s width checks are separate from the test suite.

## 8. Pilot-readiness decision

**Ready for a controlled prototype demonstration.**
**Ready for facilitated usability testing with 3–5 people, on phones, using the sample accounts, with a facilitator who knows the scenario and the saved records are different.**
**Not ready for a real multi-user pilot deployment with about 20 traders.**
**Requires further product work before that deployment.**

`localStorage` is specific to the browser profile that wrote it. It cannot support a shared pilot. Do not deploy the current demonstration accounts as real user accounts.

| Area | Assessment |
|---|---|
| Usability | A coached person can finish the core records. An uncoached trader will mix the scenario with saved demand, and will not find a match for a saved listing. |
| Data integrity | The formulas tested here are consistent. Mistakes cannot be corrected. Two stores can be quoted as if they were one market. |
| Multi-user access | Not available. Each phone would have a private notebook. |
| Authentication | Demonstration only. Passwords are public in the interface. |
| Privacy | Role screens hide other people’s outcome notes from buyers. The storage file on the device does not. There is no consent flow and no shared access policy. |
| Connectivity | Refresh keeps local data. There is no designed offline mode and no shared copy if the phone is lost or the site data is cleared. |
| WhatsApp | Not started. The operating model in section 5 is feasible only after shared records, consent, and a correction step. |
| Support | A user can fix a listing’s quantity and can cancel an agreement that has no purchase. They cannot undo a purchase or an outcome. Unsaved forms disappear on navigation. |
| Reporting | A facilitator can read one browser’s records. Those records are not pilot results for 20 traders. The scenario’s 87.5 percent must not be reported as a field result. Recovered kilograms must not be reported as loss reduction. |

## 9. Prioritized improvement backlog

Each item states the problem, why it matters, who it affects, where it lives, what to change, the priority, and when it is required. Nothing in this list was implemented.

### P0 — Critical before any real deployment

**P0-1. Records are trapped in one browser.**
Problem: coordination data is `nyuma.coordination.v1` in `localStorage`, via `src/lib/coordinationClient.ts` and `src/domain/coordinationDocument.ts`.
Why it matters: traders on the Kitui–Nairobi route cannot see the same listing or the same purchase.
Affected role: all four.
Proposed solution: a shared store with one listing per load, before any live pilot. Do not pretend a shared phone or a shared browser profile is the pilot.
Priority: P0.
Required before real deployment. Not required before a usability test that is explicit about one device.

**P0-2. Sign-in is a public demonstration catalogue.**
Problem: `src/lib/sampleUsers.ts` and `src/components/LoginScreen.tsx` hold and display the four passwords. `src/lib/auth.ts` checks them in the browser.
Why it matters: these accounts are not private, not revocable, and not one person. Using them with real traders would mix demonstration data with personal trade.
Affected role: all four.
Proposed solution: real accounts, with secrets kept off the page, before any real user. Keep the sample accounts only for demos and tests.
Priority: P0.
Required before real deployment. The usability test should keep using the sample accounts and should not collect real credentials.

**P0-3. Privacy is only a screen rule.**
Problem: workflow checks in `src/lib/coordinationWorkflow.ts` and `src/lib/access.ts` hide actions. The coordination JSON, including outcome notes, is readable by anyone who can open that browser profile.
Why it matters: notes can name a buyer, a loss, or a price the trader would not say in public. On a shared phone that is a disclosure.
Affected role: farmer, trader, and anyone else using the device. Buyers are protected only inside the buyer screen.
Proposed solution: server-side access control when the shared store exists. Until then, do not put real personal or commercial notes into the prototype.
Priority: P0.
Required before real deployment. For usability testing, use fictional loads only.

### P1 — High, and the reason an uncoached trader cannot rely on the product

**P1-1. The trader home, Buyer demand, and Matches are a different product from saved records.**
Problem: `src/components/workspaces/TraderWorkspace.tsx` evaluates the scenario. `src/lib/access.ts` sends “Buyer demand” to `#buyers` and “Matches” to `#allocation`. Exposure’s “Review buyer requirements” also goes to `#buyers`. Saved requirements are elsewhere.
Why it matters: a trader looking for today’s Nairobi buyer will see three sample buyers and a 700 kg match that was not agreed.
Affected role: trader. The confusion spreads to anyone the trader quotes.
Proposed solution: land the trader on saved listings and today’s agreements. Move the 800 kg scenario behind a clearly named practice page. Point “buyer requirements” at saved requirements only.
Priority: P1.
Required before usability testing if the success criterion is completing the journey unaided. If the first test’s purpose is to measure this confusion, run the test on the current build and fix it before a second round and before any deployment.

**P1-2. Farmer, buyer, and administrator Matches never calculate a match.**
Problem: `FarmerWorkspace.tsx` and `BuyerWorkspace.tsx` render empty states. `matchListingToDemand` is unused by the interface. Administrator matches stay empty on purpose for the scenario, and also ignore saved compatibility.
Why it matters: after a farmer lists watermelon and a buyer publishes a watermelon requirement, both Matches pages still say nothing was found.
Affected role: farmer, buyer, administrator.
Proposed solution: show the existing produce and collection-window check as “possible”, with the sentence that it is not an agreement. Do not auto-create agreements. Do not change the engine.
Priority: P1.
Same timing as P1-1.

**P1-3. Browse lists are not the compatible set.**
Problem: buyer “Available produce” shows every available-now listing. Farmer “Buyer opportunities” shows every open requirement. `agreementBlock` in `src/lib/coordinationActivity.ts` is not applied to those lists.
Why it matters: a watermelon buyer sees mango. A farmer sees demand they cannot supply. They can think Nyuma is proposing a deal.
Affected role: buyer and farmer.
Proposed solution: group “fits your crop and collection window” separately from “other open records”, or hide the others. Keep location as a label, not a transport filter, matching the engine.
Priority: P1.
Required before real deployment. Worth fixing before usability testing of the buyer and farmer browse tasks.

**P1-4. A wrong purchase or outcome cannot be corrected.**
Problem: `AgreementDesk` and `OutcomeDesk` create records. The repository has no purchase or outcome update or delete in the UI. Agreements cannot be cancelled after a purchase. The UI never sets `fulfilled`.
Why it matters: one mistyped kilogram becomes the exposed quantity and the unaccounted quantity. Traders will mistype.
Affected role: farmer, trader, buyer.
Proposed solution: allow the person who recorded the line to correct or void it, with the old value kept visible. Do not silently rewrite history. Add a visible way to mark an agreement fulfilled only when that status is what the hold rule should use.
Priority: P1.
Required before real deployment. Not required before the first usability test. Include one task that asks what they would do after a wrong number, and record that they cannot fix it.

**P1-5. Remainder language can be quoted as spoilage or as ready surplus.**
Problem: exposed, unaccounted, and no-outcome-record are different, as implemented in `src/lib/surplus.ts` and `src/lib/outcomeAccounting.ts`. Exposure descriptions in `src/lib/access.ts` still say “not yet purchased”.
Why it matters: a pilot report could treat 630 kg unaccounted on an expected harvest as waste avoided or as waste already incurred.
Affected role: farmer, trader, administrator, and anyone writing up the pilot.
Proposed solution: one plain sentence beside each number. For expected harvest, say the unaccounted figure is not fruit ready to collect and not spoilage. Align the exposure page description with the caption that already mentions other outcomes. Do not change the arithmetic.
Priority: P1.
Required before usability testing of exposure and outcome tasks, and before any pilot write-up.

**P1-6. The product implies messages, notifications, and a platform.**
Problem: the bell in `src/components/WorkspaceShell.tsx` opens Messages. Messages say messaging is not in this version. Administrator titles in `src/lib/access.ts` say “Platform overview” and “recorded on the platform”. `src/components/Hero.tsx` says “Reduce waste”.
Why it matters: users wait for a notification that will not come, and an administrator exports “platform” totals from one browser.
Affected role: all four, and the homepage visitor.
Proposed solution: remove or rename the bell and Messages until a message exists. Rename the administrator home to “Records in this browser”. Soften the homepage line so it does not claim loss reduction.
Priority: P1 for the administrator wording before any facilitated demo that includes an administrator. P2 is enough for the homepage if the demo does not start there. Messages should be fixed before usability testing so participants do not spend time in an empty inbox.

### P2 — Medium, clarity and phone comfort

**P2-1. Commitment, agreement, match, and allocation are four names for overlapping ideas.**
Problem: the menu says Commitments. The form says agreement. The scenario says match and allocation.
Why it matters: the buyer journey already depends on keeping these apart.
Affected role: all trading roles.
Files: `src/lib/access.ts`, `src/components/coordination/AgreementDesk.tsx`, trader scenario copy.
Proposed solution: pick “agreement” in the menu, and reserve “match” for a suggestion.
Priority: P2.
Before real deployment. Helpful before the second usability round.

**P2-2. Phone targets and the outcomes summary are tight.**
Problem: form buttons measured about 37 px tall. The outcomes page opens with eight statistics.
Affected role: trader and farmer, on Android.
Files: `src/index.css`, `src/components/coordination/OutcomeDesk.tsx`.
Proposed solution: larger primary buttons, and a short outcomes summary with the form first.
Priority: P2.
Before the pilot. The first usability test can measure the pain on the current layout.

**P2-3. “Watch how it works” is not a demonstration, and Processors are not a role.**
Problem: `Hero.tsx` and the homepage sections promise a walkthrough and a processor path.
Affected role: first-time visitor.
Proposed solution: rename the link to the page it opens, and drop processor claims until that role exists.
Priority: P2.
Before a public demo. Not a trader-task blocker.

**P2-4. Quantity help mentions three decimal places.**
Problem: the listing form says “up to 3 decimal places”.
Affected role: farmer and trader.
Proposed solution: “Kilograms. You can use decimals, for example 12.5.”
Priority: P2.
Before usability testing if farmers struggle with the field. Otherwise before deployment.

### P3 — Later

**P3-1. WhatsApp capture.** After P0 shared records and consent. Not a dashboard feature bolted on first.

**P3-2. Payments, escrow, or M-Pesa.** Out of scope for the first coordination pilot.

**P3-3. A post-harvest-loss percentage or greenhouse-gas figure.** The outcome page correctly refuses this. Do not add it until there is an agreed method and shared evidence.

**P3-4. Automatic spoilage prediction, transport pricing, or a trained forecast.** The engine is a deterministic allocation of the quantities the user entered. Leave it that way until the pilot has real shared records worth modelling.

## 10. Practical usability-testing plan

Run this on the current prototype before building the backlog, except where section 9 says a wording fix should land first. Use 4 people if possible, and not more than 5:

- Two traders who move produce, ideally someone who has traded watermelon or a similar bulky crop toward Nairobi.
- One small-scale farmer.
- One buyer, if a buyer is available. If not, a fourth session can be a trader, and the buyer tasks wait.

Test on their own Android phone or on one test phone at a normal market-stall distance. Do not start on a laptop. Do not contact traders from any real customer list. Do not use real names, phone numbers, or real stock positions. The scenarios below are fictional. Participants sign in only with the sample accounts already printed in the prototype.

Facilitator rules: read the task once. Do not point at the menu. Do not explain the scenario versus saved records unless the person has stopped and asked to quit the task. If they ask “is this right?”, say “what would you do if I were not here?”. Stop a task after about 5 minutes or when they say they are finished or stuck.

For each task record: start and end time, whether they finished, the screen they were on, any mis-tap, any number they read aloud, and the exact words they used when they hesitated. After each task ask only:

- What do you think you just did?
- What does the main number on this screen mean?
- What would you do next, if this were a real market day?
- Was there anything you wanted to do and could not find?

Do not ask “was the match confusing?” or “did you like it?”.

### Tasks

**Trader A, sample trader account.** You are leaving Kitui with watermelon that must be sold today.

1. Sign in.
2. You have 800 kg ready now, asking KSh 40 per kg, and it needs to move within about 3 hours. Show where you would record that load. Do not submit unless you are sure this is the real listing, and say out loud whether you are looking at a practice example or your own listing.
3. A buyer in Nairobi wants watermelon today. Find that buyer’s requirement.
4. Point at anything that looks like a deal. Say whether it is already agreed.
5. You and the buyer have agreed 200 kg at KSh 40, collection tomorrow. Record that agreement. If you cannot, say what is missing.
6. The buyer actually took 80 kg at KSh 40. Record the purchase.
7. You still have fruit that nobody has taken. Find the screen that tells you how much is exposed.
8. You typed 800 kg and meant 80 kg on a purchase. Show how you would fix it.

**Trader B, same account on a second pass or a cleared practice script.** Same tasks 1, 6, 7, and 8 only, timed, after watching Trader A once. This checks whether the path is learnable. Keep their notes separate.

**Farmer, sample farmer account.** You expect 750 kg of watermelon from Kitui. It is not ready to load today.

1. Sign in and say, in one sentence, what this first screen is for.
2. Record the 750 kg as an expected harvest, not as produce ready to collect.
3. Open buyer requirements. Say whether any of them is an order.
4. Open Matches. Say what you expected to see.
5. Open the account of what happened to the 750 kg. Explain the difference between purchased, spoiled, and still unaccounted. There may already be sample purchases on this browser. Ask them to interpret the numbers that are actually on screen. Do not tell them the expected answer.

**Buyer, sample buyer account.** You buy watermelon for a Nairobi stall.

1. Sign in.
2. Publish a requirement for 300 kg of watermelon, Nairobi, today, KSh 42 per kg. Say whether you have just placed an order.
3. Open available produce. Say which loads you could actually buy, and which you would ignore.
4. Open Matches. Say whether Nyuma has found you supply.
5. If an agreement already exists, record that you collected part of it. Then open purchase history and say what is listed.

**Administrator, only if a facilitator or project staff member is the fifth person.** Do not use a trader’s time for this.

1. Open the overview and say whose records these are.
2. Find listings, requirements, agreements, purchases, and outcomes.
3. Try to change a quantity. The expected result is that they cannot.
4. Say whether these numbers could be reported as “all Nyuma users”.

### What to do with the notes

Count finished tasks, time, and the number of times someone treated a match as an agreement, a requirement as an order, or unaccounted kilograms as spoilage. Keep quotes. Do not average satisfaction scores. A task that fails because of P1-1 or P1-2 is a product finding, not a failed participant.

## 11. Recommended next implementation milestone

**Next milestone: make one trader path, and label every number.**

Do this before a shared backend, and before any WhatsApp work.

- The trader’s first screen should be today’s saved listings, agreements, and exposed kilograms.
- The 800 kg watermelon scenario should stay available as a practice page, with its own name, and should not be “Buyer demand” or “Matches”.
- Farmer and buyer Matches should use the existing compatibility check and should say the result is not an agreement.
- Browse lists should separate compatible produce from other open records.
- Exposure and outcome pages should explain exposed, unaccounted, and no-outcome-record in one sentence each, without changing the formulas.
- Messages and the notification bell should come out until messaging exists.
- The administrator home should say “this browser”.

The milestone after that, and the one required before a 20-trader pilot, is shared records and real sign-in, with a way to correct a mistaken purchase. WhatsApp capture belongs after those two, using the short market-day script in section 5.

## 12. Prototype readiness and real deployment readiness

| Question | Prototype | Real deployment |
|---|---|---|
| Can a facilitator walk one person through a watermelon example on one phone? | Yes. | Not the deployment. |
| Can 20 traders share listings and purchases? | No. | Required, and absent. |
| Are the sample logins safe for real people? | Only as a labelled demo. | No. Do not issue them. |
| Can pilot impact be measured from these screens? | Only as usability notes and as a check that the formulas are understood. | No. Scenario percentages and one browser’s JSON are not field results. |
| Does the product reduce food loss? | It does not claim that in the outcome records. The homepage line is ahead of the evidence. | Do not report loss reduction from listings, matches, agreements, or purchases. |

The prototype is fit to learn from. It is not fit to run the Kitui–Nairobi pilot.
