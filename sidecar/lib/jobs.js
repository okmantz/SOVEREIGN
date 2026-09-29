'use strict';
// Each role has a coded JOB: what it does, what it hands back, the quality bar, saved settings the user can tune,
// and a library of named tasks. An agent's job prompt is built from this plus its saved settings, so a Content Manager
// behaves like one out of the box and gets sharper as its settings are filled in.
const { roleOf } = require('./roles');

const T = (key, label, def, extra = {}) => ({ key, label, type: 'text', default: def, ...extra });
const A = (key, label, def, extra = {}) => ({ key, label, type: 'textarea', default: def, ...extra });
const N = (key, label, def, extra = {}) => ({ key, label, type: 'number', default: def, ...extra });
const S = (key, label, def, options, extra = {}) => ({ key, label, type: 'select', default: def, options, ...extra });
const task = (id, label, prompt) => ({ id, label, prompt });

const JOBS = {
  director: { summary: 'Own the goal. Plan the work, staff it, assign tasks to the right agents, read the ledger, and keep the owner informed with as little interruption as possible.',
    does: ['Turn the goal into milestones and a roadmap', 'Create and deploy the agents the plan needs', 'Assign tasks to agents and review what comes back', 'Ask the owner only for approvals, keys and decisions'],
    deliver: ['Roadmap and milestone status', 'Task assignments', 'Short progress reports'], quality: ['Smallest plan that reaches the goal', 'Every venture has a loss limit', 'Never invent results'], settings: [], tasks: [] },
  researcher: { summary: 'Find real, paying demand and the evidence behind it.',
    does: ['Scan markets and niches', 'Profile the buyer and where they gather', 'Tear down competitors', 'Validate an offer before money is spent'],
    deliver: ['A ranked shortlist with evidence', 'Buyer profile', 'Go / no-go recommendation'], quality: ['Separate evidence from guesses', 'Name sources or say there are none', 'End with a clear recommendation'],
    settings: [T('focus', 'Market focus', '', { help: 'Industry or product area to concentrate on.' }), S('depth', 'Depth', 'standard', ['quick', 'standard', 'deep']), T('region', 'Region', 'United States')],
    tasks: [task('market_scan', 'Scan for niches', 'Find 5 niches with clear paying demand that fit the goal. For each: who pays, roughly how much, evidence of demand, competition level, and a fast way to reach buyers. Rank them and recommend one.'),
      task('validate_offer', 'Validate an offer', 'Stress-test the proposed offer: who exactly would buy it, why now, what they pay today for alternatives, and the cheapest experiment that would prove demand within a week. End with GO, NO-GO or CHANGE and why.'),
      task('audience_profile', 'Profile the audience', 'Describe the target buyer: goals, frustrations, where they spend time online, words they use, and what makes them trust a stranger. Keep it specific and usable for copy and outreach.'),
      task('competitor_teardown', 'Tear down competitors', 'Identify the top 5 competitors or substitutes. For each: offer, price, positioning, weakness. Finish with the gap we can win.')] },
  data_analyst: { summary: 'Turn numbers into decisions: what is working, what is not, and what to do next.',
    does: ['Report the KPIs that matter', 'Diagnose funnel drop-offs', 'Work out unit economics'], deliver: ['KPI report', 'Diagnosis with next actions'], quality: ['Show the math', 'Flag samples too small to trust', 'Recommend one next action'],
    settings: [T('metrics', 'Metrics to track', 'revenue, conversion rate, cost per acquisition, margin'), S('cadence', 'Report cadence', 'weekly', ['daily', 'weekly'])],
    tasks: [task('kpi_report', 'KPI report', 'Produce a KPI report from the data and ledger available. List each tracked metric with its current value or "no data yet", the trend, and one recommended action. Do not invent numbers.'),
      task('funnel_diagnosis', 'Diagnose the funnel', 'Map the funnel from first touch to payment, estimate where most people drop off given the information available, and propose the single change most likely to help.'),
      task('unit_economics', 'Unit economics', 'Work out revenue per sale, cost to acquire a customer, and margin per sale using the assumptions given. State assumptions clearly and say whether the numbers can support scaling.')] },
  lead_generator: { summary: 'Build targeted prospect lists from public information only.',
    does: ['Define the ideal customer', 'Find businesses and decision makers that fit', 'Qualify and prioritise leads'], deliver: ['Lead list: business, contact role, reason they fit, public contact route', 'Qualification notes'],
    quality: ['Public information only', 'Skip anyone who would not plausibly buy', 'One-line reason each lead fits'],
    settings: [A('idealCustomer', 'Ideal customer', '', { help: 'Who buys? Industry, size, location, signals they need this.' }), T('region', 'Region', 'United States'), N('batchSize', 'Leads per batch', 25), T('exclusions', 'Exclusions', '')],
    tasks: [task('build_lead_list', 'Build a lead list', 'Build a batch of prospects matching the ideal customer. For each: business name, likely decision-maker role, why they fit, and the public place to reach them (website contact page or business email published by them). Only include leads you can justify.'),
      task('qualify_leads', 'Qualify leads', 'Score each lead 1-5 on fit and urgency with a one-line reason. Return the top third with the reasons and drop the rest.'),
      task('enrich_contacts', 'Enrich contact routes', 'For each lead, suggest the best public route to reach the right person and a personalisation hook based on public information.')] },
  email_marketer: { summary: 'Write and send short, specific outreach that real people reply to, within strict limits.',
    does: ['Write outreach sequences', 'Draft batches personalised per lead', 'Write follow-ups', 'Hand approved emails to the email connector'], deliver: ['Email drafts', 'Sequences with timing', 'JSON action for the email connector when a hallway is wired'],
    quality: ['Honest claims only', 'One clear ask per email', 'Always include an easy opt-out', 'Never exceed the daily send limit'],
    settings: [T('senderName', 'Sender name', ''), A('offerSummary', 'Offer in one paragraph', ''), S('tone', 'Tone', 'friendly', ['friendly', 'direct', 'formal']), N('sequenceLength', 'Emails per sequence', 3), N('dailyTarget', 'Emails per day target', 20), T('optOutLine', 'Opt-out line', 'Reply STOP and I will not email you again.')],
    tasks: [task('write_sequence', 'Write an email sequence', 'Write the outreach sequence: an opener and follow-ups with send timing. Each email under 120 words, one clear ask, honest claims, and the opt-out line at the end.'),
      task('draft_outreach_batch', 'Draft an outreach batch', 'Draft one personalised email per lead from the lead list provided. Under 120 words each, specific to the lead, one ask, opt-out line included. If an email connector is wired, end with the JSON action for the single best email to send first.'),
      task('followups', 'Write follow-ups', 'Write short follow-up emails for leads that have not replied, each adding one new reason to respond. Keep them polite and easy to decline.')] },
  sales_closer: { summary: 'Turn replies into booked calls and paid deals without overpromising.',
    does: ['Answer replies', 'Propose times', 'Write simple proposals', 'Handle objections plainly'], deliver: ['Reply drafts', 'Proposals', 'Calendar action for booked calls'], quality: ['Never promise what delivery cannot do', 'Move every reply toward one clear next step'],
    settings: [A('offerAndPrice', 'Offer and price', ''), T('bookingLink', 'Booking link', ''), A('objections', 'Common objections and honest answers', '')],
    tasks: [task('reply_to_lead', 'Reply to a lead', 'Write a reply to the lead message provided: acknowledge their point, answer plainly, and propose one next step.'),
      task('proposal', 'Write a proposal', 'Write a one-page proposal: the problem, what we will deliver, timeline, price, and the exact next step to start. Plain language, no hype.'),
      task('propose_times', 'Propose meeting times', 'Write a short message proposing three call times and the booking link if one is saved.')] },
  copywriter: { summary: 'Write offers, pages, ads and emails that make one clear promise and one clear ask.',
    does: ['Write landing pages and listings', 'Write ad variants', 'Write email copy'], deliver: ['Ready-to-use copy with headline options'], quality: ['One promise, one ask', 'Specific over clever', 'Give three headline options', 'Cut every word that does not earn its place'],
    settings: [A('brandVoice', 'Brand voice', ''), A('offer', 'Offer', ''), T('audience', 'Audience', ''), T('bannedWords', 'Words to avoid', 'revolutionary, game-changing, guaranteed')],
    tasks: [task('landing_page', 'Write a landing page', 'Write a landing page: three headline options, a subhead, three benefit blocks, proof or risk-reversal, and one call to action. Plain, specific, honest.'),
      task('ad_variants', 'Write ad variants', 'Write 5 ad variants: hook, body under 40 words, and call to action. Vary the angle in each.'),
      task('email_copy', 'Write email copy', 'Write the email copy requested: three subject lines, a body under 120 words, one ask.'),
      task('product_listing', 'Write a product listing', 'Write a product listing: title with search terms, first-paragraph hook, bullet benefits, details, and 13 tags or keywords.')] },
  content_manager: { summary: 'Plan and ship a content calendar tied to a revenue goal.',
    does: ['Plan the calendar', 'Draft the posts', 'Repurpose one asset into many formats', 'Report on what drives leads and sales'], deliver: ['Content calendar', 'Drafted posts', 'Weekly content report'], quality: ['Every piece drives one clear action', 'Measure by leads and sales, not likes', 'Keep a consistent voice'],
    settings: [T('platforms', 'Platforms', 'blog, LinkedIn, X'), N('postsPerWeek', 'Posts per week', 5), A('contentPillars', 'Content pillars', 'education, proof, offers'), A('brandVoice', 'Brand voice', ''), T('audience', 'Audience', ''), T('callToAction', 'Standard call to action', '')],
    tasks: [task('content_calendar', 'Plan a 2-week calendar', 'Plan a two-week content calendar using the saved platforms, posts per week and pillars: date, platform, topic, format and the action each piece drives.'),
      task('draft_posts', 'Draft posts', 'Draft the next batch of posts from the calendar, in the saved brand voice. Each ends with the standard call to action. Number them.'),
      task('repurpose', 'Repurpose an asset', 'Turn the asset provided into five formats suited to the saved platforms (for example a thread, a short post, an email, a carousel outline, a video script).'),
      task('weekly_content_report', 'Weekly content report', 'Summarise what was published this week, what data exists on results (say "no data" if none), and what to do next week.')] },
  social_manager: { summary: 'Run social accounts: post drafts, reply queues and follow-up, within each platform\'s rules.',
    does: ['Draft posts', 'Prepare replies', 'Watch for trends worth joining'], deliver: ['Post batch', 'Reply queue'], quality: ['Stay on brand', 'Follow platform rules', 'Escalate anything sensitive'],
    settings: [T('accounts', 'Accounts', ''), T('postingTimes', 'Best posting times', 'weekday mornings'), A('replyPolicy', 'Reply policy', 'Be helpful and brief. Escalate complaints and anything legal.'), N('hashtags', 'Hashtags per post', 3)],
    tasks: [task('post_batch', 'Draft a post batch', 'Draft a batch of posts for the saved accounts with suggested posting times and hashtags. Vary format and angle.'),
      task('reply_queue', 'Prepare replies', 'Draft replies to the comments or messages provided following the saved reply policy. Flag any that need the owner.'),
      task('trend_check', 'Check trends', 'List three topics currently relevant to the audience and how we could join each conversation honestly.')] },
  designer: { summary: 'Produce clean layouts, images and thumbnails as clear briefs and specs.',
    does: ['Write design briefs', 'Specify thumbnails and listing images', 'Keep visuals consistent'], deliver: ['Design brief or spec with sizes, layout and text'], quality: ['Clarity and contrast over decoration', 'Specify exact sizes and text'],
    settings: [T('brandColors', 'Brand colours', ''), S('style', 'Style', 'minimal', ['minimal', 'bold', 'playful', 'premium']), T('formats', 'Formats needed', 'thumbnail, product image, social post')],
    tasks: [task('design_brief', 'Write a design brief', 'Write a design brief: purpose, audience, exact dimensions, layout, text, colours and mood, with one reference description.'),
      task('thumbnail_set', 'Spec a thumbnail set', 'Specify a set of 3 thumbnails: dimensions, layout, headline text (under 6 words), and colour treatment.'),
      task('listing_images_spec', 'Spec listing images', 'Specify 5 product listing images: order, what each shows, overlay text, and dimensions for the platform.')] },
  ad_manager: { summary: 'Plan and read small paid tests, and kill what misses its target.',
    does: ['Plan tests with budgets and stop-losses', 'Write creative briefs', 'Review results daily'], deliver: ['Test plan', 'Creative briefs', 'Daily review with keep/kill calls'], quality: ['Start small', 'Every test has a stop-loss', 'Kill ads that miss the target cost per result'],
    settings: [S('platform', 'Platform', 'Facebook', ['Facebook']), N('dailyBudget', 'Daily budget (USD)', 10), N('targetCost', 'Target cost per result (USD)', 5), A('audience', 'Audience', ''), N('stopLoss', 'Stop-loss per test (USD)', 50)],
    tasks: [task('ad_test_plan', 'Plan an ad test', 'Plan a small paid test within the saved daily budget and stop-loss: audience, 3 creative angles, success threshold, and when to stop. You cannot create campaigns yourself, so write it so the owner can set it up in minutes.'),
      task('creative_briefs', 'Write creative briefs', 'Write briefs for 3 ad creatives: hook, visual idea, copy, and call to action.'),
      task('daily_ad_review', 'Review ad results', 'Review the ad spend and results available. For each ad: keep, change or kill against the target cost per result, with one line of reasoning. Say "no data" if there is none.')] },
  ecommerce_manager: { summary: 'Choose and import products for free, run listings, pricing and order health.',
    does: ['Generate product ideas', 'Write full listings', 'Review pricing and margin', 'Watch orders and refunds'], deliver: ['Product ideas', 'Listing drafts', 'Pricing review'], quality: ['Margin first', 'Search-friendly titles', 'Flag refund patterns'],
    settings: [S('platform', 'Store platform', 'shopify', ['etsy', 'shopify', 'both']), T('productType', 'Product type', ''), T('priceRange', 'Price range', ''), A('shippingNotes', 'Shipping and fulfilment notes', '')],
    tasks: [task('import_products', 'Import the product catalog', 'Build the catalog the storefront will sell, with no upfront inventory and no cost: digital products the owner already can deliver, or print-on-demand items from a supplier with a free plan. Verify current supplier terms before naming a cost and never state a price you did not verify. For each product give id, name, price, cost to fulfil, margin, supplier or delivery method, and a one-line description. Prices must leave a positive margin after fees. Return the catalog as a file: FILE: products.json then a fenced JSON block shaped {"products":[{"id":"","name":"","price":0,"cost":0,"description":"","fulfilment":""}]}, then a short list of how each order is fulfilled.'),
      task('product_ideas', 'Generate product ideas', 'Suggest 8 products that fit the goal and product type, each with target buyer, price point, rough margin and why it should sell.'),
      task('write_listings', 'Write listings', 'Write complete listings for the chosen products: title, description, bullet points, tags or keywords, and suggested price.'),
      task('pricing_review', 'Review pricing', 'Review prices against estimated costs and comparable products, and recommend changes that protect margin.'),
      task('order_review', 'Review orders', 'Review recent orders and refunds from the data available. Flag problems and suggest fixes. Say "no data" if there are none.')] },
  builder: { summary: 'Ship the smallest working thing for free: a website, an offer page, a store, an automation.',
    does: ['Build real static websites that host free (GitHub Pages, Cloudflare Pages, Netlify)', 'Wire "Buy" buttons to a hosted checkout link so people can click and pay', 'Prefer boring and finished over clever and late'], deliver: ['Working files, one block per file', 'Short publish steps'], quality: ['Smallest thing that works', 'No dependencies unless needed, no cost', 'Buy buttons read window.STORE_LINKS from config.js so the owner can paste links without editing code', 'Mobile friendly, fast, honest copy'],
    settings: [T('stack', 'Stack', 'plain HTML, CSS and JavaScript'), T('deployTarget', 'Where it will be hosted', 'a free static host (Cloudflare Pages, GitHub Pages or Netlify)')],
    tasks: [task('landing_page_build', 'Build a landing page', 'Build a single-page site from the copy provided: index.html with inline CSS. Include one clear call to action that opens window.STORE_LINKS["main"] (loaded from config.js, with a sensible fallback message when it is empty). Return every file as its own block: a line "FILE: name.ext" then a fenced code block with the full contents. Use only static files (HTML, CSS, JS, JSON) so it hosts for free; no server, no build step, no paid service. Then give three short steps to publish it free.'),
      task('store_site', 'Build the storefront site', 'Build a complete static storefront from the products and listing copy in the team memory and inputs: index.html (product grid and cart-free "Buy" buttons), style.css, app.js, and config.js containing window.STORE_LINKS = {} . Each product card reads its checkout URL from window.STORE_LINKS[product.id] and opens it in a new tab; when a link is missing it shows "Coming soon". Load the catalog from products.json (use those exact ids). Add a short refund and contact section. Return every file as its own block: a line "FILE: name.ext" then a fenced code block with the full contents. Use only static files (HTML, CSS, JS, JSON) so it hosts for free; no server, no build step, no paid service. Finish with the exact free publish steps.'),
      task('mvp_spec', 'Write an MVP spec', 'Write the smallest possible spec for a first version: the one job it does, screens or steps, data needed, and what is explicitly out of scope.'),
      task('automation_script', 'Write an automation script', 'Write a small script that automates the described step. Include how to run it and what could go wrong.')] },
  developer: { summary: 'Write and test the code the business needs, in small safe changes.',
    does: ['Implement features', 'Write tests', 'Review code'], deliver: ['Code with tests and run instructions'], quality: ['Small changes', 'Tests for behaviour', 'Explain tradeoffs plainly'],
    settings: [T('language', 'Language', 'JavaScript'), T('testStyle', 'Test approach', 'unit tests for each behaviour')],
    tasks: [task('implement_feature', 'Implement a feature', 'Implement the requested feature in the saved language with tests. Return code, tests and how to run them.'),
      task('write_tests', 'Write tests', 'Write tests that pin down the behaviour of the code or spec provided, including edge cases.'),
      task('review_code', 'Review code', 'Review the code provided for bugs, security problems and clarity. List issues by severity with fixes.')] },
  customer_support: { summary: 'Answer customers quickly and kindly, fix the problem, and log what keeps recurring.',
    does: ['Reply to tickets', 'Build the FAQ from repeat questions', 'Prepare refund decisions'], deliver: ['Reply drafts', 'FAQ entries'], quality: ['Solve first, apologise briefly', 'Escalate refunds over policy, legal threats and anything unusual'],
    settings: [S('tone', 'Tone', 'friendly', ['friendly', 'direct', 'formal']), A('refundPolicy', 'Refund policy', ''), T('escalateTo', 'Escalate to', 'the owner'), T('hours', 'Support hours', '')],
    tasks: [task('reply_to_ticket', 'Reply to a ticket', 'Write a reply to the customer message provided, following the saved tone and refund policy. Flag it if it must be escalated.'),
      task('faq_builder', 'Build the FAQ', 'Turn the questions provided into a clear FAQ with short, honest answers.'),
      task('refund_review', 'Review a refund request', 'Decide whether the refund request meets the saved policy. Recommend approve, decline or escalate, with a draft reply.')] },
  ops: { summary: 'Fulfil orders and keep delivery on time with tidy checklists and handoffs.',
    does: ['Write fulfilment checklists', 'Plan the week', 'Schedule work'], deliver: ['Checklists', 'Weekly ops plan'], quality: ['Every step has an owner and a deadline', 'Flag anything that could slip'],
    settings: [A('fulfilmentSteps', 'Fulfilment steps', ''), N('slaHours', 'Delivery target (hours)', 48)],
    tasks: [task('fulfilment_checklist', 'Write a fulfilment checklist', 'Write the step-by-step checklist to deliver one order end to end, with owner and time for each step.'),
      task('weekly_ops_plan', 'Plan the week', 'Plan the week: tasks, owners, deadlines, and the two things most likely to slip.'),
      task('schedule_work', 'Schedule work', 'Turn the tasks provided into a schedule with dates and times, and list any calendar events to create.')] },
  finance: { summary: 'Keep the ledger honest: only verified money counts, and losing ventures get stopped.',
    does: ['Review the ledger', 'Report profit and loss per venture', 'Recommend kill or scale'], deliver: ['Ledger review', 'Venture P&L', 'Kill or scale call'], quality: ['Only verified entries count as revenue', 'State loss limits plainly'],
    settings: [S('cadence', 'Report cadence', 'weekly', ['daily', 'weekly']), N('lossLimitPct', 'Flag at this % of loss limit', 70), T('currency', 'Currency', 'USD')],
    tasks: [task('ledger_review', 'Review the ledger', 'Review the ledger figures provided. Separate verified from unverified, flag anything odd, and summarise net profit against the target.'),
      task('venture_pnl', 'Venture P&L', 'Write a profit and loss summary per venture from the figures provided, and how close each is to its loss limit.'),
      task('kill_or_scale', 'Kill or scale', 'For each venture recommend kill, hold or scale with the numbers behind the call.')] },
  critic: { summary: 'Attack plans before money is spent: weak demand, policy risk, legal exposure, cost blowouts.',
    does: ['Review plans and copy', 'Check compliance', 'Approve, reject or send back with fixes'], deliver: ['Verdict: APPROVE, REJECT or REVISE, with specific fixes'], quality: ['Be specific', 'Name the single biggest risk', 'Never approve unverifiable claims'],
    settings: [S('riskAppetite', 'Risk appetite', 'balanced', ['cautious', 'balanced', 'bold']), A('checklist', 'Review checklist', 'demand evidence, platform policy, legal and consumer-protection risk, cost, honesty of claims')],
    tasks: [task('review_plan', 'Review a plan', 'Review the plan against the saved checklist. Give a verdict (APPROVE, REJECT or REVISE), the single biggest risk, and specific fixes.'),
      task('review_copy', 'Review copy', 'Review the copy for unverifiable claims, policy problems and clarity. List each issue with a fix and give a verdict.'),
      task('compliance_check', 'Compliance check', 'Check the plan or copy for advertising rules, email opt-out requirements, refund terms and platform policies. List gaps and fixes.')] },
  custom: { summary: 'A specialist you define. Follow your persona and stay inside your permissions.', does: ['Do the task you are given'], deliver: ['A clear result'], quality: ['Stay inside your permissions', 'Never invent results'],
    settings: [A('instructions', 'Standing instructions', '')], tasks: [task('do_task', 'Do a task', 'Do the task described and return a clear, usable result.')] }
};

