import { definePlugin } from '@speqkit/plugin-api'
import { loadSuite, loadTests, SUITE_FILES } from './load.js'
import { registerMigrate } from './migrate.js'

/**
 * The authoring format is a plugin point, not a kernel concept. YAML ships as
 * the default because it is readable by people who do not program; a
 * TypeScript loader is an ordinary plugin someone can publish tomorrow without
 * touching the kernel.
 *
 * Owning the format is also what makes `speq migrate` this plugin's job. A
 * codemod is a reader and a writer of one syntax, and the plugin that decides
 * what `${...}` means is the only honest place to put the thing that rewrites
 * `{{...}}` into it.
 */
export default definePlugin({
  name: '@speqkit/plugin-yaml',
  docs: {
    summary: 'reads tests and suites out of YAML files — the authoring format, which is itself a plugin',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-yaml#readme',
    examples: [
      {
        title: 'a test file',
        summary: '`id` is the identity every event carries; `title` is the sentence a report shows.',
        for: ['yaml'],
        code: [
          'tests:',
          '  - id: payments.refund.partial',
          '    title: a partial refund leaves the rest of the order payable',
          '    tags: [PAY-114, smoke]',
          '    variables:',
          '      orderId: ${gen:uuid}',
          '    steps:',
          '      - id: refund',
          '        type: http',
          '        method: POST',
          '        url: ${base}/orders/${orderId}/refunds',
          '        json: { amount: 400 }',
          '        assert:',
          '          - type: status',
          '            expected: 201'
        ].join('\n')
      },
      {
        title: 'a suite file, describing the directory it sits in',
        summary:
          'Named `suite.yaml`. Its setup runs once before the first test below it, ' +
          'and its tags are inherited by every one of them.',
        for: ['yaml'],
        code: [
          '# suites/payments/suite.yaml',
          'title: payments',
          'tags: [payments]',
          'setup:',
          '  - id: tenant',
          '    type: use',
          '    ref: register-tenant'
        ].join('\n')
      },
      {
        title: 'one test, run once per row',
        summary: 'A case is an ordinary test everywhere it counts: it validates, reports and re-runs as one.',
        for: ['yaml'],
        code: [
          'tests:',
          '  - id: checkout.currency',
          '    cases:',
          '      - id: eur',
          '        currency: EUR',
          '      - id: gbp',
          '        currency: GBP',
          '    steps:',
          '      - type: http',
          '        method: GET',
          '        url: ${base}/prices?currency=${currency}'
        ].join('\n')
      }
    ]
  },
  setup(ctx) {
    ctx.defineLoader('yaml', {
      summary: 'a test is a .yaml file under suites/; a suite is a suite.yaml beside them',
      extensions: ['.yaml', '.yml'],
      load: loadTests,
      suiteFiles: SUITE_FILES,
      loadSuite
    })

    registerMigrate(ctx)
  }
})
