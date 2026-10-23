import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindSwipes } from '../public/swipe.mjs';

function setup() {
  const element = new EventTarget();
  const steps = [];
  let enabled = true;
  bindSwipes(element, () => enabled, step => steps.push(step));
  return {
    steps,
    enable(value) { enabled = value; },
    emit(type, values = {}) {
      const event = new Event(type);
      for (const [key, value] of Object.entries({
        pointerType: 'touch', pointerId: 1, isPrimary: true,
        clientX: 300, clientY: 300, timeStamp: 0, ...values
      })) Object.defineProperty(event, key, { value });
      element.dispatchEvent(event);
    }
  };
}

test('left swipe selects next pair once; right swipe selects previous', () => {
  const swipe = setup();
  swipe.emit('pointerdown');
  swipe.emit('pointerup', { clientX: 220, timeStamp: 1500 });
  swipe.emit('pointerup', { clientX: 100, timeStamp: 1500 });
  assert.deepEqual(swipe.steps, [1]);
  swipe.emit('pointerdown');
  swipe.emit('pointerup', { clientX: 380, timeStamp: 200 });
  assert.deepEqual(swipe.steps, [1, -1]);
});

for (const [name, end] of [
  ['tap', { clientX: 300 }],
  ['short swipe', { clientX: 221 }],
  ['vertical swipe', { clientX: 310, clientY: 100 }],
  ['diagonal swipe', { clientX: 100, clientY: 190 }],
  ['long hold', { clientX: 100, timeStamp: 1501 }]
]) {
  test(`${name} does not navigate`, () => {
    const swipe = setup();
    swipe.emit('pointerdown');
    swipe.emit('pointerup', end);
    assert.deepEqual(swipe.steps, []);
  });
}

for (const pointerType of ['mouse', 'pen']) {
  test(`${pointerType} drag does not navigate`, () => {
    const swipe = setup();
    swipe.emit('pointerdown', { pointerType });
    swipe.emit('pointerup', { pointerType, clientX: 100 });
    assert.deepEqual(swipe.steps, []);
  });
}

for (const type of ['pointercancel', 'lostpointercapture']) {
  test(`${type} cancels navigation and allows the next gesture`, () => {
    const swipe = setup();
    swipe.emit('pointerdown');
    swipe.emit(type);
    swipe.emit('pointerup', { clientX: 100 });
    assert.deepEqual(swipe.steps, []);
    swipe.emit('pointerdown');
    swipe.emit('pointerup', { clientX: 100 });
    assert.deepEqual(swipe.steps, [1]);
  });
}

test('a second finger cancels navigation even when fingers end in different orders', () => {
  for (const primaryFirst of [true, false]) {
    const swipe = setup();
    swipe.emit('pointerdown');
    swipe.emit('pointerdown', { pointerId: 2, isPrimary: false });
    const primary = { clientX: 100 };
    const secondary = { pointerId: 2, isPrimary: false };
    swipe.emit('pointerup', primaryFirst ? primary : secondary);
    swipe.emit('pointerup', primaryFirst ? secondary : primary);
    assert.deepEqual(swipe.steps, []);
    swipe.emit('pointerdown');
    swipe.emit('pointerup', { clientX: 100 });
    assert.deepEqual(swipe.steps, [1]);
  }
});

test('zoom, loading and control guards are checked at both gesture endpoints', () => {
  const swipe = setup();
  swipe.enable(false);
  swipe.emit('pointerdown');
  swipe.enable(true);
  swipe.emit('pointerup', { clientX: 100 });
  assert.deepEqual(swipe.steps, []);
  swipe.emit('pointerdown');
  swipe.enable(false);
  swipe.emit('pointerup', { clientX: 100 });
  assert.deepEqual(swipe.steps, []);
});