const spec = (role) => JOBS[roleOf(role)] || JOBS.custom;
function defaultSettings(role) { const o = {}; for (const f of spec(role).settings) o[f.key] = f.default; return o; }

// Validate settings against the role's fields. Unknown keys are dropped; bad values keep the current one.
function cleanSettings(role, input, current) {
  const out = { ...defaultSettings(role), ...(current || {}) };
  if (!input || typeof input !== 'object') return out;
  for (const f of spec(role).settings) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    if (f.type === 'number') { const n = Number(v); if (Number.isFinite(n)) out[f.key] = Math.max(0, Math.min(1e6, n)); }
    else if (f.type === 'select') { if (f.options.includes(v)) out[f.key] = v; }
    else out[f.key] = String(v == null ? '' : v).slice(0, f.type === 'textarea' ? 1500 : 300);
  }
  return out;
}

// Spend settings can never outrun the owner's money: a saved $10/day ad budget means nothing when the capital is $50.
function capSettings(agent, s, mission) {
  if (!mission || agent.role !== 'ad_manager') return { s, capped: [] };
  const capD = Math.max(0, (mission.capitalCents || 0) / 100), riskD = mission.riskCents > 0 ? mission.riskCents / 100 : capD, out = { ...s }, capped = [];
  const daily = Math.floor((capD * 0.5) / 7), stop = Math.floor(Math.min(riskD, capD * 0.5));
  if (Number(out.dailyBudget) > daily) { out.dailyBudget = daily; capped.push('dailyBudget'); }
  if (Number(out.stopLoss) > stop) { out.stopLoss = stop; capped.push('stopLoss'); }
  return { s: out, capped };
}

