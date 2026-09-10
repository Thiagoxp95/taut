import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isEmptyOverride, overrideCount } from '../src/hooks/use-run-override.ts'

test('fast-only choices remain persistable overrides, including explicit standard speed', () => {
  for (const fastMode of [true, false]) {
    assert.equal(isEmptyOverride({ fastMode }), false)
    assert.equal(overrideCount({ fastMode }), 1)
  }
  assert.equal(isEmptyOverride({ fastMode: undefined }), true)
  assert.equal(overrideCount({ fastMode: undefined }), 0)
})
