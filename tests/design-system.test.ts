import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync('client/src/index.css', 'utf8');
function luminance(hex: string) {
  const channels = hex.replace('#', '').match(/.{2}/g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0] + .05) / (values[1] + .05);
}
const token = (name: string) => css.match(new RegExp(`--${name}: (#[a-f0-9]{6});`))![1];
for (const background of ['background', 'card', 'muted', 'sidebar']) {
  for (const foreground of ['foreground', 'muted-foreground']) assert.ok(contrast(token(background), token(foreground)) >= 4.5, `${foreground} on ${background} must meet normal-text contrast`);
}
assert.ok(contrast('#071321', token('primary')) >= 4.5);
assert.ok(contrast(token('primary'), token('card')) >= 3);
assert.ok(css.includes('prefers-reduced-motion: reduce'));
assert.ok(css.includes(':focus-visible'));
assert.ok(!css.includes('fonts.googleapis.com'));
const source = fs.readFileSync('client/src/components/ui.tsx', 'utf8');
assert.ok(source.includes('showModal()'));
assert.ok(source.includes('aria-labelledby={titleId}'));
assert.ok(source.includes('previous?.focus()'));
assert.ok(source.includes('role="alert"'));
assert.ok(source.includes('role="status"'));
const gaps = fs.readFileSync('client/src/pages/dashboard/Gaps.tsx', 'utf8');
assert.ok(gaps.includes('htmlFor="gap-status"'));
assert.ok(gaps.includes('<select id="gap-status"'));
assert.ok(!fs.readFileSync('client/src/pages/dashboard/Queue.tsx', 'utf8').includes('~3.2m'));
assert.ok(!fs.readFileSync('client/src/pages/dashboard/Deployments.tsx', 'utf8').includes('/ 10650'));
console.log('PASS core design-token contrast, reduced motion, focus rules and native dialog/status semantics; not a full WCAG certification.');
