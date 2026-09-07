/**
 * The page, as one document with nothing outside it.
 *
 * No bundler, no framework, no CDN. A `<script src>` pointing at somebody
 * else's server is a panel that goes blank on an aeroplane and on a build
 * agent with no egress, and a build step between this repository and a working
 * `speq ui` is a build step that will one day be stale in somebody's install.
 * Everything the browser needs arrives in the first response.
 *
 * The DOM is built with `createElement` and `textContent` throughout, never
 * with string concatenation. Every string on this page — a step's input, a
 * response body a run recorded, an assertion message — was chosen by the
 * system under test or by whoever wrote the suite, and a panel that executes
 * what a service put in an error message is a vulnerability with a sidebar.
 */
export function page(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>speq</title>',
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    '<div id="app" class="loading">reading the project…</div>',
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --line: #e6e4e0; --ink: #22201d; --dim: #6f6a63;
  --accent: #2f5fd0; --code: #f4f3f1; --hover: #f0efed;
  --passed: #2e7d4f; --failed: #c2402f; --error: #a4601c; --skipped: #7a7570;
  --radius: 8px; --side: 320px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #16181c; --panel: #1c1f24; --line: #2c3037; --ink: #e6e4e0; --dim: #9a958d;
    --accent: #7aa2f7; --code: #12141a; --hover: #23262b;
    --passed: #74c69d; --failed: #f08c7c; --error: #e0b169; --skipped: #8b8680;
  }
}
:root[data-theme="dark"] {
  --bg: #16181c; --panel: #1c1f24; --line: #2c3037; --ink: #e6e4e0; --dim: #9a958d;
  --accent: #7aa2f7; --code: #12141a; --hover: #23262b;
  --passed: #74c69d; --failed: #f08c7c; --error: #e0b169; --skipped: #8b8680;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14.5px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
pre, code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.loading { padding: 60px; color: var(--dim); text-align: center; }

header.bar {
  display: flex; align-items: center; gap: 14px; padding: 10px 18px;
  border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 5; flex-wrap: wrap;
}
header.bar .brand { font-weight: 600; letter-spacing: -0.01em; }
header.bar .where { color: var(--dim); font-size: 12.5px; }
.spacer { flex: 1 1 auto; }
nav.tabs { display: flex; gap: 4px; }
nav.tabs button, button.ghost {
  background: transparent; border: 1px solid transparent; color: var(--dim);
  padding: 5px 12px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 13px;
}
nav.tabs button:hover, button.ghost:hover { background: var(--hover); color: var(--ink); }
nav.tabs button[aria-selected="true"] { background: var(--hover); color: var(--ink); border-color: var(--line); }
button.ghost { border-color: var(--line); }

.split { display: grid; grid-template-columns: var(--side) 1fr; min-height: calc(100vh - 49px); }
/* The sidebar is sticky and one viewport tall, so on a long page its own
   background stops halfway down the column. Painting the column here rather
   than on the element is what keeps the edge running the whole way. */
.split { background: linear-gradient(to right, var(--panel) 0 var(--side), var(--bg) var(--side)); }
@media (max-width: 780px) {
  .split { grid-template-columns: 1fr; background: var(--bg); }
  aside { border-right: 0; position: static; max-height: none; }
}
aside {
  border-right: 1px solid var(--line); background: var(--panel);
  padding: 12px; overflow-y: auto; max-height: calc(100vh - 49px); position: sticky; top: 49px;
}
main { padding: 20px 24px 80px; min-width: 0; max-width: 940px; }

input[type="search"] {
  width: 100%; padding: 7px 10px; border-radius: var(--radius);
  border: 1px solid var(--line); background: var(--bg); color: inherit; font: inherit; font-size: 13px;
}
.group { margin: 14px 0 4px; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }
.row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 5px 8px; border-radius: 6px; border: 0; background: transparent;
  color: inherit; font: inherit; cursor: pointer; text-align: left;
}
.row:hover { background: var(--hover); }
.row[aria-current="true"] { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent); }
.row .label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .sub { color: var(--dim); font-size: 11.5px; }

.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.passed { background: var(--passed); } .dot.failed { background: var(--failed); }
.dot.error { background: var(--error); } .dot.skipped { background: var(--skipped); }
.dot.unknown { background: var(--line); }

