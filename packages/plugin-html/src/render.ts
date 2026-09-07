import type { HtmlReport } from './model.js'

export interface RenderOptions {
  /** The `<title>`, and the heading at the top of the page. */
  title: string
}

/**
 * The whole report, as one file.
 *
 * Everything is inline: the data as a JSON island, the styles, the script.
 * There is not one external request in it, which is the entire point and the
 * one thing Allure cannot do — its report is a directory of JSON that the page
 * fetches, and a browser opening `file://` refuses those fetches, so it needs
 * `allure serve` and a second tool on the reader's machine. A single file is
 * one a person opens by double-clicking it, mails to somebody who does not
 * have speq installed, or drops into a pull request as an artifact.
 *
 * No framework and no CDN, for the same reason: a `<script src>` pointing at
 * somebody else's server is a report that goes blank the day that server does,
 * and offline is exactly when a build agent reads one.
 */
export function renderHtml(report: HtmlReport, options: RenderOptions): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(options.title)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    '<noscript><p class="empty">This report needs JavaScript to draw itself. The data is in the page — view source.</p></noscript>',
    `<script type="application/json" id="speq-report">${island(report)}</script>`,
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

/**
 * The data, in a `<script type="application/json">` island rather than in a
 * variable.
 *
 * A JSON island is inert: nothing in it is parsed as JavaScript, so a response
 * body containing a quote and a semicolon cannot end the script and start
 * executing. The one sequence that still matters is `</script`, in any case
 * and with any whitespace the parser allows, and `<` is escaped so the
 * substring cannot occur at all. `&` goes with it, because an HTML parser
 * would otherwise decode an entity inside the island.
 */
function island(report: HtmlReport): string {
  return JSON.stringify(report)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ------------------------------------------------------------------ */
/* The styles                                                          */
/* ------------------------------------------------------------------ */

/**
 * Light and dark, decided by the reader's own setting and overridable in the
 * page.
 *
 * Every colour is a token on `:root`, and the dark block redefines the tokens
 * and nothing else. A colour whose only definition lives inside a media query
 * is a colour that disappears when the query does not match, which is the
 * commonest way a report ends up as black text on a black ground.
 */
const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --line: #e6e4e0; --ink: #22201d; --dim: #6f6a63;
  --accent: #2f5fd0; --code: #f4f3f1;
  --passed: #2e7d4f; --failed: #c2402f; --error: #a4601c; --skipped: #7a7570;
  --passed-bg: #e8f3ec; --failed-bg: #fbeae7; --error-bg: #fbf1e4; --skipped-bg: #f0efed;
  --radius: 8px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #16181c; --panel: #1c1f24; --line: #2c3037; --ink: #e6e4e0; --dim: #9a958d;
    --accent: #7aa2f7; --code: #12141a;
    --passed: #74c69d; --failed: #f08c7c; --error: #e0b169; --skipped: #8b8680;
    --passed-bg: #1b2b23; --failed-bg: #2e1d1a; --error-bg: #2b2418; --skipped-bg: #23262b;
  }
}
:root[data-theme="dark"] {
  --bg: #16181c; --panel: #1c1f24; --line: #2c3037; --ink: #e6e4e0; --dim: #9a958d;
  --accent: #7aa2f7; --code: #12141a;
  --passed: #74c69d; --failed: #f08c7c; --error: #e0b169; --skipped: #8b8680;
  --passed-bg: #1b2b23; --failed-bg: #2e1d1a; --error-bg: #2b2418; --skipped-bg: #23262b;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
a { color: var(--accent); }

.wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 80px; }

header.top { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
header.top h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; letter-spacing: -0.01em; }
header.top .sub { color: var(--dim); font-size: 13px; }
header.top .sub span + span::before { content: "·"; margin: 0 8px; }
.spacer { flex: 1 1 auto; }
button.ghost {
  background: var(--panel); color: var(--dim); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 6px 12px; cursor: pointer; font: inherit; font-size: 13px;
}
button.ghost:hover { color: var(--ink); }

