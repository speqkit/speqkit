import { afterEach, describe, expect, it } from 'vitest'
// esModuleInterop is off here, and ajv publishes a CJS default export.
import { Ajv } from 'ajv'
import { harness, type Harness } from '@speqkit/test-kit'
import cli from '@speqkit/plugin-cli'
import yaml from '@speqkit/plugin-yaml'
import http from '@speqkit/plugin-http'
import assertions from '@speqkit/plugin-assert'
import loop from '@speqkit/plugin-loop'
import data from '@speqkit/plugin-data'
import { editorSchema } from '../src/schema.js'

/**
 * The schema is generated, so the only way to know it says what it means is to
 * hand it to something that is not us and give it real files. Written after
 * exactly that found the mistake worth finding: with an open `suite` branch
 * beside the `test` branch, *every* file was a valid suite — including a test
 * file with a misspelled key, which is the one thing this exists to catch.
 */
let kit: Harness
afterEach(async () => { await kit.close() })

async function judge() {
  kit = await harness(cli, { with: [yaml, http, assertions, loop, data] })
  const ajv = new Ajv({ strict: false, allErrors: true })
  return ajv.compile(editorSchema(kit.host.capabilities()))
}

describe('the schema an editor is given', () => {
  it('is a schema — compiled by a validator that has never heard of speq', async () => {
    expect(await judge()).toBeTypeOf('function')
  })

  it('accepts a test written the way the documentation writes one', async () => {
    const valid = await judge()
    expect(valid({
      id: 'orders.create',
      title: 'POST /orders creates an order',
      tags: ['smoke'],
      timeout: '30s',
      variables: { slug: '${gen:uuid}' },
      setup: [{ id: 'reset', type: 'http', method: 'POST', url: '/reset' }],
      steps: [
        {
          id: 'created',
          type: 'http',
          method: 'POST',
          url: '/orders',
          body: { sku: 'a1' },
          assert: [{ type: 'status', expected: 201 }]
        },
        { type: 'wait', ms: 200, when: '${created.body.draft}' },
        { id: 'order', type: 'set', value: '${created.body.id}' }
      ],
      assert: [{ type: 'equals', path: 'created.body.sku', expected: 'a1' }],
      cleanup: [{ type: 'http', method: 'DELETE', url: '/orders/${order.value}' }],
      owner: 'mira'
    })).toBe(true)
  })

  it('lets a typed field be written as a whole template, because it may be', async () => {
    const valid = await judge()
    // `expected` is an integer and `"${want}"` is a string in the file and an
    // integer by the time the assertion sees it. An editor that underlined
    // this would be underlining the correct way to write it.
    expect(valid({
      steps: [{ type: 'http', url: '/o', assert: [{ type: 'status', expected: '${want}' }] }]
    })).toBe(true)
  })

  it('catches the misspelled key, which is the whole point of it', async () => {
    const valid = await judge()
    expect(valid({ steps: [{ type: 'http', url: '/o', bodyRaw: 'x' }] })).toBe(false)
  })

  it('accepts a suite manifest, which is a different file with the same extension', async () => {
    const valid = await judge()
    expect(valid({
      title: 'orders',
      tags: ['orders'],
      setup: [{ type: 'http', method: 'POST', url: '/reset' }]
    })).toBe(true)
  })

  it('does not let the manifest shape excuse a broken test', async () => {
    const valid = await judge()
    // The discriminator: a manifest declares no body. Without it the open
    // annotation space on a suite made every file valid.
    expect(valid({ steps: [] , title: 'x', nonsense: { a: 1 } })).toBe(true)
    expect(valid({ steps: [{ type: 'http', url: '/o', bodyRaw: 'x' }], title: 'x' })).toBe(false)
  })
})