.strip { display: inline-flex; gap: 2px; flex: none; }
.strip i { width: 5px; height: 13px; border-radius: 1px; display: block; background: var(--line); }
.strip i.passed { background: var(--passed); } .strip i.failed { background: var(--failed); }
.strip i.error { background: var(--error); } .strip i.skipped { background: var(--skipped); }

h1.title { font-size: 20px; margin: 0 0 2px; font-weight: 600; letter-spacing: -0.01em; }
h1.title .id { color: var(--dim); font-weight: 400; font-size: 13px; display: block; margin-top: 3px; }
h2.section { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin: 24px 0 8px; }
p.lead { color: var(--dim); margin: 4px 0 0; }

.chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
.chip { font-size: 12px; border-radius: 999px; padding: 2px 9px; background: var(--code); color: var(--dim); }
.chip.k { color: var(--ink); }
.chip.warn { color: var(--error); }

.card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px 14px; margin-bottom: 8px; }
.card .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.card .head .id { font-weight: 600; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--code); color: var(--dim); white-space: nowrap; }
.badge.owner { border: 1px dashed var(--line); background: transparent; }
.badge.phase { border: 1px solid var(--line); background: transparent; }
.says { color: var(--dim); font-size: 12.5px; margin: 4px 0 0; }
.kids { margin: 8px 0 0 14px; border-left: 2px solid var(--line); padding-left: 12px; }

pre {
  margin: 6px 0 0; background: var(--code); border-radius: 6px; padding: 8px 10px;
  overflow-x: auto; font-size: 12.5px; line-height: 1.45; max-height: 420px; white-space: pre;
}
details.fold > summary { cursor: pointer; color: var(--dim); font-size: 12px; margin: 6px 0 0; }

.assert { display: flex; gap: 8px; align-items: baseline; margin: 5px 0; }
.assert .glyph { flex: none; width: 14px; text-align: center; }
.assert.no .glyph { color: var(--failed); }
.assert.yes .glyph { color: var(--passed); }
.diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 4px 0 10px 22px; }
@media (max-width: 700px) { .diff { grid-template-columns: 1fr; } }
.diff h4 { margin: 0 0 3px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }

.totals { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0 4px; color: var(--dim); font-size: 13px; }
.totals b { font-weight: 600; }
.totals .passed { color: var(--passed); } .totals .failed { color: var(--failed); }
.totals .error { color: var(--error); } .totals .skipped { color: var(--skipped); }

