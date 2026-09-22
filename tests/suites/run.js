#!/usr/bin/env node
// Run every suite in this directory. Each runs in its own process so a crash
// in one cannot take the rest with it, and so global stubs never leak between
// suites — the scratchpad harnesses shared globals and that hid at least one
// ordering-dependent pass.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const only = process.argv.slice(2);
const suites = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.js') && f !== 'run.js')
  .filter(f => !only.length || only.some(o => f.indexOf(o) !== -1))
  .sort();

let total = 0, failedSuites = [];
suites.forEach(f => {
  let out = '';
  let failed = false;
  try {
    out = execFileSync(process.execPath, [path.join(DIR, f)],
      { cwd: path.resolve(DIR, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    failed = true;
  }
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  const passed = m ? Number(m[1]) : 0;
  const failures = m ? Number(m[2]) : 0;
  total += passed;
  if (failed || failures > 0 || !m) {
    failedSuites.push(f);
    console.log('❌ ' + f.padEnd(28) + (m ? m[0] : 'did not report — crashed'));
    console.log(out.split('\n').filter(l => l.indexOf('✗') !== -1 || /Error|error:/.test(l))
      .slice(0, 8).map(l => '     ' + l.trim()).join('\n'));
  } else {
    console.log('✅ ' + f.padEnd(28) + m[0]);
  }
});

console.log('\n' + total + ' assertions across ' + suites.length + ' suites');
if (failedSuites.length) {
  console.log('FAILED: ' + failedSuites.join(', '));
  process.exit(1);
}
console.log('all green');