.totals { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.total {
  border: 1px solid var(--line); background: var(--panel); border-radius: var(--radius);
  padding: 10px 14px; cursor: pointer; font: inherit; text-align: left; min-width: 92px;
}
.total .n { font-size: 20px; font-weight: 600; display: block; line-height: 1.2; }
.total .k { font-size: 12px; color: var(--dim); text-transform: lowercase; }
.total[aria-pressed="true"] { border-color: currentColor; }
.total.passed { color: var(--passed); } .total.failed { color: var(--failed); }
.total.error { color: var(--error); } .total.skipped { color: var(--skipped); }
.total.all { color: var(--ink); }

.controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 18px; }
.controls input[type="search"] {
  flex: 1 1 260px; padding: 9px 12px; border-radius: var(--radius);
  border: 1px solid var(--line); background: var(--panel); color: inherit; font: inherit;
}
.chip {
  border: 1px solid var(--line); background: var(--panel); color: var(--dim);
  border-radius: 999px; padding: 3px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.chip[aria-pressed="true"] { color: var(--ink); border-color: var(--accent); }

.suite { margin-bottom: 22px; }
.suite > h2 {
  font-size: 13px; font-weight: 600; color: var(--dim); margin: 0 0 8px;
  text-transform: none; letter-spacing: 0.01em;
}
.suite > h2 .count { font-weight: 400; }

details.test {
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--panel); margin-bottom: 8px; overflow: hidden;
}
details.test > summary {
  cursor: pointer; padding: 11px 14px; display: flex; gap: 10px; align-items: baseline;
  list-style: none;
}
details.test > summary::-webkit-details-marker { display: none; }
details.test > summary:hover { background: var(--code); }
details.test > summary::after {
  content: "\\203A"; color: var(--dim); align-self: center; transition: transform .12s ease;
}
details.test[open] > summary::after { transform: rotate(90deg); }
details.test .name { font-weight: 500; flex: 1 1 auto; }
details.test .why { font-size: 13px; font-weight: 400; display: block; margin-top: 2px; color: var(--dim); }
details.test .why.failed { color: var(--failed); }
details.test .why.error { color: var(--error); }
.ms { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }

.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
.dot.passed { background: var(--passed); } .dot.failed { background: var(--failed); }
.dot.error { background: var(--error); } .dot.skipped { background: var(--skipped); }

.body { padding: 4px 14px 14px; border-top: 1px solid var(--line); }
.tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
.tag { font-size: 12px; border-radius: 999px; padding: 2px 9px; background: var(--code); color: var(--dim); }
.tag.k { color: var(--ink); }

h3.section { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin: 16px 0 8px; }

.step { border-left: 2px solid var(--line); padding-left: 12px; margin: 6px 0; }
.step.failed, .step.error { border-left-color: var(--failed); }
.step > .head { display: flex; gap: 8px; align-items: baseline; }
.step .id { font-weight: 500; }
.badge {
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  background: var(--code); color: var(--dim); white-space: nowrap;
}
.badge.owner { border: 1px dashed var(--line); background: transparent; }
.step .msg { color: var(--failed); font-size: 13px; margin: 2px 0 0; }
.step .kids { margin-left: 6px; }

.assert { display: flex; gap: 8px; align-items: baseline; font-size: 14px; margin: 4px 0; }
.assert .glyph { flex: none; width: 14px; text-align: center; }
.assert.no .glyph { color: var(--failed); }
.assert.yes .glyph { color: var(--passed); }
.assert .text { flex: 1 1 auto; }

.diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 6px 0 10px 22px; }
@media (max-width: 620px) { .diff { grid-template-columns: 1fr; } }
.diff > div { min-width: 0; }
.diff h4 { margin: 0 0 3px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }
pre {
  margin: 0; background: var(--code); border-radius: 6px; padding: 8px 10px;
  overflow-x: auto; font-size: 12.5px; line-height: 1.45; max-height: 380px;
}
details.fold > summary { cursor: pointer; color: var(--dim); font-size: 12px; margin: 4px 0; }

