// Text for the English version. Chinese lives in index.html as the default.
window.PAGE_I18N = {
  en: {
    'nav.how': 'How it works', 'nav.verify': 'Verification', 'nav.memory': 'Memory', 'nav.privacy': 'Privacy',
    'hero.eyebrow': 'On the Chrome Web Store · Open source · English & Chinese UI',
    'hero.title': 'One sentence.<br>The page gets to work.',
    'hero.lede': 'Describe a goal. It reads the page, fills forms, clicks and pages through, then checks every step against evidence on the page. Bring your own model; your data never passes through us.',
    'cta.store': 'Add to Chrome for free', 'cta.source': 'View source',
    'facts.size': 'package size', 'facts.deps': 'runtime deps', 'facts.license': 'license',
    'demo.aria': 'Illustrative animation', 'demo.form': 'Event sign-up', 'demo.name': 'Name', 'demo.email': 'Email', 'demo.city': 'City', 'demo.submit': 'Submit',
    'demo.authorized': 'Authorized', 'demo.goal': 'Fill this sign-up form with my details. Let me review before submitting.', 'demo.composer': 'Add instructions…',
    'demo.caption': 'Illustrative animation, not a real model run.',
    'mq.1': 'Read pages', 'mq.2': 'Fill forms', 'mq.3': 'Click & paginate', 'mq.4': 'Wait for feedback', 'mq.5': 'Verify results', 'mq.6': 'Remember preferences', 'mq.7': 'Take over anytime',
    'say.text': 'Not another chat box. It reads the page, takes action, checks its work, and stops to ask when it isn\u2019t sure.',
    'how.eyebrow': 'How it works', 'how.title': 'Three steps,<br>one loop.',
    'how.s1': 'Say the goal', 'how.s1p': 'Describe the task in plain language in the side panel. Add instructions mid-way, correct it, or click “I\u2019ll do it” to take over.',
    'how.s2': 'Read the page', 'how.s2p': 'Reads structure and text only on sites you authorize, long pages in segments. Passwords and verification codes are masked by default.',
    'how.s3': 'Act, then verify', 'how.s3p': 'One action per turn, then a fresh snapshot to confirm the field value, message or URL actually changed before moving on.',
    'verify.eyebrow': 'Step-by-step verification', 'verify.title': 'No blind clicks.<br>Every step needs proof.',
    'verify.lede': 'The classic failure of AI browser agents: clicking the wrong thing, assuming success and burning tokens. Check the result, then move forward. When the page changes, it takes another look and adapts the plan. Default mode blocks repeated clicks with uncertain results.',
    'verify.r1': 'Fill “Email”', 'verify.r2': 'Click “Next page”', 'verify.r3': 'Wait for “Saved”', 'verify.r4': 'Click “Submit”, no feedback', 'verify.r4e': 'Awaiting verification', 'verify.r5': 'Take another look and adapt', 'verify.r5e': 'Your call',
    'verify.p1': '100-turn default budget', 'verify.p2': 'Stop anytime', 'verify.p3': 'Resume after takeover', 'verify.p4': 'Auto context compaction', 'verify.p5': 'Scripts when needed; you review and approve',
    'verify.p6': 'Keep chatting: ask a follow-up or give it the next task', 'verify.p7': 'Conversation history stays local, ready to revisit', 'verify.p8': 'Turn on goal mode to try more paths around obstacles', 'verify.p9': 'Compare and carry data across tabs; asks before reading another tab',
    'memory.eyebrow': 'Memory', 'memory.title': 'Remember preferences.<br>Repeat yourself less.',
    'memory.lede': 'Let your assistant keep site-specific rules and everyday preferences locally, ready to read when needed. View, edit and export them anytime.',
    'memory.l2': 'Per site', 'memory.l2p': 'Per website · survives tabs and restarts', 'memory.l3': 'Global', 'memory.l3p': 'Preferences shared across sites',
    'privacy.title': 'Your model.<br>Your data.',
    'privacy.a1': 'Bring your own API', 'privacy.a1p': 'Any OpenAI Chat Completions compatible endpoint, model and key. Page content goes straight to the provider you choose.',
    'privacy.a2': 'Local models', 'privacy.a2p': 'Compatible services on localhost work too; leave the key empty for unauthenticated local servers. Page content never leaves your machine.',
    'privacy.a3': 'No telemetry', 'privacy.a3p': 'No project server, no analytics. Your key stays in the extension background, and site access is granted on demand.',
    'limits.title': 'What it can\u2019t do yet',
    'limits.l1': 'Built-in tools skip cross-origin or nested iframes and Shadow DOM (same-origin iframes: one level); with script execution on, open Shadow DOM and nested same-origin iframes work. Cross-origin iframes are still out of reach; images and canvas can be viewed via screenshots and clicked by position', 'limits.l2': 'Complex rich-text editors: simple plain-text replacement only', 'limits.l3': 'Synthetic events are not real mouse/keyboard input; some sites ignore them', 'limits.l4': 'Switches, opens and closes tabs within a task, but works on one tab at a time; tasks don\u2019t resume across browser restarts', 'limits.l5': 'Models can misjudge: check the page after submits or deletes',
    'limits.l6': 'Goal mode tries more persistently and may repeat actions. Keep it off for submissions or payments.',
    'promo.line': 'One sentence. The page gets to work.',
    'final.title': 'Hand off the repetitive web chores.',
    'foot.privacy': 'Privacy', 'foot.issues': 'Report an issue',
    'msg.agent': 'Page Agent', 'msg.read': 'Read the page: 3 fields found.', 'msg.verified': 'verified', 'msg.pause': 'All fields match. Paused before submitting — please review.',
    'val.name': 'Lin Xiaoman', 'val.email': 'mei@example.com', 'val.city': 'Hangzhou'
  },
  zh: {
    'msg.agent': 'Page Agent', 'msg.read': '已读取页面，找到 3 个可填写字段。', 'msg.verified': '已核实', 'msg.pause': '字段全部核对一致。提交前已暂停，请你检查。',
    'val.name': '林小满', 'val.email': 'mei@example.com', 'val.city': '杭州'
  }
};
