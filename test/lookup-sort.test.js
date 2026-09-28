import assert from 'node:assert/strict';
import test from 'node:test';
import { groupDispatchItems, matchesDispatchSearch, sortLookupItems } from '../public/printward-lookup-sort.js';

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

test('dispatch search matches delivery-method code and registration name', () => {
  const route = item('1987001', 301, 7, 'RJA 13M');
  route.order.context.customerName = 'Restaurang Sol';
  assert.equal(matchesDispatchSearch(route, '301'), true);
  assert.equal(matchesDispatchSearch(route, 'rja 13m'), true);
  assert.equal(matchesDispatchSearch(route, 'restaurang'), true);
  assert.equal(matchesDispatchSearch(route, '1987001'), true);
  assert.equal(matchesDispatchSearch(route, '302'), false);
});

test('dispatch bundles group by order delivery method without changing item order', () => {
  const first = { ...item('101', 301, 6, 'RJA 13M'), ready: true };
  const second = { ...item('102', 302, 7, 'UDG 62J'), ready: false };
  const third = { ...item('103', 301, 8, 'RJA 13M'), ready: false };
  const original = [first, second, third];
  const groups = groupDispatchItems(original);
  assert.deepEqual(groups.map(({ key, label, ready, items }) => ({
    key, label, ready, orders: items.map(({ order }) => order.orderNumber)
  })), [
    { key: 'code:301', label: 'Körsätt 301 · RJA 13M', ready: 1, orders: ['101', '103'] },
    { key: 'code:302', label: 'Körsätt 302 · UDG 62J', ready: 0, orders: ['102'] }
  ]);
  assert.deepEqual(original.map(({ order }) => order.orderNumber), ['101', '102', '103']);
});