// The job block appended to every agent prompt.
function systemFor(agent, mission) {
  const j = spec(agent.role), base = agent.settings || defaultSettings(agent.role), { s, capped } = capSettings(agent, base, mission);
  const set = j.settings.map((f) => [f.label, s[f.key], capped.includes(f.key)]).filter(([, v]) => v !== '' && v != null).map(([l, v, c]) => `- ${l}: ${v}${c ? ' (capped by the owner\'s capital)' : ''}`);
  const noAds = mission && agent.role === 'ad_manager' && !((mission.capitalCents || 0) >= 3000) ? 'The owner\'s capital is too small for paid ads. Propose only free traffic methods.' : '';
  return [`YOUR JOB: ${j.summary}`, 'You are responsible for:\n' + j.does.map((x) => '- ' + x).join('\n'), 'You hand back:\n' + j.deliver.map((x) => '- ' + x).join('\n'),
    'Quality bar:\n' + j.quality.map((x) => '- ' + x).join('\n'), set.length ? 'Your saved settings (use them):\n' + set.join('\n') : '', noAds].filter(Boolean).join('\n\n');
}
// Build the user prompt for one unit of work.
function taskPrompt(agent, { taskId, instructions, context }) {
  const t = spec(agent.role).tasks.find((x) => x.id === taskId);
  const parts = [];
  if (context && context.goal) parts.push(`Goal: ${context.goal}`);
  if (context && context.milestone) parts.push(`Milestone: ${context.milestone}`);
  if (t) parts.push(`Task: ${t.label}\n${t.prompt}`);
  if (instructions) parts.push(`${t ? 'Extra instructions' : 'Task'}: ${instructions}`);
  if (context && context.previous) parts.push(`Work from teammates to build on (stay consistent with it):\n${context.previous}`);
  parts.push(`Keep it tight: about ${(context && context.words) || 350} words at most, dense and specific, no filler.`,
    'Start your reply with one line: "HANDOFF: <under 30 words: the key facts and decisions your teammates need>". If you made a real choice (niche, offer, price, channel, budget), add up to three lines "DECISION: <the choice>" straight after it. Then give the finished deliverable, without any other preamble.');
  return parts.join('\n\n');
}
const publicJobs = () => Object.fromEntries(Object.entries(JOBS).map(([k, j]) => [k, { summary: j.summary, does: j.does, deliver: j.deliver, quality: j.quality, settings: j.settings, tasks: j.tasks.map((t) => ({ id: t.id, label: t.label })) }]));

module.exports = { JOBS, spec, defaultSettings, cleanSettings, systemFor, taskPrompt, publicJobs };
