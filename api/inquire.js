/* POST /api/inquire — the only server-side code on this site.
 *
 * A Vercel Node function. Nothing here holds a secret: every credential is
 * read from the environment at call time, so the repo stays publishable and
 * the keys live only in the Vercel dashboard.
 *
 * ENVIRONMENT
 *   RESEND_API_KEY   required. Without it the function returns 503 and the
 *                    form says the request was not delivered, rather than
 *                    showing a success screen for a submission that went
 *                    nowhere.
 *   INQUIRY_TO       required. Where notifications land.
 *   INQUIRY_FROM     optional. A sender on a domain verified in Resend, e.g.
 *                    "Operator <hello@mattsilverman.xyz>". Until it is set the
 *                    function falls back to Resend's sandbox sender, which may
 *                    only deliver to the Resend account's own address. The
 *                    auto-reply needs this set, because it goes to a stranger.
 *   NOTION_TOKEN     optional. A Notion internal integration secret.
 *   NOTION_DATABASE  optional. The Operator Requests database id.
 *
 * DEGRADES IN ONE DIRECTION ONLY. The notification to the operator is the
 * only thing that can fail the request. The auto-reply and the Notion row are
 * attempted after the response is already decided and their failures are
 * logged, never surfaced: a sender who filled in the form correctly should
 * not see an error because a logging integration is misconfigured.
 */

const RESEND = 'https://api.resend.com/emails'
const NOTION = 'https://api.notion.com/v1/pages'
const SANDBOX_FROM = 'Operator <onboarding@resend.dev>'

/* Allowed values, mirrored from src/data/site.js. The form is a set of
 * selects, so anything outside these sets arrived from something other than
 * the form and is rejected rather than cleaned. */
const ENGAGEMENTS = {
  project: 'Project Design',
  fractional: 'Fractional Design',
  'forward-deployed': 'Forward-Deployed Design',
  ai: 'AI Enablement',
  unsure: 'Not sure yet',
}
const TIMELINES = {
  now: 'Ready now',
  '1-month': 'Within a month',
  quarter: 'This quarter',
  exploring: 'Exploring options',
}
const BUDGETS = {
  'under-15': 'Under $15k',
  '15-40': '$15k to $40k',
  '40-100': '$40k to $100k',
  '100-plus': '$100k+',
  unsure: 'Not sure yet',
}

const LIMITS = { name: 120, email: 200, company: 160, source: 200, project: 4000 }

/* Rate limiting, in memory.
 *
 * Worth being honest about what this is: serverless instances are recycled
 * and run in parallel, so this holds only within one warm instance and a
 * determined flood gets through. It is here to stop the common case, which is
 * one script hammering one endpoint, and it costs nothing. The real defences
 * are the honeypot, the dwell-time check and the fact that there is no money
 * or account on the other end of this form. A KV store would make it strict,
 * and is not worth a paid add-on for a contact form. */
const HITS = new Map()
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_WINDOW = 5

function rateLimited(ip) {
  const now = Date.now()
  const seen = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS)
  seen.push(now)
  HITS.set(ip, seen)
  if (HITS.size > 500) {
    for (const [k, v] of HITS) if (!v.some((t) => now - t < WINDOW_MS)) HITS.delete(k)
  }
  return seen.length > MAX_PER_WINDOW
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function resend(key, payload) {
  const res = await fetch(RESEND, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`)
  return res.json()
}

/* The notification. Plain text as well as HTML, because this one is read on a
 * phone more often than not and the text part is what a notification preview
 * shows. reply_to is the sender, so replying from the inbox reaches them
 * directly and no copy-pasting of addresses is involved. */
function notifyBody(d) {
  const rows = [
    ['Engagement', d.engagement],
    ['Timeline', d.timeline],
    ['Budget', d.budget],
    ['Name', d.name],
    ['Email', d.email],
    ['Company', d.company || 'Not given'],
    ['Heard via', d.source || 'Not given'],
  ]
  const text =
    rows.map(([k, v]) => `${k.padEnd(12)}${v}`).join('\n') +
    `\n\nThe problem, in their words\n${'-'.repeat(28)}\n${d.project}\n`
  const html = `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;line-height:1.6;color:#11110f">
<p style="margin:0 0 18px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#69705b">Operator / new request</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:22px">
${rows
  .map(
    ([k, v]) =>
      `<tr><td style="padding:4px 22px 4px 0;color:#6f6f64;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`,
  )
  .join('\n')}
</table>
<p style="margin:0 0 6px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#6f6f64">The problem, in their words</p>
<div style="border-left:2px solid #69705b;padding:2px 0 2px 14px;white-space:pre-wrap;font-family:system-ui,sans-serif">${esc(d.project)}</div>
<p style="margin:22px 0 0;font-size:12px;color:#6f6f64">Reply to this email and it goes straight to ${esc(d.email)}.</p>
</div>`
  return { text, html }
}

/* The auto-reply. Deliberately short, in the first person, and it promises
 * exactly what the site already promised on the confirmation screen: a plan,
 * usually within two business days. It does not quote their message back at
 * them, which is the tell of an automated system trying to sound attentive. */
function replyBody(d) {
  const first = d.name.split(/\s+/)[0]
  const text = `${first},

Your request came through. I read these myself, so this is the only automatic email you will get from me.

I will come back with a plan, usually within two business days. If it is urgent, reply to this and say so.

Matt Silverman
Operator`
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.65;color:#11110f">
<p style="margin:0 0 16px">${esc(first)},</p>
<p style="margin:0 0 16px">Your request came through. I read these myself, so this is the only automatic email you will get from me.</p>
<p style="margin:0 0 16px">I will come back with a plan, usually within two business days. If it is urgent, reply to this and say so.</p>
<p style="margin:0;color:#6f6f64">Matt Silverman<br><span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase">Operator</span></p>
</div>`
  return { text, html }
}

const rt = (s) => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 2000) } }] : [] })

