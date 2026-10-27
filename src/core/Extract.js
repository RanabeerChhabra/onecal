// LLM extraction: builds the Claude request for one email thread and turns the reply into observations.
// Transport lives elsewhere (UrlFetchApp in Apps Script, fetch in Node) so this stays pure and testable.

var Extract = (function () {
  var SYSTEM = [
    'You extract scheduled meetings from email threads for a founders\' shared calendar.',
    '',
    'Output a meeting ONLY when the thread shows it is agreed/confirmed for a specific date AND a specific start time.',
    '- Count: explicit agreement ("see you Thursday at 4", "call confirmed for 26th, 11am IST", "works for me, booked"),',
    '  booking/scheduling confirmations (Calendly, Cal.com, Zoom, Google Calendar, Teams, HubSpot, etc.),',
    '  investor/accelerator/interview slots that were accepted or assigned, and forwarded invites.',
    '- Do NOT count: proposals or questions not yet accepted ("how about Thursday?", "free next week?"),',
    '  lists of available slots, "let\'s find a time", newsletters, promotions, open-registration webinars/events/livestreams,',
    '  receipts, flights, hotels, deliveries, deadlines, or reminders that are not meetings.',
    '',
    'Dates and times:',
    '- Every message has a "Sent" timestamp. Resolve relative dates ("Thursday", "tomorrow", "the 26th") against the Sent',
    '  time of the message where they were written, choosing the next occurrence on or after that date.',
    '- Use a timezone stated in the text (IST, GMT, PT, "Singapore time", ...). Otherwise use the default timezone given below.',
    '- start/end: ISO 8601 with a numeric UTC offset, e.g. 2026-10-29T16:00:00+05:30. end is null if no end or duration is stated.',
    '- timezone: the IANA name you used (e.g. Asia/Kolkata).',
    '',
    'Changes:',
    '- If the thread moves a meeting, output it ONCE with the NEW time.',
    '- If a meeting was explicitly cancelled (and not re-booked), output it with status "cancelled" and its last known time.',
    '- "Known meetings" are meetings already on the calendar that may relate to this thread. If an output meeting is one of',
    '  them (same meeting, even if moved or cancelled), set known_id to its id; otherwise known_id is null.',
    '  Return every known meeting this thread is about, with its current time or cancelled status.',
    '',
    'Fields:',
    '- title: short and specific, e.g. "Call with Priya (Sequoia)" or "Demo with Acme". No date in the title.',
    '- with: names (and company if known) of the other people. attendee_emails: email addresses of everyone attending.',
    '- location: physical place if any. join_url: the video link (Zoom/Meet/Teams/...) if present.',
    '- confidence: 0-1 that this is a confirmed meeting at exactly that time (0.9+ explicit confirmation or booking',
    '  email; ~0.7 strongly implied; below 0.5 unclear).',
    '- evidence: a short quote (max 20 words) from the email that fixes the date/time or the cancellation.',
    '',
    'If nothing qualifies, return {"meetings": []}.'
  ].join('\n');

  var NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] };

  var SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['meetings'],
    properties: {
      meetings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['known_id', 'status', 'title', 'with', 'attendee_emails', 'start', 'end', 'timezone',
            'location', 'join_url', 'confidence', 'evidence'],
          properties: {
            known_id: NULLABLE_STRING,
            status: { type: 'string', enum: ['confirmed', 'cancelled'] },
            title: { type: 'string' },
            with: { type: 'array', items: { type: 'string' } },
            attendee_emails: { type: 'array', items: { type: 'string' } },
            start: { type: 'string' },
            end: NULLABLE_STRING,
            timezone: { type: 'string' },
            location: NULLABLE_STRING,
            join_url: NULLABLE_STRING,
            confidence: { type: 'number' },
            evidence: { type: 'string' }
          }
        }
      }
    }
  };

  var MAX_MESSAGES = 8;
  var MAX_MSG_CHARS = 4000;
  var MAX_TOTAL_CHARS = 24000;

  // Drops quoted replies. Only safe when the earlier messages are in the thread too.
  function stripQuotes(body) {
    var lines = String(body || '').split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^On .{6,200}wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) ||
          (/^From: /.test(l) && i + 1 < lines.length && /^(Sent|Date): /.test(lines[i + 1]))) break;
      if (/^\s*>/.test(l)) continue;
      out.push(l);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function founderLine(cfg) {
    return cfg.founders.map(function (f) { return f.tag + '=' + f.name + ' (' + f.emails.join(', ') + ')'; }).join('; ');
  }

  // thread: { id, subject, messages: [{ date, from, to, cc, subject, body }] }
  // known:  [{ id, title, start, with }] meetings this thread may update.
  function buildPrompt(thread, acct, known, cfg, now) {
    var msgs = (thread.messages || []).slice(-MAX_MESSAGES);
    var multi = msgs.length > 1;
    var parts = [
      'Default timezone: ' + cfg.defaultTz,
      'Now: ' + Util.isoInTz(now, cfg.defaultTz),
      'Mailbox owner: ' + acct.email + (String(acct.founder).indexOf('+') >= 0 ? ' (shared team inbox of all founders)' : ' (founder ' + acct.founder + ')'),
      'Founders: ' + founderLine(cfg),
      'Thread subject: ' + (thread.subject || (msgs[0] && msgs[0].subject) || '')
    ];
    if (known && known.length) {
      parts.push('Known meetings:');
      known.forEach(function (k) {
        parts.push('- id=' + k.id + ' | ' + k.title + ' | ' + Util.isoInTz(k.start, cfg.defaultTz) +
          (k.with && k.with.length ? ' | with ' + k.with.slice(0, 4).join(', ') : ''));
      });
    }
    var budget = MAX_TOTAL_CHARS;
    var rendered = [];
    for (var i = msgs.length - 1; i >= 0 && budget > 500; i--) {
      var m = msgs[i];
      var body = multi ? stripQuotes(m.body) : String(m.body || '').trim();
      body = Util.truncate(body, Math.min(MAX_MSG_CHARS, budget));
      budget -= body.length;
      rendered.unshift([
        '--- Message ' + (i + 1) + ' of ' + msgs.length + ' ---',
        'Sent: ' + Util.isoInTz(m.date, cfg.defaultTz) + ' (' + Util.fmt(m.date, cfg.defaultTz).split(' ')[0] + ')',
        'From: ' + (m.from || ''),
        'To: ' + (m.to || ''),
        m.cc ? 'Cc: ' + m.cc : null,
        'Subject: ' + (m.subject || ''),
        '',
        body
      ].filter(function (x) { return x !== null; }).join('\n'));
    }
    return parts.join('\n') + '\n\n' + rendered.join('\n\n');
  }

  // DeepSeek has no schema-enforced output, only "JSON mode", so the shape is spelled out in the prompt
  // and checked in readResponse.
  var JSON_SHAPE = [
    '',
    'Reply with json only, exactly in this shape (all keys required; use null where a value is unknown):',
    '{"meetings": [{"known_id": null, "status": "confirmed", "title": "Call with Priya (Sequoia)", "with": ["Priya Shah (Sequoia)"],',
    ' "attendee_emails": ["priya@sequoia.example"], "start": "2026-10-29T16:00:00+05:30", "end": "2026-10-29T16:30:00+05:30",',
    ' "timezone": "Asia/Kolkata", "location": null, "join_url": "https://zoom.us/j/123", "confidence": 0.95,',
    ' "evidence": "see you Thursday at 4"}]}',
    'status is "confirmed" or "cancelled".'
  ].join('\n');

  function buildRequest(thread, acct, known, cfg, now) {
    var prompt = buildPrompt(thread, acct, known, cfg, now);
    if (cfg.provider === 'deepseek') {
      return {
        model: cfg.model,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM + '\n' + JSON_SHAPE }, { role: 'user', content: prompt }]
      };
    }
    return {
      model: cfg.model,
      max_tokens: 4096,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: prompt }]
    };
  }

  // Accepts a Claude Messages reply or a DeepSeek (OpenAI-style) chat completion.
  // Returns { meetings: [...] } or { error }.
  function readResponse(resp) {
    if (!resp) return { error: 'empty response' };
    if (resp.type === 'error' || resp.error) return { error: 'api error: ' + JSON.stringify(resp.error || resp).slice(0, 300) };
    var text;
    if (resp.choices) {
      var choice = resp.choices[0] || {};
      if (choice.finish_reason === 'length') return { error: 'output truncated (max_tokens)' };
      if (choice.finish_reason === 'content_filter') return { error: 'model refused' };
      text = (choice.message && choice.message.content) || '';
      if (!text.trim()) return { error: 'empty reply from model' };
    } else {
      if (resp.stop_reason === 'refusal') return { error: 'model refused' };
      if (resp.stop_reason === 'max_tokens') return { error: 'output truncated (max_tokens)' };
      text = (resp.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    }
    try {
      var data = JSON.parse(text);
      if (!data || !Array.isArray(data.meetings)) return { error: 'no meetings array' };
      if (!data.meetings.every(function (m) { return m && typeof m === 'object' && typeof m.start === 'string'; })) {
        return { error: 'meeting without a start time' };
      }
      return data;
    } catch (e) {
      return { error: 'invalid JSON from model' };
    }
  }

  // ctx: { acct, threadId, asOf, subject, knownIds[] (ids already linked to this thread) }
  // Returns { obs[], skipped[{ title, reason, confidence }], keepIds[], error }.
  function toObservations(resp, ctx, cfg, now) {
    var data = readResponse(resp);
    var result = { obs: [], skipped: [], keepIds: [], error: data.error || null };
    var threadKnown = ctx.knownIds || [];
    if (data.error) { result.keepIds = threadKnown.slice(); return result; }

    var meetings = data.meetings;
    // One meeting in, one meeting out: treat it as the same meeting even if the model left known_id empty.
    if (threadKnown.length === 1 && meetings.length === 1 && !meetings[0].known_id) meetings[0].known_id = threadKnown[0];

    var addressed = {};
    meetings.forEach(function (m) {
      var title = Util.truncate(m.title || '(untitled meeting)', 120);
      var conf = typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)) : 0;
      var tz = Util.isValidTz(m.timezone) ? m.timezone : cfg.defaultTz;
      var start = Util.parseIso(m.start, tz);
      if (start === null) return result.skipped.push({ title: title, reason: 'unparseable start "' + m.start + '"', confidence: conf });
      var end = Util.parseIso(m.end, tz);
      if (end === null || end <= start) end = start + cfg.defaultDurationMin * 60000;
      var knownId = m.known_id && threadKnownOrAny(m.known_id, ctx) ? m.known_id : null;

      if (end <= now) return result.skipped.push({ title: title, reason: 'in the past', confidence: conf });
      var need = (m.status === 'cancelled' || knownId) ? cfg.addThreshold : cfg.tentativeThreshold;
      if (conf < need) {
        return result.skipped.push({ title: title, confidence: conf,
          reason: 'confidence ' + conf.toFixed(2) + ' below ' + need + (m.status === 'cancelled' ? ' for a cancellation' : knownId ? ' for changing a known meeting' : '') });
      }
      if (knownId) addressed[knownId] = true;
      var join = m.join_url || null;
      var link = Links.find(join || '');
      result.obs.push({
        src: Sources.threadScope(ctx.acct, ctx.threadId), kind: 'email', acct: ctx.acct.email, founder: ctx.acct.founder,
        status: m.status === 'cancelled' ? 'cancelled' : 'confirmed',
        title: title, start: start, end: end, tz: tz,
        location: m.location || null, joinUrl: link ? link.url : join, confKey: link ? link.key : null,
        attendees: Util.uniq((m.attendee_emails || []).map(function (e) { return Util.normEmail(e); })).slice(0, 15),
        with: (m.with || []).slice(0, 8).map(function (w) { return Util.truncate(w, 60); }),
        ical: null,
        confidence: conf,
        asOf: ctx.asOf,
        knownId: knownId,
        link: Sources.gmailLink(ctx.acct.email, ctx.threadId),
        evidence: Util.truncate(m.evidence || '', 160)
      });
    });
    // Known meetings of this thread that the model did not confidently address keep their old observation.
    result.keepIds = threadKnown.filter(function (id) { return !addressed[id]; });
    return result;
  }

  function threadKnownOrAny(id, ctx) {
    return (ctx.knownIds || []).indexOf(id) >= 0 || (ctx.contextIds || []).indexOf(id) >= 0;
  }

  return { SYSTEM: SYSTEM, SCHEMA: SCHEMA, buildPrompt: buildPrompt, buildRequest: buildRequest,
    readResponse: readResponse, toObservations: toObservations, stripQuotes: stripQuotes };
})();
