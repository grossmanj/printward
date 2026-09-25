import assert from 'node:assert/strict';
import test from 'node:test';
import { sortLookupItems } from '../public/printward-lookup-sort.js';

function item(orderNumber, deliveryMethod, dispatchPriority, deliveryMethodName = '') {
  return { order: { orderNumber, context: { deliveryMethod, dispatchPriority, deliveryMethodName } } };
}

test('lookup sort groups by Visma delivery method and then by order priority', () => {
  const original = [
    item('102', 302, 6, 'UDG 62J'),
    item('103', 25, 16, 'Eriksson'),
    item('101', 302, 5, 'UDG 62J'),
    item('104', 25, 7, 'Eriksson')
  ];
  assert.deepEqual(sortLookupItems(original, 'method').map(({ order }) => order.orderNumber),
    ['104', '103', '101', '102']);
  assert.deepEqual(original.map(({ order }) => order.orderNumber), ['102', '103', '101', '104']);
  assert.equal(sortLookupItems(original, 'priority'), original);
});

test('lookup sort leaves unknown delivery methods last', () => {
  const original = [item('3', null, 5), item('2', 47, 13), item('1', 19, 7)];
  assert.deepEqual(sortLookupItems(original, 'method').map(({ order }) => order.orderNumber), ['1', '2', '3']);
});