async function logToNotion(token, database, d) {
  const res = await fetch(NOTION, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: database },
      properties: {
        Name: { title: [{ text: { content: d.name || d.email } }] },
        Email: { email: d.email },
        Company: rt(d.company),
        Engagement: { select: { name: d.engagement } },
        Timeline: { select: { name: d.timeline } },
        Budget: { select: { name: d.budget } },
        'The problem': rt(d.project),
        'Heard via': rt(d.source),
        Received: { date: { start: new Date().toISOString() } },
        Stage: { status: { name: 'Not started' } },
      },
    }),
  })
  if (!res.ok) throw new Error(`notion ${res.status}: ${await res.text()}`)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method' })
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'rate' })

  const b = typeof req.body === 'string' ? safeParse(req.body) : req.body || {}

  /* HONEYPOT. A field no human sees and no human fills. Anything in it means
   * a bot walked the DOM, so the request gets a 200 and goes in the bin: a
   * 400 here teaches the script to try again with the field left blank. */
  if (str(b.botcheck, 200)) return res.status(200).json({ ok: true })

  /* DWELL TIME. The form takes about two minutes to fill in honestly. Under
   * three seconds from mount to submit is automation, not a fast typist. */
  const elapsed = Number(b.elapsed)
  if (Number.isFinite(elapsed) && elapsed < 3000) return res.status(200).json({ ok: true })

  const d = {
    name: str(b.name, LIMITS.name),
    email: str(b.email, LIMITS.email),
    company: str(b.company, LIMITS.company),
    source: str(b.source, LIMITS.source),
    project: str(b.project, LIMITS.project),
    engagement: ENGAGEMENTS[b.engagement],
    timeline: TIMELINES[b.timeline],
    budget: BUDGETS[b.budget],
  }

  const bad = []
  if (!d.name) bad.push('name')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) bad.push('email')
  if (d.project.length < 12) bad.push('project')
  if (!d.engagement) bad.push('engagement')
  if (!d.timeline) bad.push('timeline')
  if (!d.budget) bad.push('budget')
  /* Newlines in a header field are header injection. The address regex above
   * already excludes whitespace, so this only guards the display name. */
  if (/[\r\n]/.test(d.name)) bad.push('name')
  if (bad.length) return res.status(400).json({ ok: false, error: 'invalid', fields: bad })

  const key = process.env.RESEND_API_KEY
  const to = process.env.INQUIRY_TO
  if (!key || !to) {
    console.error('inquire: RESEND_API_KEY or INQUIRY_TO is not set')
    return res.status(503).json({ ok: false, error: 'unconfigured' })
  }
  const from = process.env.INQUIRY_FROM || SANDBOX_FROM

  const notify = notifyBody(d)
  try {
    await resend(key, {
      from,
      to: [to],
      reply_to: [d.email],
      subject: `Operator: ${d.engagement} request from ${d.name}`,
      text: notify.text,
      html: notify.html,
    })
  } catch (err) {
    console.error('inquire: notification failed', err)
    return res.status(502).json({ ok: false, error: 'delivery' })
  }

  /* Past this point the request has succeeded as far as the sender is
   * concerned. Everything below is best effort. */
  res.status(200).json({ ok: true })

  if (process.env.INQUIRY_FROM) {
    const reply = replyBody(d)
    try {
      await resend(key, {
        from,
        to: [d.email],
        reply_to: [to],
        subject: 'Your request came through',
        text: reply.text,
        html: reply.html,
      })
    } catch (err) {
      console.error('inquire: auto-reply failed', err)
    }
  } else {
    console.warn('inquire: INQUIRY_FROM unset, auto-reply skipped')
  }

  if (process.env.NOTION_TOKEN && process.env.NOTION_DATABASE) {
    try {
      await logToNotion(process.env.NOTION_TOKEN, process.env.NOTION_DATABASE, d)
    } catch (err) {
      console.error('inquire: notion log failed', err)
    }
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
