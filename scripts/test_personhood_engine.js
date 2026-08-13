const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const context = { window: {}, console };
vm.createContext(context);
['schema.js', 'evidence.js', 'engine.js', 'fixtures.js'].forEach((file) => {
  vm.runInContext(fs.readFileSync(path.join(root, 'docs', 'personhood', file), 'utf8'), context, { filename: file });
});
const P = context.window.PaliPersonhood;
assert.strictEqual(P.FIXTURES.length, 36);
for (const fixture of P.FIXTURES) {
  const request = { modelVersion: P.MODEL_VERSIONS.CANONICAL, scenario: fixture, agents: fixture.agents, interventions: fixture.interventions, seed: fixture.seed };
  const first = P.runEpisode(request);
  const second = P.runEpisode(request);
  assert.deepStrictEqual(first, second, fixture.id);
  assert.strictEqual(first.validation.ok, true, fixture.id);
  assert.strictEqual(first.streams.length, 1, fixture.id);
  const expected = fixture.context.expected_branch;
  assert.strictEqual(first.streams[0].branch, expected, fixture.id);
  for (const event of first.streams[0].events) {
    assert.ok(event.evidence_ids.length, event.id);
    if (event.kind === 'contact') assert.ok(event.conditions.door && event.conditions.object_id && event.conditions.consciousness, event.id);
  }
}
const synthesis = P.runEpisode({ modelVersion: P.MODEL_VERSIONS.SYNTHESIS, scenario: P.FIXTURES[0], agents: P.FIXTURES[0].agents, interventions: P.FIXTURES[0].interventions, seed: P.FIXTURES[0].seed });
assert.ok(synthesis.streams[0].events.some((event) => event.phase === 'interpretive' && event.interpretation_status === 'later-systematisation'));
console.log(`personhood JS fixtures: ${P.FIXTURES.length} passed`);