.problem { border-left: 2px solid var(--failed); padding: 2px 0 2px 10px; margin: 8px 0; }
.problem .code { color: var(--failed); font-size: 12px; }
.problem.warn { border-left-color: var(--skipped); }
.problem.warn .code { color: var(--skipped); }
.note { border-left: 2px solid var(--error); padding-left: 10px; margin: 8px 0; font-size: 13px; }
.empty { color: var(--dim); padding: 40px 0; }
.shots { display: flex; gap: 10px; flex-wrap: wrap; }
.shot { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; max-width: 300px; }
.shot img { display: block; width: 100%; height: auto; background: var(--code); }
.shot .cap { font-size: 12px; color: var(--dim); padding: 5px 8px; }
.ms { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
table.grammar { border-collapse: collapse; width: 100%; font-size: 13px; }
table.grammar td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
table.grammar td.w { white-space: nowrap; font-weight: 500; }
`

const SCRIPT = `
(function () {
  'use strict';

  var RESERVED = { id: 1, type: 1, steps: 1, assert: 1, meta: 1 };
  var state = { view: 'project', test: null, run: null, query: '', source: null };
  var data = { project: null, runs: null, history: null, run: null, error: null };

  /* ---- the small things ---- */

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (key === 'on') node.addEventListener('click', attrs[key]);
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
  function get(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' answered ' + r.status);
      return r.json();
    });
  }
  function capability(kind, name) {
    var list = (data.project && data.project.capabilities[kind]) || [];
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  }
  function fold(label, body) {
    return el('details', { class: 'fold' }, [el('summary', { text: label }), body]);
  }
  function json(value) { return el('pre', { text: show(value) }); }

  /* ---- what a step is, and whose word it is ---- */

  /**
   * The whole reason this panel exists next to a text editor: a suite is
   * written in words, and which plugin each word belongs to is nowhere in the
   * file. It is answered out of the running session, so a project with one
   * more plugin installed has one more answer.
   */
  function owned(kind, name, extra) {
    var found = capability(kind, name);
    var chips = [el('span', { class: 'badge', text: name })];
    if (found) {
      chips.push(el('span', { class: 'badge owner', text: found.plugin, title: 'contributed by ' + found.plugin }));
    } else {
      chips.push(el('span', { class: 'badge owner', text: 'no plugin defines this', title: 'nothing loaded contributes ' + name }));
    }
    (extra || []).forEach(function (chip) { chips.push(chip); });
    return { chips: chips, summary: found && found.summary ? found.summary : null, found: found };
  }

  function inputOf(step) {
    var input = {};
    var any = false;
    for (var key in step) {
      if (RESERVED[key] || key.charAt(0) === '_') continue;
      input[key] = step[key];
      any = true;
    }
    return any ? input : null;
  }

  function definedStep(step, phase) {
    var head = owned('stepTypes', step.type, phase ? [el('span', { class: 'badge phase', text: phase })] : []);
    var kids = [el('div', { class: 'head' }, [step.id ? el('span', { class: 'id', text: step.id }) : null].concat(head.chips))];
    if (head.summary) kids.push(el('p', { class: 'says', text: head.summary }));

    var input = inputOf(step);
    if (input) kids.push(json(input));
    (step.assert || []).forEach(function (a) { kids.push(definedAssertion(a)); });
    if ((step.steps || []).length) {
      kids.push(el('div', { class: 'kids' }, step.steps.map(function (s) { return definedStep(s, null); })));
    }
    if (step.meta) kids.push(fold('meta', json(step.meta)));
    return el('div', { class: 'card' }, kids);
  }

  function definedAssertion(assertion) {
    var head = owned('assertions', assertion.type, []);
    var input = {};
    var any = false;
    for (var key in assertion) {
      if (key === 'type' || key === 'meta') continue;
      input[key] = assertion[key];
      any = true;
    }
    return el('div', { class: 'card' }, [
      el('div', { class: 'head' }, head.chips),
      head.summary ? el('p', { class: 'says', text: head.summary }) : null,
      any ? json(input) : null
    ]);
  }

  /* ---- the project side ---- */

  function groupOf(test) {
    var suites = test.suites || [];
    if (suites.length) return suites[suites.length - 1].name;
    if (test.source) {
      var cut = test.source.lastIndexOf('/');
      return cut > 0 ? test.source.slice(0, cut) : test.source;
    }
    return '(inline)';
  }

  function latest(name) {
    var points = (data.history && data.history.tests[name]) || [];
    return points.length ? points[0].status : 'unknown';
  }

  function strip(name) {
    var points = ((data.history && data.history.tests[name]) || []).slice(0, 12).reverse();
    if (!points.length) return null;
    return el('span', { class: 'strip', title: points.length + ' recorded run(s), oldest first' },
      points.map(function (p) {
        return el('i', { class: p.status, title: new Date(p.at).toLocaleString() + ' — ' + p.status + ' ' + ms(p.durationMs) });
      }));
  }

  function matches(test) {
    if (!state.query) return true;
    var hay = [test.name, test.title || '', test.source || '', groupOf(test)]
      .concat(test.tags || [])
      .concat((test.steps || []).map(function (s) { return s.type + ' ' + (s.id || ''); }))
      .join(' ').toLowerCase();
    return hay.indexOf(state.query) >= 0;
  }

  function projectSidebar() {
    var side = el('aside');
    var search = el('input', { type: 'search', placeholder: 'search tests, steps, tags', value: state.query });
    search.addEventListener('input', function () {
      state.query = search.value.trim().toLowerCase();
      draw({ keepFocus: true });
    });
    side.appendChild(search);

    var groups = {};
    var order = [];
    data.project.tests.forEach(function (test) {
      if (!matches(test)) return;
      var key = groupOf(test);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(test);
    });

    if (!order.length) {
      side.appendChild(el('p', { class: 'empty', text: 'nothing matches' }));
      return side;
    }

    order.sort().forEach(function (key) {
      side.appendChild(el('div', { class: 'group', text: key }));
      groups[key].forEach(function (test) {
        var row = el('button', {
          class: 'row', type: 'button',
          'aria-current': String(state.test === test.name),
          on: function () { state.test = test.name; state.source = null; draw(); }
        }, [
          el('span', { class: 'dot ' + latest(test.name), title: 'newest recorded run' }),
          el('span', { class: 'label', text: test.title || test.name, title: test.name }),
          test.pending ? el('span', { class: 'sub', text: 'pending' }) : strip(test.name)
        ]);
        side.appendChild(row);
      });
    });
    return side;
  }

  function testDetail() {
    var found = null;
    data.project.tests.forEach(function (t) { if (t.name === state.test) found = t; });
    if (!found) {
      return el('main', {}, [
        el('p', { class: 'empty', text: 'Pick a test on the left. It shows what the test says, which plugin owns every step in it, and how it has been doing.' }),
        diagnostics()
      ]);
    }

    var body = el('main');
    body.appendChild(el('h1', { class: 'title' }, [
      document.createTextNode(found.title || found.name),
      found.title ? el('span', { class: 'id', text: found.name }) : null
    ]));

    var chips = [];
    (found.tags || []).forEach(function (tag) { chips.push(el('span', { class: 'chip k', text: tag })); });
    if (found.group) chips.push(el('span', { class: 'chip', text: 'case of ' + found.group }));
    (found.suites || []).forEach(function (s) { chips.push(el('span', { class: 'chip', text: 'suite ' + s.name })); });
    if (found.pending) chips.push(el('span', { class: 'chip warn', text: 'pending: ' + found.pending }));
    if (chips.length) body.appendChild(el('div', { class: 'chips' }, chips));

    if (found.source) {
      body.appendChild(el('p', { class: 'lead' }, [
        el('a', {
          href: '#', text: state.source === found.source ? 'hide ' + found.source : 'read ' + found.source,
          on: function (e) {
            e.preventDefault();
            state.source = state.source === found.source ? null : found.source;
            draw();
          }
        })
      ]));
      if (state.source === found.source) {
        var pre = el('pre', { text: 'reading…' });
        body.appendChild(pre);
        get('/api/source?file=' + encodeURIComponent(found.source)).then(function (answer) {
          pre.textContent = answer.text;
        }).catch(function (error) { pre.textContent = String(error); });
      }
    }

    var points = (data.history && data.history.tests[found.name]) || [];
    if (points.length) {
      body.appendChild(el('h2', { class: 'section', text: 'how it has been doing' }));
      var line = el('div', { class: 'totals' }, [strip(found.name)]);
      var red = points.filter(function (p) { return p.status !== 'passed' && p.status !== 'skipped'; }).length;
      line.appendChild(el('span', {
        text: points.length + ' recorded run(s), ' + red + ' not green, newest ' + ms(points[0].durationMs)
      }));
      body.appendChild(line);
      body.appendChild(el('div', { class: 'chips' }, points.slice(0, 8).map(function (p) {
        return el('button', {
          class: 'chip', type: 'button',
          text: new Date(p.at).toLocaleString() + ' — ' + p.status,
          on: function () { state.view = 'runs'; state.run = p.runId; data.run = null; draw(); }
        });
      })));
    }

    if (found.variables) {
      body.appendChild(el('h2', { class: 'section', text: 'variables' }));
      body.appendChild(json(found.variables));
    }
    [['setup', found.setup], ['steps', found.steps], ['cleanup', found.cleanup]].forEach(function (pair) {
      if (!(pair[1] || []).length) return;
      body.appendChild(el('h2', { class: 'section', text: pair[0] }));
      pair[1].forEach(function (step) {
        body.appendChild(definedStep(step, pair[0] === 'steps' ? null : pair[0]));
      });
    });
    if ((found.assert || []).length) {
      body.appendChild(el('h2', { class: 'section', text: 'assert' }));
      found.assert.forEach(function (a) { body.appendChild(definedAssertion(a)); });
    }
    if (found.meta) {
      body.appendChild(el('h2', { class: 'section', text: 'meta' }));
      body.appendChild(json(found.meta));
    }

    var mine = data.project.diagnostics.filter(function (d) { return d.file === found.source; });
    if (mine.length) {
      body.appendChild(el('h2', { class: 'section', text: 'what validate says about this file' }));
      mine.forEach(function (d) { body.appendChild(problem(d)); });
    }
    return body;
  }

  function problem(d) {
    // A warning is legal and probably not meant, and painting it the colour of
    // something that stops a run would teach a reader to ignore the colour.
    return el('div', { class: d.level === 'warn' ? 'problem warn' : 'problem' }, [
      el('div', {}, [
        el('span', { class: 'code', text: d.code }),
        document.createTextNode('  ' + d.file + ' · ' + d.path)
      ]),
      el('div', { text: d.message }),
      d.hint ? el('div', { class: 'says', text: d.hint }) : null
    ]);
  }

  function diagnostics() {
    var list = data.project.diagnostics;
    if (!list.length) return el('p', { class: 'lead', text: 'Every test validates against the loaded plugins.' });
    var stopping = list.filter(function (d) { return d.level !== 'warn'; }).length;
    var said = stopping
      ? stopping + ' problem(s) a run would refuse to start on'
      : list.length + ' warning(s) — a run would still start';
    var box = el('div', {}, [el('h2', { class: 'section', text: said })]);
    list.forEach(function (d) { box.appendChild(problem(d)); });
    return box;
  }

  /* ---- the runs side ---- */

  function runsSidebar() {
    var side = el('aside');
    if (!data.runs.length) {
      side.appendChild(el('p', { class: 'empty', text: 'no recorded runs yet' }));
      return side;
    }
    side.appendChild(el('div', { class: 'group', text: data.runs.length + ' recorded run(s)' }));
    data.runs.forEach(function (run) {
      side.appendChild(el('button', {
        class: 'row', type: 'button',
        'aria-current': String(state.run === run.runId),
        on: function () { state.run = run.runId; data.run = null; draw(); load(); }
      }, [
        el('span', { class: 'dot ' + run.status }),
        el('span', { class: 'label', text: new Date(run.at).toLocaleString(), title: run.runId }),
        el('span', { class: 'sub', text: run.totals.tests + ' · ' + ms(run.durationMs) })
      ]));
    });
    return side;
  }

  function runDetail() {
    if (!state.run) {
      return el('main', {}, [el('p', { class: 'empty', text: 'Pick a run on the left.' })]);
    }
    if (!data.run) {
      return el('main', {}, [el('p', { class: 'empty', text: 'reading the run…' })]);
    }

    var run = data.run;
    var body = el('main');
    body.appendChild(el('h1', { class: 'title' }, [
      document.createTextNode(new Date(run.at).toLocaleString()),
      el('span', { class: 'id mono', text: run.runId })
    ]));
    body.appendChild(el('div', { class: 'totals' }, [
      el('span', {}, [el('b', { text: String(run.totals.tests) }), document.createTextNode(' tests')]),
      el('span', { class: 'passed' }, [el('b', { text: String(run.totals.passed) }), document.createTextNode(' passed')]),
      el('span', { class: 'failed' }, [el('b', { text: String(run.totals.failed) }), document.createTextNode(' failed')]),
      el('span', { class: 'error' }, [el('b', { text: String(run.totals.error) }), document.createTextNode(' error')]),
      el('span', { class: 'skipped' }, [el('b', { text: String(run.totals.skipped) }), document.createTextNode(' skipped')]),
      el('span', { class: 'ms', text: ms(run.durationMs) })
    ]));

    (run.notes || []).forEach(function (note) {
      body.appendChild(el('div', { class: 'note', text: note.level + ': ' + note.message }));
    });

    var byName = {};
    run.tests.forEach(function (t) { byName[t.name] = t; });

    run.suites.forEach(function (suite) {
      body.appendChild(el('h2', { class: 'section', text: suite.title || suite.name }));
      suite.tests.forEach(function (name) {
        var t = byName[name];
        if (t) body.appendChild(ranTest(t));
      });
    });
    return body;
  }

  function ranTest(t) {
    var head = el('summary', {}, [
      el('span', { class: 'dot ' + t.status }),
      el('span', { class: 'label' }, [
        document.createTextNode(t.title || t.name),
        t.failures.length ? el('div', { class: 'says', text: t.failures[0] }) : null,
        t.skipped ? el('div', { class: 'says', text: t.skipped }) : null
      ]),
      el('span', { class: 'ms', text: ms(t.durationMs) })
    ]);
    head.className = 'row';

    var body = el('div', { class: 'kids' });
    (t.steps || []).forEach(function (s) { body.appendChild(ranStep(s)); });
    (t.assertions || []).forEach(function (a) { ranAssertion(a).forEach(function (n) { body.appendChild(n); }); });
    if ((t.artifacts || []).length) {
      body.appendChild(el('div', { class: 'shots' }, t.artifacts.map(function (a) {
        var picture = /^image\\//.test(a.contentType);
        return el('div', { class: 'shot' }, [
          a.href ? el('a', { href: a.href, target: '_blank', rel: 'noreferrer' },
            picture ? [el('img', { src: a.href, alt: a.name, loading: 'lazy' })] : []) : null,
          el('div', { class: 'cap', text: a.name + ' — ' + bytes(a.bytes) + (a.href ? '' : ', not written to disk') })
        ]);
      })));
    }
    // Open when it is not green: a run is opened for its failures.
    var node = el('details', { class: 'card' }, [head, body]);
    if (t.status !== 'passed' && t.status !== 'skipped') node.open = true;
    // A test that ran is a test in the project, and jumping between the two is
    // the move somebody makes every single time they read a failure.
    var jump = el('p', { class: 'lead' }, [
      el('a', {
        href: '#', text: 'open this test in the project',
        on: function (e) { e.preventDefault(); state.view = 'project'; state.test = t.name; draw(); }
      })
    ]);
    body.appendChild(jump);
    return node;
  }

  function ranStep(s) {
    var head = owned('stepTypes', s.type, s.phase ? [el('span', { class: 'badge phase', text: s.phase })] : []);
    var kids = [el('div', { class: 'head' }, [
      el('span', { class: 'dot ' + s.status }),
      s.id ? el('span', { class: 'id', text: s.id }) : null
    ].concat(head.chips).concat([el('span', { class: 'spacer' }), el('span', { class: 'ms', text: ms(s.durationMs) })]))];
    if (s.message) kids.push(el('p', { class: 'says', text: s.message }));
    if (s.detail !== undefined) kids.push(fold('what it did', json(s.detail)));
    (s.assertions || []).forEach(function (a) { ranAssertion(a).forEach(function (n) { kids.push(n); }); });
    if ((s.steps || []).length) kids.push(el('div', { class: 'kids' }, s.steps.map(ranStep)));
    return el('div', { class: 'card' }, kids);
  }

  function ranAssertion(a) {
    var row = el('div', { class: 'assert ' + (a.passed ? 'yes' : 'no') }, [
      el('span', { class: 'glyph', text: a.passed ? '\\u2713' : '\\u2717' }),
      el('span', {}, [
        document.createTextNode(a.message),
        el('span', { class: 'badge', text: a.type })
      ])
    ]);
    if (a.passed || (a.expected === undefined && a.actual === undefined)) return [row];
    return [row, el('div', { class: 'diff' }, [
      el('div', {}, [el('h4', { text: 'expected' }), json(a.expected)]),
      el('div', {}, [el('h4', { text: 'actual' }), json(a.actual)])
    ])];
  }

  /* ---- the grammar, as a document ---- */

  function pluginsView() {
    var caps = data.project.capabilities;
    var body = el('main');
    body.appendChild(el('h1', { class: 'title', text: 'what this project can be written in' }));
    body.appendChild(el('p', { class: 'lead',
      text: caps.plugins.length + ' plugin(s) loaded, speaking contract version ' + caps.apiVersion +
        '. Every word below exists because one of them contributed it.' }));

    caps.plugins.forEach(function (plugin) {
      var card = el('div', { class: 'card' }, [
        el('div', { class: 'head' }, [
          el('span', { class: 'id', text: plugin.name }),
          plugin.version ? el('span', { class: 'badge', text: plugin.version }) : null,
          plugin.origin ? el('span', { class: 'badge owner', text: plugin.origin }) : null
        ]),
        plugin.docs && plugin.docs.summary ? el('p', { class: 'says', text: plugin.docs.summary }) : null
      ]);

      var table = el('table', { class: 'grammar' });
      var any = false;
      [['stepTypes', 'step'], ['assertions', 'assertion'], ['valueProviders', 'value'],
       ['reporters', 'reporter'], ['loaders', 'loader']].forEach(function (pair) {
        (caps[pair[0]] || []).forEach(function (entry) {
          if (entry.plugin !== plugin.name) return;
          any = true;
          var word = pair[0] === 'valueProviders' ? '\\u0024{' + entry.prefix + ':\\u2026}' : entry.name;
          var row = el('tr', {}, [
            el('td', { class: 'w' }, [
              el('span', { class: 'badge', text: pair[1] }),
              document.createTextNode(' ' + word)
            ]),
            el('td', {}, [
              document.createTextNode(entry.summary || ''),
              entry.schema ? fold('its input', json(entry.schema)) : null,
              entry.extensions ? el('div', { class: 'says', text: 'reads ' + entry.extensions.join(', ') }) : null
            ])
          ]);
          table.appendChild(row);
        });
      });
      if (any) card.appendChild(table);
      else card.appendChild(el('p', { class: 'says', text: 'contributes no words a suite writes — a surface, a hook or a service.' }));

      var examples = (plugin.docs && plugin.docs.examples) || [];
      examples.forEach(function (example) {
        card.appendChild(fold(example.title, el('div', {}, [
          example.summary ? el('p', { class: 'says', text: example.summary }) : null,
          el('pre', { text: example.code })
        ])));
      });
      body.appendChild(card);
    });
    return body;
  }

  /* ---- the frame ---- */

  function bar() {
    var tabs = el('nav', { class: 'tabs' });
    [['project', 'Project'], ['runs', 'Runs'], ['plugins', 'Plugins']].forEach(function (pair) {
      tabs.appendChild(el('button', {
        type: 'button', text: pair[1], 'aria-selected': String(state.view === pair[0]),
        on: function () { state.view = pair[0]; draw(); if (pair[0] === 'runs') load(); }
      }));
    });

    var theme = el('button', { class: 'ghost', type: 'button', text: 'theme' });
    theme.addEventListener('click', function () {
      var root = document.documentElement;
      var current = root.getAttribute('data-theme');
      if (!current) {
        current = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      root.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
    });

    var reload = el('button', { class: 'ghost', type: 'button', text: 'reload' });
    reload.addEventListener('click', function () { boot(); });

    var where = data.project
      ? data.project.root + (data.project.env ? '  ·  env: ' + data.project.env : '')
      : '';
    return el('header', { class: 'bar' }, [
      el('span', { class: 'brand', text: 'speq' }),
      el('span', { class: 'where mono', text: where }),
      el('span', { class: 'spacer' }),
      tabs, reload, theme
    ]);
  }

  function draw(options) {
    var app = document.getElementById('app');
    var focused = document.activeElement && document.activeElement.type === 'search';
    var caret = focused ? document.activeElement.selectionStart : null;

    app.className = '';
    app.textContent = '';
    if (data.error) {
      app.appendChild(el('p', { class: 'loading', text: String(data.error) }));
      return;
    }
    if (!data.project) {
      app.appendChild(el('p', { class: 'loading', text: 'reading the project\\u2026' }));
      return;
    }

    app.appendChild(bar());
    if (state.view === 'plugins') {
      app.appendChild(pluginsView());
    } else if (state.view === 'runs') {
      app.appendChild(el('div', { class: 'split' }, [runsSidebar(), runDetail()]));
    } else {
      app.appendChild(el('div', { class: 'split' }, [projectSidebar(), testDetail()]));
    }

    if (options && options.keepFocus) {
      var search = app.querySelector('input[type="search"]');
      if (search) { search.focus(); if (caret !== null) search.setSelectionRange(caret, caret); }
    }
  }

  /** The one run the page is looking at, fetched only when it is looking. */
  function load() {
    if (state.view !== 'runs' || !state.run || data.run) return;
    get('/api/runs/' + encodeURIComponent(state.run)).then(function (answer) {
      data.run = answer;
      draw();
    }).catch(function (error) { data.error = error; draw(); });
  }

  function boot() {
    data.error = null;
    Promise.all([get('/api/project'), get('/api/runs'), get('/api/history')])
      .then(function (answers) {
        data.project = answers[0];
        data.runs = answers[1];
        data.history = answers[2];
        // Newest first, so the dot beside a test name is the last thing that
        // happened to it rather than whatever the directory listing gave back.
        Object.keys(data.history.tests).forEach(function (name) {
          data.history.tests[name].sort(function (a, b) { return b.at - a.at; });
        });
        if (!state.run && data.runs.length) state.run = data.runs[0].runId;
        // Something on screen rather than an empty half-page: the first test is
        // as good a place to start reading as any, and a panel that opens on
        // nothing reads as a panel that failed to load.
        if (!state.test && data.project.tests.length) state.test = data.project.tests[0].name;
        draw();
        load();
      })
      .catch(function (error) { data.error = error; draw(); });
  }

  boot();
})();
`