.shots { display: flex; gap: 10px; flex-wrap: wrap; }
.shot { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; max-width: 320px; }
.shot img { display: block; width: 100%; height: auto; background: var(--code); }
.shot .cap { font-size: 12px; color: var(--dim); padding: 5px 8px; }

.note { border-left: 2px solid var(--error); padding-left: 10px; margin: 6px 0; font-size: 13px; }
.empty { color: var(--dim); padding: 40px 0; text-align: center; }
footer { color: var(--dim); font-size: 12px; margin-top: 40px; border-top: 1px solid var(--line); padding-top: 14px; }
`

/* ------------------------------------------------------------------ */
/* The script                                                          */
/* ------------------------------------------------------------------ */

/**
 * Built with `document.createElement`, never with `innerHTML`.
 *
 * A report is a page full of strings the system under test chose: a response
 * body, a header, an assertion message. Concatenating those into HTML is how a
 * report ends up executing whatever a service put in an error message, and the
 * escaping would have to be right in every one of forty places. `textContent`
 * is right in all of them at once, and there is nowhere here for a `<script>`
 * in a payload to become one.
 */
const SCRIPT = `
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('speq-report').textContent);
  var STATUSES = ['passed', 'failed', 'error', 'skipped'];
  var state = { status: null, query: '', tags: [] };

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, attrs[key]);
    }
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(kid); });
    return node;
  }
  function ms(value) {
    if (value === undefined || value === null) return '';
    return value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(2) + 's';
  }
  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function show(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }
  function owner(kind, name) {
    var found = (DATA.owners && DATA.owners[kind]) ? DATA.owners[kind][name] : undefined;
    return found || null;
  }
  function shortName(plugin) {
    return plugin.replace(/^@speqkit\\/plugin-/, '').replace(/^speqkit-plugin-/, '');
  }

  /* ---- filtering ---- */

  function haystack(test) {
    var parts = [test.name, test.title || '', test.suite, test.source || '', test.group || ''];
    parts = parts.concat(test.tags || []).concat(test.failures || []);
    (function walk(steps) {
      steps.forEach(function (step) {
        parts.push(step.id || '', step.type, step.message || '');
        (step.assertions || []).forEach(function (a) { parts.push(a.message, a.type); });
        walk(step.steps || []);
      });
    })(test.steps || []);
    (test.assertions || []).forEach(function (a) { parts.push(a.message, a.type); });
    return parts.join(' ').toLowerCase();
  }

  DATA.tests.forEach(function (test) { test._hay = haystack(test); });

  function keep(test) {
    if (state.status && test.status !== state.status) return false;
    if (state.tags.length && !state.tags.every(function (t) { return (test.tags || []).indexOf(t) >= 0; })) return false;
    if (state.query && test._hay.indexOf(state.query) < 0) return false;
    return true;
  }

  /* ---- pieces ---- */

  function assertion(a) {
    var row = el('div', { class: 'assert ' + (a.passed ? 'yes' : 'no') }, [
      el('span', { class: 'glyph', text: a.passed ? '\\u2713' : '\\u2717' }),
      el('span', { class: 'text' }, [
        document.createTextNode(a.message),
        el('span', { class: 'badge', text: a.type, title: describe('assertions', a.type) })
      ])
    ]);
    if (a.passed || (a.expected === undefined && a.actual === undefined)) return [row];
    // Values only on a failure, on the same terms the event carries them:
    // a response body per passing assertion is noise, and a diff is a thing
    // you read about a failure.
    return [row, el('div', { class: 'diff' }, [
      el('div', {}, [el('h4', { text: 'expected' }), el('pre', { text: show(a.expected) })]),
      el('div', {}, [el('h4', { text: 'actual' }), el('pre', { text: show(a.actual) })])
    ])];
  }

  function describe(kind, name) {
    var found = owner(kind, name);
    if (!found) return name;
    return found.plugin + (found.summary ? ' — ' + found.summary : '');
  }

  function step(s) {
    var found = owner('steps', s.type);
    var head = el('div', { class: 'head' }, [
      el('span', { class: 'dot ' + s.status }),
      s.id ? el('span', { class: 'id', text: s.id }) : null,
      el('span', { class: 'badge', text: s.type, title: describe('steps', s.type) }),
      // Only when it adds something. An http step contributed by plugin-http
      // would print the same word twice, and a badge repeating the one beside
      // it trains a reader to stop looking at badges.
      found && shortName(found.plugin) !== s.type
        ? el('span', { class: 'badge owner', text: shortName(found.plugin), title: found.plugin })
        : null,
      s.phase ? el('span', { class: 'badge', text: s.phase }) : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'ms', text: ms(s.durationMs) })
    ]);

    var kids = [head];
    if (s.message) kids.push(el('p', { class: 'msg', text: s.message }));
    if (s.detail !== undefined) {
      kids.push(el('details', { class: 'fold' }, [
        el('summary', { text: 'what it did' }),
        el('pre', { text: show(s.detail) })
      ]));
    }
    (s.assertions || []).forEach(function (a) { assertion(a).forEach(function (n) { kids.push(n); }); });
    if ((s.steps || []).length) {
      kids.push(el('div', { class: 'kids' }, s.steps.map(step)));
    }
    return el('div', { class: 'step ' + s.status }, kids);
  }

  function artifact(a) {
    if (!a.href) {
      return el('div', { class: 'shot' }, [
        el('div', { class: 'cap', text: a.name + ' — ' + bytes(a.bytes) + ', not written to disk' })
      ]);
    }
    var picture = /^image\\//.test(a.contentType);
    var link = el('a', { href: a.href, target: '_blank', rel: 'noreferrer' },
      picture ? [el('img', { src: a.href, alt: a.name, loading: 'lazy' })] : []);
    return el('div', { class: 'shot' }, [
      link,
      el('div', { class: 'cap', text: a.name + ' — ' + bytes(a.bytes) })
    ]);
  }

  function test(t) {
    var summary = el('summary', {}, [
      el('span', { class: 'dot ' + t.status }),
      el('span', { class: 'name' }, [
        document.createTextNode(t.title || t.name),
        t.group ? el('span', { class: 'badge', text: t.group }) : null,
        t.failures.length ? el('span', { class: 'why ' + t.status, text: t.failures[0] }) : null,
        t.skipped ? el('span', { class: 'why skipped', text: t.skipped }) : null
      ]),
      el('span', { class: 'ms', text: ms(t.durationMs) })
    ]);

    var body = el('div', { class: 'body' });
    var chips = [];
    (t.tags || []).forEach(function (tag) { chips.push(el('span', { class: 'tag k', text: tag })); });
    if (t.source) chips.push(el('span', { class: 'tag', text: t.source }));
    for (var key in t.meta || {}) {
      chips.push(el('span', { class: 'tag', text: key + ': ' + show(t.meta[key]) }));
    }
    if (chips.length) body.appendChild(el('div', { class: 'tags' }, chips));

    if ((t.steps || []).length) {
      body.appendChild(el('h3', { class: 'section', text: 'steps' }));
      t.steps.forEach(function (s) { body.appendChild(step(s)); });
    }
    if ((t.assertions || []).length) {
      body.appendChild(el('h3', { class: 'section', text: 'assertions' }));
      t.assertions.forEach(function (a) { assertion(a).forEach(function (n) { body.appendChild(n); }); });
    }
    if ((t.artifacts || []).length) {
      body.appendChild(el('h3', { class: 'section', text: 'artifacts' }));
      body.appendChild(el('div', { class: 'shots' }, t.artifacts.map(artifact)));
    }

    // Open when it is not green: a report is read for its failures, and the
    // one that makes you click thirty times to find them is a worse report
    // than a wall of text.
    var node = el('details', { class: 'test' }, [summary, body]);
    if (t.status !== 'passed' && t.status !== 'skipped') node.open = true;
    return node;
  }

  /* ---- the page ---- */

  function totals() {
    var bar = el('div', { class: 'totals' });
    var counts = DATA.totals;
    var rows = [{ key: null, label: 'tests', n: counts.tests, cls: 'all' }];
    STATUSES.forEach(function (s) { rows.push({ key: s, label: s, n: counts[s], cls: s }); });

    rows.forEach(function (row) {
      var button = el('button', {
        class: 'total ' + row.cls,
        type: 'button',
        'aria-pressed': String(state.status === row.key)
      }, [
        el('span', { class: 'n', text: String(row.n) }),
        el('span', { class: 'k', text: row.label })
      ]);
      button.addEventListener('click', function () {
        state.status = state.status === row.key ? null : row.key;
        draw();
      });
      bar.appendChild(button);
    });
    return bar;
  }

  function controls() {
    var box = el('div', { class: 'controls' });
    var search = el('input', {
      type: 'search',
      placeholder: 'search names, steps, messages',
      value: state.query
    });
    search.addEventListener('input', function () {
      state.query = search.value.trim().toLowerCase();
      draw({ keepFocus: true });
    });
    box.appendChild(search);

    var seen = {};
    DATA.tests.forEach(function (t) { (t.tags || []).forEach(function (tag) { seen[tag] = true; }); });
    Object.keys(seen).sort().forEach(function (tag) {
      var on = state.tags.indexOf(tag) >= 0;
      var chip = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(on), text: tag });
      chip.addEventListener('click', function () {
        state.tags = on ? state.tags.filter(function (t) { return t !== tag; }) : state.tags.concat([tag]);
        draw();
      });
      box.appendChild(chip);
    });
    return box;
  }

  function header() {
    var when = DATA.startedAt ? new Date(DATA.startedAt).toLocaleString() : 'unknown time';
    var sub = el('div', { class: 'sub' }, [
      el('span', { text: when }),
      el('span', { text: ms(DATA.durationMs) }),
      DATA.runId ? el('span', { class: 'mono', text: DATA.runId }) : null,
      DATA.env ? el('span', { text: 'env: ' + DATA.env }) : null
    ]);

    var toggle = el('button', { class: 'ghost', type: 'button', text: 'theme' });
    toggle.addEventListener('click', function () {
      // Asked of the media query only the first time, so the button flips what
      // the reader is actually looking at rather than what their system says.
      var root = document.documentElement;
      var current = root.getAttribute('data-theme');
      if (!current) {
        current = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark' : 'light';
      }
      root.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
    });

    return el('header', { class: 'top' }, [
      el('div', {}, [el('h1', { text: document.title }), sub]),
      el('div', { class: 'spacer' }),
      toggle
    ]);
  }

  function draw(options) {
    var app = document.getElementById('app');
    var focused = document.activeElement && document.activeElement.type === 'search';
    var caret = focused ? document.activeElement.selectionStart : null;

    app.textContent = '';
    var wrap = el('div', { class: 'wrap' });
    wrap.appendChild(header());
    wrap.appendChild(totals());
    wrap.appendChild(controls());

    (DATA.notes || []).forEach(function (note) {
      wrap.appendChild(el('div', { class: 'note', text: note.level + ': ' + note.message }));
    });

    var shown = 0;
    var byName = {};
    DATA.tests.forEach(function (t) { byName[t.name] = t; });

    DATA.suites.forEach(function (suite) {
      var kept = suite.tests.map(function (name) { return byName[name]; }).filter(function (t) { return t && keep(t); });
      if (!kept.length) return;
      shown += kept.length;
      var section = el('section', { class: 'suite' }, [
        el('h2', {}, [
          document.createTextNode(suite.title || suite.name),
          el('span', { class: 'count', text: '  ' + kept.length })
        ])
      ]);
      kept.forEach(function (t) { section.appendChild(test(t)); });
      wrap.appendChild(section);
    });

    if (!shown) wrap.appendChild(el('p', { class: 'empty', text: 'nothing matches this filter' }));

    wrap.appendChild(el('footer', {}, [
      el('span', { text: 'written by @speqkit/plugin-html from the run\\u2019s event stream' })
    ]));
    app.appendChild(wrap);

    if (options && options.keepFocus) {
      var search = app.querySelector('input[type="search"]');
      if (search) { search.focus(); if (caret !== null) search.setSelectionRange(caret, caret); }
    }
  }

  draw();
})();
`
